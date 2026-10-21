import type { AutomationConfig, Env, ExtractionResult, IncomingMessage, OrderRequest, SignalStatus, TradeSignal } from '../types';
import { extractSignal } from './clairic';
import { BrokerClient } from './broker';
import { getConfig } from './settings';

const roundLot = (n: number) => Math.max(0.01, Math.round(n * 100) / 100);
const floorLot = (n: number) => Math.max(0.01, Math.floor(n * 100 + 1e-9) / 100);
// Messages older than this (e.g. redelivered after a bridge reconnect) are never traded.
const MAX_SIGNAL_AGE_MS = 5 * 60 * 1000;

/** Offset (ms) of `zone` from UTC at instant `at`. */
function zoneOffsetMs(zone: string, at: number): number {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: zone, hourCycle: 'h23', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit',
  }).formatToParts(new Date(at));
  const g = (t: string) => parseInt(parts.find((p) => p.type === t)!.value, 10);
  return Date.UTC(g('year'), g('month') - 1, g('day'), g('hour'), g('minute'), g('second')) - Math.floor(at / 1000) * 1000;
}

/** Resolve today's entry window (in `zone`) to unix ms; a window with end < start crosses midnight. */
export function resolveWindow(w: { start: string; end: string }, zone: string, now: number): { start: number; end: number } {
  const off = zoneOffsetMs(zone, now);
  const local = new Date(now + off); // UTC fields = wall clock in zone
  const day0 = Date.UTC(local.getUTCFullYear(), local.getUTCMonth(), local.getUTCDate());
  const mins = (t: string) => { const [h, m] = t.split(':').map(Number); return (h * 60 + m) * 60000; };
  let start = day0 + mins(w.start);
  let end = day0 + mins(w.end);
  if (end <= start) {
    // crosses midnight: if we're in the early part (before end) the window started yesterday
    if (now + off < end) start -= 86400000;
    else end += 86400000;
  }
  return { start: start - off, end: end - off };
}

/** Config-aware step after extraction: fall back to cfg.defaultSymbol when the message names none. */
export function applyDefaultSymbol(ex: ExtractionResult, cfg: AutomationConfig): ExtractionResult {
  if (ex.rawSymbol || !ex.side || !cfg.defaultSymbol) return ex;
  const c = ex.fields.action?.confidence;
  return { ...ex, rawSymbol: cfg.defaultSymbol.trim().toUpperCase(), symbolFromDefault: true, isSignal: true, confidence: typeof c === 'number' ? c : 0 };
}

const decimalsOf = (n: number) => (String(n).split('.')[1] ?? '').length;

export function buildTradeSignal(ex: ExtractionResult, cfg: AutomationConfig, now = Date.now()): { signal: TradeSignal | null; errors: string[]; notes?: string[] } {
  const errors: string[] = [];
  const notes: string[] = [];
  ex = applyDefaultSymbol(ex, cfg);
  if (!ex.isSignal || !ex.side || !ex.rawSymbol) {
    return { signal: null, errors: [ex.side ? 'not a trade signal: no symbol in message (set a default symbol in settings)' : 'not a trade signal'] };
  }
  if (ex.confidence < cfg.minConfidence) errors.push(`confidence ${ex.confidence.toFixed(2)} below minimum ${cfg.minConfidence}`);

  const mapped = cfg.symbolMap[ex.rawSymbol] ?? cfg.symbolMap[ex.rawSymbol.toUpperCase()] ?? ex.rawSymbol;
  if (cfg.allowedSymbols.length && !cfg.allowedSymbols.map((s) => s.toUpperCase()).includes(mapped.toUpperCase())) {
    errors.push(`symbol ${mapped} not allowed`);
  }
  const symbol = mapped + cfg.symbolSuffix;

  const { side, orderKind, entry } = ex;
  let { stopLoss, takeProfits } = ex;
  const pipSize = cfg.pipSizes[mapped.toUpperCase()] ?? (mapped.toUpperCase().includes('JPY') ? 0.01 : 0.0001);
  const needSlPips = stopLoss == null && ex.stopLossPips != null;
  const needTpPips = takeProfits.length === 0 && ex.takeProfitPips.length > 0;
  if ((needSlPips || needTpPips) && entry == null) {
    errors.push('SL/TP given in pips needs an entry price');
  } else if (entry != null) {
    const dec = decimalsOf(entry);
    const r = (n: number) => Number(n.toFixed(dec || 5));
    const dirp = side === 'BUY' ? 1 : -1;
    if (needSlPips) stopLoss = r(entry - dirp * ex.stopLossPips! * pipSize);
    if (needTpPips) takeProfits = ex.takeProfitPips.map((p) => r(entry + dirp * p * pipSize));
  }
  let expiresAt: number | undefined;
  if (ex.entryWindow) {
    let w: { start: number; end: number } | null = null;
    try { w = resolveWindow(ex.entryWindow, cfg.timezone, now); } catch { errors.push(`invalid timezone ${cfg.timezone}`); }
    if (w) {
      const label = `${ex.entryWindow.start}–${ex.entryWindow.end}`;
      if (now > w.end) errors.push(`entry window ${label} has passed`);
      else if (orderKind === 'MARKET' && now < w.start) errors.push(`entry window ${label} has not started`);
      else {
        if (now < w.start) notes.push(`entry window ${label} not started yet; pending order placed`);
        if (orderKind !== 'MARKET') expiresAt = w.end;
      }
    }
  }
  if (cfg.requireStopLoss && stopLoss == null) errors.push('stop loss required');
  if (orderKind !== 'MARKET' && entry == null) errors.push(`${orderKind} order requires an entry price`);

  const dir = side === 'BUY' ? 1 : -1;
  if (entry != null) {
    if (stopLoss != null && (stopLoss - entry) * dir >= 0) errors.push(`stop loss ${stopLoss} on wrong side of entry ${entry} for ${side}`);
    for (const tp of takeProfits) if ((tp - entry) * dir <= 0) errors.push(`take profit ${tp} on wrong side of entry ${entry} for ${side}`);
  }
  // Holds without an entry price too (market orders): every TP must be on the profit side of the SL.
  if (stopLoss != null) {
    for (const tp of takeProfits) if ((tp - stopLoss) * dir <= 0) errors.push(`take profit ${tp} on wrong side of stop loss ${stopLoss} for ${side}`);
  }
  // A price the model read that isn't written in the message means the extraction can't be trusted.
  const dropped = ex.fields._dropped?.value;
  if (Array.isArray(dropped) && dropped.length) errors.push(`extraction misread price(s) ${dropped.join(', ')} not found in message`);
  if (errors.length) return { signal: null, errors, notes };

  let lot = cfg.lotMode === 'signal' ? (ex.volume ?? cfg.fixedLot) : cfg.fixedLot;
  lot = roundLot(Math.min(lot, cfg.maxLot));

  const tps = takeProfits.length === 0 ? [undefined] : cfg.tpStrategy === 'first' ? [takeProfits[0]] : cfg.tpStrategy === 'last' ? [takeProfits[takeProfits.length - 1]] : takeProfits;
  const perLot = tps.length > 1 ? floorLot(lot / tps.length) : lot;

  const prefix = cfg.commentPrefix.slice(0, 60);
  const orders: OrderRequest[] = tps.map((tp, i) => ({
    symbol,
    trade_type: orderKind === 'MARKET' ? side : `${side}_${orderKind}`,
    volume: perLot,
    ...(orderKind !== 'MARKET' && entry != null ? { price: entry } : {}),
    ...(stopLoss != null ? { stop_loss: stopLoss } : {}),
    ...(tp != null ? { take_profit: tp } : {}),
    ...(expiresAt != null ? { expires_at: expiresAt } : {}),
    comment: `${prefix} #${i + 1}`.slice(0, 100),
  }));

  return { signal: { symbol, rawSymbol: ex.rawSymbol, side, orderKind, entry, stopLoss, takeProfits, orders, confidence: ex.confidence }, errors: [], notes };
}

function extractTicket(res: unknown): string | null {
  if (!res || typeof res !== 'object') return null;
  const o = res as Record<string, unknown>;
  for (const k of ['positionId', 'orderId']) {
    if (o[k] != null && typeof o[k] !== 'object') return String(o[k]);
  }
  return null;
}

async function executeOrders(
  env: Env,
  accountId: string,
  signalId: number | null,
  orders: OrderRequest[],
): Promise<{ ok: number; results: unknown[]; firstError: string | null }> {
  const results: unknown[] = [];
  let ok = 0;
  let firstError: string | null = null;
  let client: BrokerClient | null = null;
  for (const req of orders) {
    let response: unknown;
    let success = false;
    try {
      client ??= await BrokerClient.forAccount(env, accountId);
      response = await client.openTrade(req);
      success = true;
      ok++;
    } catch (e) {
      const err = e as { message?: string; body?: unknown };
      response = { error: err.message ?? String(e), body: err.body };
      firstError ??= err.message ?? String(e);
    }
    results.push({ ok: success, request: req, response });
    try {
      await env.DB.prepare(
        `INSERT INTO trades (account_id, signal_id, action, request, response, ok, ticket, created_at) VALUES (?, ?, 'open', ?, ?, ?, ?, ?)`,
      )
        .bind(accountId, signalId, JSON.stringify(req), JSON.stringify(response ?? null), success ? 1 : 0, success ? extractTicket(response) : null, Date.now())
        .run();
    } catch (e) {
      console.error('failed to record trade', e);
    }
  }
  return { ok, results, firstError };
}

export async function processIncomingMessage(env: Env, accountId: string, msg: IncomingMessage): Promise<SignalStatus> {
  let signalId: number | null = null;
  let status: SignalStatus = 'failed';
  let reason: string | null = null;
  let extraction: ExtractionResult | null = null;
  let signal: TradeSignal | null = null;
  try {
    const ins = await env.DB.prepare(
      `INSERT OR IGNORE INTO signals (account_id, wa_message_id, chat_id, sender, text, received_at, status, source) VALUES (?, ?, ?, ?, ?, ?, 'received', ?)`,
    )
      .bind(accountId, msg.messageId, msg.chatId, msg.sender, msg.text, msg.timestamp, msg.source === 'telegram' ? 'telegram' : 'whatsapp')
      .run();
    if (!ins.meta.changes) return 'ignored';
    signalId = ins.meta.last_row_id;

    try {
      const cfg = await getConfig(env, accountId);
      try {
        extraction = applyDefaultSymbol(await extractSignal(env, msg.text), cfg);
      } catch (e) {
        status = 'failed';
        reason = `extraction failed: ${(e as Error).message}`;
        throw e;
      }
      if (!extraction.isSignal) {
        status = 'ignored';
        reason = 'not a trade signal';
      } else {
        const built = buildTradeSignal(extraction, cfg, Date.now());
        signal = built.signal;
        if (!cfg.enabled) {
          status = 'ignored';
          reason = 'automation disabled';
        } else if (Date.now() - msg.timestamp > MAX_SIGNAL_AGE_MS) {
          status = 'ignored';
          reason = 'stale message (older than 5 minutes)';
        } else if (!signal) {
          status = 'rejected';
          reason = built.errors.join('; ');
        } else {
          let blocked = false;
          if (cfg.maxOpenPositions > 0 && !cfg.dryRun) {
            const open = (await (await BrokerClient.forAccount(env, accountId)).positions()).length;
            if (open >= cfg.maxOpenPositions) {
              status = 'rejected';
              reason = `max open positions reached (${open}/${cfg.maxOpenPositions})`;
              blocked = true;
            }
          }
          if (!blocked) {
            if (built.notes?.length) reason = built.notes.join('; ');
            if (cfg.dryRun) {
              status = 'dry_run';
            } else {
              const r = await executeOrders(env, accountId, signalId, signal.orders);
              status = r.ok === signal.orders.length ? 'executed' : r.ok > 0 ? 'partial' : 'failed';
              if (status !== 'executed') reason = r.firstError;
            }
          }
        }
      }
    } catch (e) {
      console.error('processIncomingMessage error', e);
      if (status === 'failed' && !reason) reason = (e as Error).message;
    }
  } catch (e) {
    console.error('processIncomingMessage fatal', e);
    return 'failed';
  }
  try {
    await env.DB.prepare('UPDATE signals SET extraction = ?, signal = ?, status = ?, reason = ? WHERE id = ?')
      .bind(extraction ? JSON.stringify(extraction) : null, signal ? JSON.stringify(signal) : null, status, reason, signalId)
      .run();
  } catch (e) {
    console.error('failed to update signal', e);
  }
  return status;
}

export async function runExtractPlayground(
  env: Env,
  accountId: string,
  text: string,
  execute: boolean,
): Promise<{ extraction: ExtractionResult; signal: TradeSignal | null; errors: string[]; results?: unknown[] }> {
  const cfg = await getConfig(env, accountId);
  const extraction = applyDefaultSymbol(await extractSignal(env, text), cfg);
  const { signal, errors } = buildTradeSignal(extraction, cfg);
  if (!execute || !signal) return { extraction, signal, errors };
  const { results } = await executeOrders(env, accountId, null, signal.orders);
  return { extraction, signal, errors, results };
}
