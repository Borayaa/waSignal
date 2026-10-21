import type { AccountInfo, Deal, Env, OrderRequest, PendingOrder, Position, TradeResult, TradeSide } from '../types';
import { BrokerError, validAccessToken } from './ctauth';
import { CtraderError, CtraderSession, EXEC_TYPE, ORDER_TYPE, PT, TRADE_SIDE, isEnum, withSession, type Msg, type SessionTarget } from './ctrader';

export { BrokerError } from './ctauth';

const SYMBOL_TTL_MS = 24 * 60 * 60 * 1000;
const PRICE_SCALE = 100_000; // spot prices and relative SL/TP are in 1/100000 of a price unit
const LABEL = 'waSignal';
const TIF_GOOD_TILL_DATE = 1; // ProtoOATimeInForce.GOOD_TILL_DATE
const MIN_EXPIRY_AHEAD_MS = 60_000;

interface SymbolInfo {
  symbolId: number;
  name: string;
  digits: number;
  lotSize: number; // protocol volume units (0.01 of a unit) per 1.00 lot
  minVolume: number;
  stepVolume: number;
  maxVolume: number;
}

const sideOf = (v: unknown): TradeSide => (isEnum(v, TRADE_SIDE.BUY, 'BUY') ? 'BUY' : 'SELL');
const norm = (s: string) => s.toUpperCase().replace(/[^A-Z0-9]/g, '');
const num = (v: unknown): number | null => (typeof v === 'number' && Number.isFinite(v) ? v : null);
const orderTypeName = (v: unknown): string => (isEnum(v, ORDER_TYPE.LIMIT, 'LIMIT') ? 'LIMIT' : isEnum(v, ORDER_TYPE.STOP, 'STOP') ? 'STOP' : String(v));

export class BrokerClient {
  private constructor(
    private env: Env,
    private target: SessionTarget,
  ) {}

  /** Throws BrokerError('cTrader account not connected', 400) when not linked / no account selected. */
  static async forAccount(env: Env, accountId: string): Promise<BrokerClient> {
    const { accessToken, row } = await validAccessToken(env, accountId);
    if (row.selected_ctid == null) throw new BrokerError('cTrader account not connected', 400);
    return new BrokerClient(env, { accessToken, ctidTraderAccountId: row.selected_ctid, isLive: !!row.selected_is_live });
  }

  private get ctid() {
    return this.target.ctidTraderAccountId;
  }

  private run<T>(fn: (s: CtraderSession) => Promise<T>): Promise<T> {
    return withSession(this.env, this.target, fn);
  }

  // ---------- symbol cache (D1 ctrader_symbols, 24 h) ----------

  private async cacheGet(keys: string[]): Promise<Map<string, unknown>> {
    const out = new Map<string, unknown>();
    if (!keys.length) return out;
    const { results } = await this.env.DB.prepare(
      `SELECT name, details FROM ctrader_symbols WHERE ctid = ? AND updated_at > ? AND name IN (${keys.map(() => '?').join(',')})`,
    )
      .bind(this.ctid, Date.now() - SYMBOL_TTL_MS, ...keys)
      .all<{ name: string; details: string }>();
    for (const r of results) out.set(r.name, JSON.parse(r.details));
    return out;
  }

  private async cachePut(rows: { name: string; symbolId: number | null; details: unknown }[]): Promise<void> {
    if (!rows.length) return;
    const st = this.env.DB.prepare(
      `INSERT INTO ctrader_symbols (ctid, name, symbol_id, details, updated_at) VALUES (?1, ?2, ?3, ?4, ?5)
       ON CONFLICT(ctid, name) DO UPDATE SET symbol_id = ?3, details = ?4, updated_at = ?5`,
    );
    const now = Date.now();
    for (let i = 0; i < rows.length; i += 50) {
      await this.env.DB.batch(rows.slice(i, i + 50).map((r) => st.bind(this.ctid, r.name, r.symbolId, JSON.stringify(r.details), now)));
    }
  }

  private async symbolList(s: CtraderSession): Promise<{ symbolId: number; symbolName: string }[]> {
    const r = await s.request(PT.SYMBOLS_LIST_REQ, { ctidTraderAccountId: this.ctid });
    return ((r.payload?.symbol ?? []) as { symbolId: number; symbolName?: string }[]).map((x) => ({ symbolId: Number(x.symbolId), symbolName: x.symbolName ?? '' }));
  }

  /** Full symbol details by id (cached). */
  private async symbolsById(s: CtraderSession, ids: number[]): Promise<Map<number, SymbolInfo>> {
    const uniq = [...new Set(ids)];
    const out = new Map<number, SymbolInfo>();
    const cached = await this.cacheGet(uniq.map((i) => `#${i}`));
    const missing: number[] = [];
    for (const id of uniq) {
      const c = cached.get(`#${id}`) as SymbolInfo | undefined;
      if (c) out.set(id, c);
      else missing.push(id);
    }
    if (!missing.length) return out;
    const names = new Map((await this.symbolList(s)).map((x) => [x.symbolId, x.symbolName]));
    const r = await s.request(PT.SYMBOL_BY_ID_REQ, { ctidTraderAccountId: this.ctid, symbolId: missing });
    const rows: { name: string; symbolId: number; details: SymbolInfo }[] = [];
    for (const x of (r.payload?.symbol ?? []) as Record<string, unknown>[]) {
      const symbolId = Number(x.symbolId);
      const info: SymbolInfo = {
        symbolId,
        name: names.get(symbolId) ?? String(symbolId),
        digits: Number(x.digits ?? 5),
        lotSize: Number(x.lotSize ?? 100_000),
        minVolume: Number(x.minVolume ?? 1),
        stepVolume: Number(x.stepVolume ?? 1),
        maxVolume: Number(x.maxVolume ?? Number.MAX_SAFE_INTEGER),
      };
      out.set(symbolId, info);
      rows.push({ name: `#${symbolId}`, symbolId, details: info }, { name: norm(info.name), symbolId, details: info });
    }
    await this.cachePut(rows);
    return out;
  }

  /** Resolve a broker symbol name (case-insensitive, ignores "/" etc. and trailing suffixes). */
  private async resolveSymbol(s: CtraderSession, requested: string): Promise<SymbolInfo> {
    const key = norm(requested);
    const hit = (await this.cacheGet([key])).get(key) as SymbolInfo | undefined;
    if (hit) return hit;
    const list = (await this.symbolList(s)).map((x) => ({ ...x, n: norm(x.symbolName) })).filter((x) => x.n);
    let m = list.find((x) => x.n === key);
    if (!m) {
      // suffix on the request (XAUUSD.m) or on the broker side (XAUUSD.r): prefer the closest by length
      const cand = list.filter((x) => (x.n.length >= 5 && key.startsWith(x.n)) || (key.length >= 5 && x.n.startsWith(key)));
      cand.sort((a, b) => Math.abs(a.n.length - key.length) - Math.abs(b.n.length - key.length));
      m = cand[0];
    }
    if (!m) throw new BrokerError(`symbol not found on this cTrader account: ${requested}`, 400);
    const info = (await this.symbolsById(s, [m.symbolId])).get(m.symbolId);
    if (!info) throw new BrokerError(`symbol details unavailable: ${requested}`, 502);
    info.name = m.symbolName;
    await this.cachePut([{ name: key, symbolId: info.symbolId, details: info }]);
    return info;
  }

  private lots(info: SymbolInfo | undefined, volume: unknown): number {
    const v = Number(volume);
    return Math.round((v / (info?.lotSize || 100_000)) * 10_000) / 10_000;
  }

  // ---------- reads ----------

  async accountInfo(): Promise<AccountInfo> {
    return this.run((s) => this.accountInfoIn(s));
  }

  private async accountInfoIn(s: CtraderSession): Promise<AccountInfo> {
    const r = await s.request(PT.TRADER_REQ, { ctidTraderAccountId: this.ctid });
    const t = r.payload?.trader ?? {};
    const moneyDigits = Number(t.moneyDigits ?? 2);
    const scale = 10 ** moneyDigits;
    const balance = Number(t.balance ?? 0) / scale;

    let equity: number | null = null;
    try {
      const pnl = await s.request(PT.GET_POSITION_UNREALIZED_PNL_REQ, { ctidTraderAccountId: this.ctid });
      const pd = 10 ** Number(pnl.payload?.moneyDigits ?? moneyDigits);
      equity = balance + ((pnl.payload?.positionUnrealizedPnL ?? []) as { netUnrealizedPnL: number }[]).reduce((a, p) => a + Number(p.netUnrealizedPnL) / pd, 0);
    } catch (e) {
      console.error('unrealized pnl unavailable', e);
    }

    let currency: string | null = null;
    if (t.depositAssetId != null) {
      const key = `@asset:${t.depositAssetId}`;
      const hit = (await this.cacheGet([key])).get(key) as { name: string } | undefined;
      if (hit) currency = hit.name;
      else {
        try {
          const a = await s.request(PT.ASSET_LIST_REQ, { ctidTraderAccountId: this.ctid });
          const assets = (a.payload?.asset ?? []) as { assetId: number; name: string }[];
          await this.cachePut(assets.map((x) => ({ name: `@asset:${x.assetId}`, symbolId: null, details: { name: x.name } })));
          currency = assets.find((x) => Number(x.assetId) === Number(t.depositAssetId))?.name ?? null;
        } catch (e) {
          console.error('asset list unavailable', e);
        }
      }
    }
    return {
      ctidTraderAccountId: this.ctid,
      login: Number(t.traderLogin ?? 0),
      isLive: this.target.isLive,
      brokerName: t.brokerName ?? null,
      currency,
      balance,
      equity,
      leverage: t.leverageInCents != null ? Number(t.leverageInCents) / 100 : null,
      moneyDigits,
    };
  }

  private async reconcile(s: CtraderSession): Promise<{ positions: Record<string, any>[]; orders: Record<string, any>[]; syms: Map<number, SymbolInfo> }> {
    const r = await s.request(PT.RECONCILE_REQ, { ctidTraderAccountId: this.ctid });
    const positions = (r.payload?.position ?? []) as Record<string, any>[];
    const orders = (r.payload?.order ?? []) as Record<string, any>[];
    const ids = [...positions.map((p) => Number(p.tradeData.symbolId)), ...orders.map((o) => Number(o.tradeData.symbolId))];
    return { positions, orders, syms: await this.symbolsById(s, ids) };
  }

  async positions(): Promise<Position[]> {
    return this.run(async (s) => {
      const { positions, syms } = await this.reconcile(s);
      const pnl = new Map<number, number>();
      if (positions.length) {
        try {
          const r = await s.request(PT.GET_POSITION_UNREALIZED_PNL_REQ, { ctidTraderAccountId: this.ctid });
          const d = 10 ** Number(r.payload?.moneyDigits ?? 2);
          for (const p of (r.payload?.positionUnrealizedPnL ?? []) as { positionId: number; netUnrealizedPnL: number }[]) pnl.set(Number(p.positionId), Number(p.netUnrealizedPnL) / d);
        } catch (e) {
          console.error('unrealized pnl unavailable', e);
        }
      }
      return positions.map((p): Position => {
        const info = syms.get(Number(p.tradeData.symbolId));
        const md = 10 ** Number(p.moneyDigits ?? 2);
        return {
          positionId: Number(p.positionId),
          symbol: info?.name ?? String(p.tradeData.symbolId),
          side: sideOf(p.tradeData.tradeSide),
          volumeLots: this.lots(info, p.tradeData.volume),
          entryPrice: Number(p.price ?? 0),
          stopLoss: num(p.stopLoss),
          takeProfit: num(p.takeProfit),
          swap: Number(p.swap ?? 0) / md,
          commission: Number(p.commission ?? 0) / md,
          profit: pnl.get(Number(p.positionId)) ?? null,
          openTime: Number(p.tradeData.openTimestamp ?? 0),
          label: p.tradeData.label ?? null,
          comment: p.tradeData.comment ?? null,
        };
      });
    });
  }

  async orders(): Promise<PendingOrder[]> {
    return this.run(async (s) => {
      const { orders, syms } = await this.reconcile(s);
      return orders.map((o): PendingOrder => {
        const info = syms.get(Number(o.tradeData.symbolId));
        return {
          orderId: Number(o.orderId),
          symbol: info?.name ?? String(o.tradeData.symbolId),
          side: sideOf(o.tradeData.tradeSide),
          type: orderTypeName(o.orderType),
          volumeLots: this.lots(info, o.tradeData.volume),
          price: num(o.limitPrice) ?? num(o.stopPrice),
          stopLoss: num(o.stopLoss),
          takeProfit: num(o.takeProfit),
          createdAt: Number(o.tradeData.openTimestamp ?? 0),
          expiresAt: num(o.expirationTimestamp) != null ? Number(o.expirationTimestamp) : null,
        };
      });
    });
  }

  async history(days = 7): Promise<Deal[]> {
    const d = Math.min(30, Math.max(1, Math.floor(days) || 7)); // API limits a deal query to one week; clamp loosely
    return this.run(async (s) => {
      const to = Date.now();
      const from = to - d * 86_400_000;
      const deals: Record<string, any>[] = [];
      // the API caps the window per request (1 week): walk backwards in 7-day chunks
      for (let end = to; end > from && deals.length < 2000; end -= 7 * 86_400_000) {
        const start = Math.max(from, end - 7 * 86_400_000);
        const r = await s.request(PT.DEAL_LIST_REQ, { ctidTraderAccountId: this.ctid, fromTimestamp: start, toTimestamp: end, maxRows: 1000 });
        deals.push(...((r.payload?.deal ?? []) as Record<string, any>[]));
      }
      const syms = await this.symbolsById(s, deals.map((x) => Number(x.symbolId)));
      return deals
        .map((x): Deal => {
          const info = syms.get(Number(x.symbolId));
          const c = x.closePositionDetail;
          const md = 10 ** Number(c?.moneyDigits ?? x.moneyDigits ?? 2);
          return {
            dealId: Number(x.dealId),
            positionId: Number(x.positionId),
            symbol: info?.name ?? String(x.symbolId),
            side: sideOf(x.tradeSide),
            volumeLots: this.lots(info, x.filledVolume ?? x.volume),
            price: Number(x.executionPrice ?? 0),
            profit: c ? (Number(c.grossProfit) + Number(c.swap ?? 0) + Number(c.commission ?? 0)) / md : null,
            time: Number(x.executionTimestamp ?? x.createTimestamp ?? 0),
            isClosing: !!c,
          };
        })
        .sort((a, b) => b.time - a.time);
    });
  }

  async test(): Promise<{ ok: boolean; account?: AccountInfo; latencyMs?: number; error?: string }> {
    const t0 = Date.now();
    try {
      const account = await this.accountInfo();
      return { ok: true, account, latencyMs: Date.now() - t0 };
    } catch (e) {
      return { ok: false, error: (e as Error).message };
    }
  }

  // ---------- trading ----------

  /** BUY | SELL | BUY_LIMIT | SELL_LIMIT | BUY_STOP | SELL_STOP */
  async openTrade(req: OrderRequest): Promise<TradeResult> {
    const m = /^(BUY|SELL)(?:_(LIMIT|STOP))?$/.exec(req.trade_type.toUpperCase());
    if (!m) throw new BrokerError(`unsupported trade_type ${req.trade_type}`, 400);
    const side = m[1] as TradeSide;
    const kind = (m[2] ?? 'MARKET') as 'MARKET' | 'LIMIT' | 'STOP';
    if (kind !== 'MARKET' && req.price == null) throw new BrokerError(`${kind} order requires a price`, 400);

    let expiresAt: number | null = null;
    if (kind !== 'MARKET' && req.expires_at != null) {
      const e = Number(req.expires_at);
      if (!Number.isFinite(e) || e < Date.now() + MIN_EXPIRY_AHEAD_MS) throw new BrokerError('expires_at must be at least 60 s in the future', 400);
      expiresAt = Math.floor(e);
    }

    return this.run(async (s) => {
      const info = await this.resolveSymbol(s, req.symbol);
      const volume = this.toVolume(info, req.volume);
      const px = (v: number) => Number(v.toFixed(info.digits));
      const sl = req.stop_loss != null ? px(req.stop_loss) : undefined;
      const tp = req.take_profit != null ? px(req.take_profit) : undefined;

      const payload: Record<string, unknown> = {
        ctidTraderAccountId: this.ctid,
        symbolId: info.symbolId,
        orderType: ORDER_TYPE[kind],
        tradeSide: TRADE_SIDE[side],
        volume,
        label: LABEL,
        ...(req.comment ? { comment: req.comment.slice(0, 512) } : {}),
      };

      if (kind === 'MARKET') {
        // Absolute stopLoss/takeProfit are "not supported for MARKET orders": use relative values from the
        // fill-side quote, then amend to the exact absolute levels once the position exists.
        if (sl != null || tp != null) {
          const price = await this.fillPrice(s, info.symbolId, side);
          const stepUnits = 10 ** (5 - Math.min(5, info.digits)); // keep relative values on the symbol's price grid
          const rel = (dist: number, what: string) => {
            if (dist <= 0) throw new BrokerError(`${what} is on the wrong side of the current ${side === 'BUY' ? 'ask' : 'bid'} ${price}`, 400);
            return Math.max(stepUnits, Math.round((dist * PRICE_SCALE) / stepUnits) * stepUnits);
          };
          if (sl != null) payload.relativeStopLoss = rel(side === 'BUY' ? price - sl : sl - price, `stop loss ${sl}`);
          if (tp != null) payload.relativeTakeProfit = rel(side === 'BUY' ? tp - price : price - tp, `take profit ${tp}`);
        }
      } else {
        payload[kind === 'LIMIT' ? 'limitPrice' : 'stopPrice'] = px(req.price as number);
        if (sl != null) payload.stopLoss = sl;
        if (tp != null) payload.takeProfit = tp;
        if (expiresAt != null) {
          payload.timeInForce = TIF_GOOD_TILL_DATE;
          payload.expirationTimestamp = expiresAt;
        }
      }

      const ev = await s.sendAndWait<Msg>(PT.NEW_ORDER_REQ, payload, (x) => this.orderOutcome(x, kind), 15_000, () => {
        throw new CtraderError('TIMEOUT', 'order was sent but no fill/accept event arrived; check open positions');
      });
      const p = ev.payload;
      const positionId = p.position?.positionId != null ? Number(p.position.positionId) : null;
      const result: TradeResult = {
        ok: true,
        positionId,
        orderId: p.order?.orderId != null ? Number(p.order.orderId) : null,
        price: num(p.deal?.executionPrice) ?? num(p.order?.executionPrice) ?? num(p.position?.price) ?? null,
        volumeLots: this.lots(info, p.deal?.filledVolume ?? p.order?.tradeData?.volume ?? volume),
        warning: null,
        ...(expiresAt != null ? { expiresAt } : {}),
      };

      if (kind === 'MARKET' && positionId != null && (sl != null || tp != null)) {
        const cur = p.position ?? {};
        const same = (a: unknown, b: number | undefined) => b == null || (typeof a === 'number' && Math.abs(a - b) < 10 ** -info.digits / 2);
        if (!same(cur.stopLoss, sl) || !same(cur.takeProfit, tp)) {
          try {
            await s.sendAndWait<true>(
              PT.AMEND_POSITION_SLTP_REQ,
              { ctidTraderAccountId: this.ctid, positionId, ...(sl != null ? { stopLoss: sl } : {}), ...(tp != null ? { takeProfit: tp } : {}) },
              (x) => (x.payloadType === PT.EXECUTION_EVENT && Number(x.payload?.position?.positionId) === positionId ? true : undefined),
              8_000,
            );
          } catch (e) {
            result.warning = `position opened but exact SL/TP amend failed: ${(e as Error).message}`;
            console.error(result.warning);
          }
        }
      }
      return result;
    });
  }

  private toVolume(info: SymbolInfo, lots: number): number {
    const step = Math.max(1, info.stepVolume);
    let v = Math.floor((lots * info.lotSize) / step + 1e-9) * step;
    v = Math.min(info.maxVolume, Math.max(info.minVolume, v));
    return v;
  }

  /** ExecutionEvent that ends an order request, or undefined to keep waiting. Rejections throw. */
  private orderOutcome(m: Msg, kind: 'MARKET' | 'LIMIT' | 'STOP'): Msg | undefined {
    if (m.payloadType !== PT.EXECUTION_EVENT) return undefined;
    const t = m.payload?.executionType;
    if (isEnum(t, EXEC_TYPE.REJECTED, 'ORDER_REJECTED')) throw new CtraderError(String(m.payload?.errorCode ?? 'ORDER_REJECTED'), 'order rejected by broker');
    if (isEnum(t, EXEC_TYPE.FILLED, 'ORDER_FILLED')) return m;
    if (kind !== 'MARKET' && isEnum(t, EXEC_TYPE.ACCEPTED, 'ORDER_ACCEPTED')) return m;
    return undefined;
  }

  /** One-shot quote: subscribe, take the first spot, unsubscribe. BUY fills at ask, SELL at bid. */
  private async fillPrice(s: CtraderSession, symbolId: number, side: TradeSide): Promise<number> {
    const field = side === 'BUY' ? 'ask' : 'bid';
    const spot = s.waitFor<number>((m) => (m.payloadType === PT.SPOT_EVENT && Number(m.payload?.symbolId) === symbolId && m.payload?.[field] ? Number(m.payload[field]) : undefined), 8_000);
    spot.catch(() => undefined);
    try {
      await s.request(PT.SUBSCRIBE_SPOTS_REQ, { ctidTraderAccountId: this.ctid, symbolId: [symbolId] });
      return (await spot) / PRICE_SCALE;
    } catch (e) {
      if (e instanceof CtraderError && e.code === 'TIMEOUT') throw new BrokerError('no quote received for symbol (market closed?)', 502);
      throw e;
    } finally {
      s.request(PT.UNSUBSCRIBE_SPOTS_REQ, { ctidTraderAccountId: this.ctid, symbolId: [symbolId] }, 3_000).catch(() => undefined);
    }
  }

  async closeTrade(a: { positionId: number; volumeLots?: number }): Promise<TradeResult> {
    return this.run(async (s) => {
      const { positions, syms } = await this.reconcile(s);
      const pos = positions.find((p) => Number(p.positionId) === Number(a.positionId));
      if (!pos) throw new BrokerError(`position ${a.positionId} not found`, 400);
      const info = syms.get(Number(pos.tradeData.symbolId));
      const full = Number(pos.tradeData.volume);
      let volume = full;
      if (a.volumeLots != null && a.volumeLots > 0 && info) volume = Math.min(full, Math.max(info.minVolume, Math.floor((a.volumeLots * info.lotSize) / info.stepVolume + 1e-9) * info.stepVolume));
      const ev = await s.sendAndWait<Msg>(
        PT.CLOSE_POSITION_REQ,
        { ctidTraderAccountId: this.ctid, positionId: Number(a.positionId), volume },
        (x) => {
          if (x.payloadType !== PT.EXECUTION_EVENT) return undefined;
          if (isEnum(x.payload?.executionType, EXEC_TYPE.REJECTED, 'ORDER_REJECTED')) throw new CtraderError(String(x.payload?.errorCode ?? 'ORDER_REJECTED'), 'close rejected by broker');
          return isEnum(x.payload?.executionType, EXEC_TYPE.FILLED, 'ORDER_FILLED') ? x : undefined;
        },
        15_000,
      );
      const p = ev.payload;
      return {
        ok: true,
        positionId: Number(a.positionId),
        orderId: p.order?.orderId != null ? Number(p.order.orderId) : null,
        price: num(p.deal?.executionPrice) ?? num(p.order?.executionPrice),
        volumeLots: this.lots(info, p.deal?.filledVolume ?? volume),
        warning: null,
      };
    });
  }
}
