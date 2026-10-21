import type { AutomationConfig, Env, ExtractionResult, IncomingMessage, OrderRequest, SignalStatus, TradeSignal } from '../types';
import { extractSignal } from './clairic';
import { BrokerClient } from './broker';
import { getConfig } from './settings';

const roundLot = (n: number) => Math.max(0.01, Math.round(n * 100) / 100);
const floorLot = (n: number) => Math.max(0.01, Math.floor(n * 100 + 1e-9) / 100);
// Messages older than this (e.g. redelivered after a bridge reconnect) are never traded.
const MAX_SIGNAL_AGE_MS = 5 * 60 * 1000;

export function buildTradeSignal(ex: ExtractionResult, cfg: AutomationConfig): { signal: TradeSignal | null; errors: string[] } {
  const errors: string[] = [];
  if (!ex.isSignal || !ex.side || !ex.rawSymbol) return { signal: null, errors: ['not a trade signal'] };
  if (ex.confidence < cfg.minConfidence) errors.push(`confidence ${ex.confidence.toFixed(2)} below minimum ${cfg.minConfidence}`);

  const mapped = cfg.symbolMap[ex.rawSymbol] ?? cfg.symbolMap[ex.rawSymbol.toUpperCase()] ?? ex.rawSymbol;
  if (cfg.allowedSymbols.length && !cfg.allowedSymbols.map((s) => s.toUpperCase()).includes(mapped.toUpperCase())) {
    errors.push(`symbol ${mapped} not allowed`);
  }
  const symbol = mapped + cfg.symbolSuffix;

  const { side, orderKind, entry, stopLoss, takeProfits } = ex;
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
  if (errors.length) return { signal: null, errors };

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
    comment: `${prefix} #${i + 1}`.slice(0, 100),
  }));

  return { signal: { symbol, rawSymbol: ex.rawSymbol, side, orderKind, entry, stopLoss, takeProfits, orders, confidence: ex.confidence }, errors: [] };
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
        extraction = await extractSignal(env, msg.text);
      } catch (e) {
        status = 'failed';
        reason = `extraction failed: ${(e as Error).message}`;
        throw e;
      }
      if (!extraction.isSignal) {
        status = 'ignored';
        reason = 'not a trade signal';
      } else {
        const built = buildTradeSignal(extraction, cfg);
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
  const extraction = await extractSignal(env, text);
  const { signal, errors } = buildTradeSignal(extraction, cfg);
  if (!execute || !signal) return { extraction, signal, errors };
  const { results } = await executeOrders(env, accountId, null, signal.orders);
  return { extraction, signal, errors, results };
}
