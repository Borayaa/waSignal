// OANDA v20 REST client + token/account storage.
import type { AccountInfo, Deal, Env, OandaAccount, OandaStatus, OrderRequest, PendingOrder, Position, TradeResult, TradeSide } from '../../types';
import { decrypt, encrypt } from '../crypto';
import { BrokerError } from '../ctauth';
import type { Broker } from './index';
import { formatPrice, lotsToUnits, toOandaInstrument, toRfc3339, unitsPerLot } from './oanda-util';

const HOSTS = { practice: 'https://api-fxpractice.oanda.com', live: 'https://api-fxtrade.oanda.com' } as const;
type OandaEnv = keyof typeof HOSTS;
const TIMEOUT_MS = 10_000;
const MIN_EXPIRY_AHEAD_MS = 60_000;

export class OandaError extends Error {
  constructor(
    public code: string,
    detail: string,
  ) {
    super(`${code}: ${detail}`);
    this.name = 'OandaError';
  }
}

const f = (v: unknown): number | null => {
  const n = typeof v === 'string' || typeof v === 'number' ? Number(v) : NaN;
  return Number.isFinite(n) ? n : null;
};
const ms = (t: unknown): number => {
  const n = typeof t === 'string' ? Date.parse(t) : NaN;
  return Number.isFinite(n) ? n : 0;
};

type J = Record<string, any>;

async function oandaFetch(env: OandaEnv, token: string, path: string, init: { method?: string; body?: unknown } = {}): Promise<{ status: number; body: J }> {
  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), TIMEOUT_MS);
  try {
    const r = await fetch(HOSTS[env] + path, {
      method: init.method ?? 'GET',
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json', 'Accept-Datetime-Format': 'RFC3339' },
      body: init.body !== undefined ? JSON.stringify(init.body) : undefined,
      signal: ac.signal,
    });
    const body = (await r.json().catch(() => ({}))) as J;
    return { status: r.status, body };
  } catch (e) {
    if ((e as Error).name === 'AbortError') throw new OandaError('TIMEOUT', 'OANDA did not respond within 10 s');
    throw new OandaError('NETWORK', (e as Error).message);
  } finally {
    clearTimeout(timer);
  }
}

/** Throws OandaError for a rejected / failed request, otherwise returns the body. */
function ensure(r: { status: number; body: J }): J {
  const b = r.body;
  if (b.orderRejectTransaction) throw new OandaError(String(b.orderRejectTransaction.rejectReason ?? b.errorCode ?? 'ORDER_REJECTED'), String(b.errorMessage ?? 'order rejected by OANDA'));
  if (b.orderCancelTransaction && !b.orderFillTransaction) throw new OandaError(String(b.orderCancelTransaction.reason ?? 'ORDER_CANCELLED'), String(b.errorMessage ?? 'order cancelled by OANDA'));
  if (r.status >= 400) throw new OandaError(String(b.errorCode ?? r.status), String(b.errorMessage ?? 'request failed'));
  return b;
}

interface InstrumentInfo { name: string; type: string; displayPrecision: number; tradeUnitsPrecision: number; minimumTradeSize: number; maximumOrderUnits: number; marginRate: number | null }

interface AuthRow { token_enc: string; environment: string; accounts_json: string; selected_account_id: string | null }
const authRow = (env: Env, accountId: string) =>
  env.DB.prepare('SELECT token_enc, environment, accounts_json, selected_account_id FROM oanda_auth WHERE account_id = ?').bind(accountId).first<AuthRow>();
const accountsOf = (r: AuthRow): OandaAccount[] => {
  try {
    return JSON.parse(r.accounts_json) as OandaAccount[];
  } catch {
    return [];
  }
};

export class OandaClient implements Broker {
  private instruments = new Map<string, InstrumentInfo>();

  private constructor(
    private token: string,
    private environment: OandaEnv,
    private oandaAccountId: string,
  ) {}

  /** Throws BrokerError('OANDA account not connected', 400) when not linked / no account selected. */
  static async forAccount(env: Env, accountId: string): Promise<OandaClient> {
    const r = await authRow(env, accountId);
    if (!r || !r.selected_account_id) throw new BrokerError('OANDA account not connected', 400);
    return new OandaClient(await decrypt(env, r.token_enc), r.environment === 'live' ? 'live' : 'practice', r.selected_account_id);
  }

  private get base() {
    return `/v3/accounts/${encodeURIComponent(this.oandaAccountId)}`;
  }
  private call(path: string, init?: { method?: string; body?: unknown }) {
    return oandaFetch(this.environment, this.token, this.base + path, init).then(ensure);
  }

  private async loadInstruments(names: string[]): Promise<void> {
    const missing = [...new Set(names)].filter((n) => !this.instruments.has(n));
    if (!missing.length) return;
    const b = await this.call(`/instruments?instruments=${encodeURIComponent(missing.join(','))}`);
    for (const x of (b.instruments ?? []) as J[]) {
      this.instruments.set(String(x.name), {
        name: String(x.name),
        type: String(x.type ?? ''),
        displayPrecision: Number(x.displayPrecision ?? 5),
        tradeUnitsPrecision: Number(x.tradeUnitsPrecision ?? 0),
        minimumTradeSize: f(x.minimumTradeSize) ?? 1,
        maximumOrderUnits: f(x.maximumOrderUnits) ?? Number.MAX_SAFE_INTEGER,
        marginRate: f(x.marginRate),
      });
    }
  }
  private async instrument(name: string): Promise<InstrumentInfo> {
    await this.loadInstruments([name]);
    const i = this.instruments.get(name);
    if (!i) throw new BrokerError(`instrument not found on this OANDA account: ${name}`, 400);
    return i;
  }
  private lots(units: number, name: string): number {
    const upl = unitsPerLot(name, this.instruments.get(name)?.type);
    return Math.round((Math.abs(units) / upl) * 10_000) / 10_000;
  }

  async accountInfo(): Promise<AccountInfo> {
    const a = ((await this.call('/summary')).account ?? {}) as J;
    const mr = f(a.marginRate);
    return {
      ctidTraderAccountId: 0,
      accountId: this.oandaAccountId,
      broker: 'oanda',
      login: 0,
      isLive: this.environment === 'live',
      brokerName: 'OANDA',
      currency: a.currency ?? null,
      balance: f(a.balance) ?? 0,
      equity: f(a.NAV),
      leverage: mr && mr > 0 ? Math.round(1 / mr) : null,
      moneyDigits: 2,
    };
  }

  async positions(): Promise<Position[]> {
    const trades = ((await this.call('/openTrades')).trades ?? []) as J[];
    await this.loadInstruments(trades.map((t) => String(t.instrument)));
    return trades.map((t): Position => {
      const units = f(t.currentUnits) ?? 0;
      return {
        positionId: Number(t.id),
        symbol: String(t.instrument),
        side: units >= 0 ? 'BUY' : 'SELL',
        volumeLots: this.lots(units, String(t.instrument)),
        entryPrice: f(t.price) ?? 0,
        stopLoss: f(t.stopLossOrder?.price),
        takeProfit: f(t.takeProfitOrder?.price),
        swap: f(t.financing) ?? 0,
        commission: 0,
        profit: f(t.unrealizedPL),
        openTime: ms(t.openTime),
        label: t.clientExtensions?.tag ?? null,
        comment: t.clientExtensions?.comment ?? null,
      };
    });
  }

  async orders(): Promise<PendingOrder[]> {
    const all = ((await this.call('/pendingOrders')).orders ?? []) as J[];
    const orders = all.filter((o) => ['LIMIT', 'STOP', 'MARKET_IF_TOUCHED'].includes(o.type));
    await this.loadInstruments(orders.map((o) => String(o.instrument)));
    return orders.map((o): PendingOrder => {
      const units = f(o.units) ?? 0;
      return {
        orderId: Number(o.id),
        symbol: String(o.instrument),
        side: units >= 0 ? 'BUY' : 'SELL',
        type: o.type === 'MARKET_IF_TOUCHED' ? 'STOP' : o.type,
        volumeLots: this.lots(units, String(o.instrument)),
        price: f(o.price),
        stopLoss: f(o.stopLossOnFill?.price),
        takeProfit: f(o.takeProfitOnFill?.price),
        createdAt: ms(o.createTime),
        expiresAt: o.timeInForce === 'GTD' && o.gtdTime ? ms(o.gtdTime) : null,
      };
    });
  }

  async history(days = 7): Promise<Deal[]> {
    const d = Math.min(30, Math.max(1, Math.floor(days) || 7));
    const from = Date.now() - d * 86_400_000;
    const trades = ((await this.call('/trades?state=CLOSED&count=500')).trades ?? []) as J[];
    const recent = trades.filter((t) => ms(t.closeTime) >= from);
    await this.loadInstruments(recent.map((t) => String(t.instrument)));
    return recent
      .map((t): Deal => {
        const units = f(t.initialUnits) ?? 0;
        return {
          dealId: Number(t.id),
          positionId: Number(t.id),
          symbol: String(t.instrument),
          side: units >= 0 ? 'BUY' : 'SELL',
          volumeLots: this.lots(units, String(t.instrument)),
          price: f(t.averageClosePrice) ?? 0,
          profit: f(t.realizedPL) != null ? (f(t.realizedPL) as number) + (f(t.financing) ?? 0) : null,
          time: ms(t.closeTime),
          isClosing: true,
        };
      })
      .sort((a, b) => b.time - a.time);
  }

  async test(): Promise<{ ok: boolean; account?: AccountInfo; latencyMs?: number; error?: string }> {
    const t0 = Date.now();
    try {
      return { ok: true, account: await this.accountInfo(), latencyMs: Date.now() - t0 };
    } catch (e) {
      return { ok: false, error: (e as Error).message };
    }
  }

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

    const name = toOandaInstrument(req.symbol);
    const info = await this.instrument(name);
    const upl = unitsPerLot(name, info.type);
    const units = lotsToUnits(req.volume, upl, side, info.tradeUnitsPrecision, info.minimumTradeSize, info.maximumOrderUnits);
    const px = (v: number) => formatPrice(v, info.displayPrecision);

    const order: J = {
      type: kind,
      instrument: name,
      units,
      timeInForce: kind === 'MARKET' ? 'FOK' : expiresAt != null ? 'GTD' : 'GTC',
      positionFill: 'DEFAULT',
      clientExtensions: { tag: 'waSignal', ...(req.comment ? { comment: req.comment.slice(0, 128) } : {}) },
    };
    if (kind !== 'MARKET') order.price = px(req.price as number);
    if (expiresAt != null) order.gtdTime = toRfc3339(expiresAt);
    if (req.stop_loss != null) order.stopLossOnFill = { price: px(req.stop_loss), timeInForce: 'GTC' };
    if (req.take_profit != null) order.takeProfitOnFill = { price: px(req.take_profit), timeInForce: 'GTC' };

    const b = await this.call('/orders', { method: 'POST', body: { order } });
    const fill = b.orderFillTransaction as J | undefined;
    if (kind === 'MARKET') {
      if (!fill) throw new OandaError('NO_FILL', 'order was sent but no fill was reported; check open positions');
      const tid = fill.tradeOpened?.tradeID ?? fill.tradeReduced?.tradeID ?? fill.tradesClosed?.[0]?.tradeID;
      return {
        ok: true,
        positionId: tid != null ? Number(tid) : null,
        orderId: fill.orderID != null ? Number(fill.orderID) : null,
        price: f(fill.price),
        volumeLots: this.lots(f(fill.units) ?? f(units) ?? 0, name),
        warning: null,
      };
    }
    const create = b.orderCreateTransaction as J | undefined;
    return {
      ok: true,
      positionId: null,
      orderId: create?.id != null ? Number(create.id) : fill?.orderID != null ? Number(fill.orderID) : null,
      price: req.price ?? null,
      volumeLots: this.lots(Number(units), name),
      warning: null,
      ...(expiresAt != null ? { expiresAt } : {}),
    };
  }

  async closeTrade(a: { positionId: number; volumeLots?: number }): Promise<TradeResult> {
    const id = encodeURIComponent(String(a.positionId));
    const t = await oandaFetch(this.environment, this.token, `${this.base}/trades/${id}`).then((r) => {
      if (r.status === 404) throw new BrokerError(`position ${a.positionId} not found`, 400);
      return ensure(r).trade as J;
    });
    const name = String(t.instrument);
    const info = await this.instrument(name);
    const cur = Math.abs(f(t.currentUnits) ?? 0);
    let units = 'ALL';
    if (a.volumeLots != null && a.volumeLots > 0) {
      const u = Math.round(a.volumeLots * unitsPerLot(name, info.type) * 10 ** info.tradeUnitsPrecision) / 10 ** info.tradeUnitsPrecision;
      if (u < cur) units = Math.max(u, info.minimumTradeSize).toFixed(info.tradeUnitsPrecision);
    }
    const b = await this.call(`/trades/${id}/close`, { method: 'PUT', body: { units } });
    const fill = b.orderFillTransaction as J | undefined;
    if (!fill) throw new OandaError('NO_FILL', 'close was sent but no fill was reported');
    return {
      ok: true,
      positionId: Number(a.positionId),
      orderId: fill.orderID != null ? Number(fill.orderID) : null,
      price: f(fill.price),
      volumeLots: this.lots(f(fill.units) ?? cur, name),
      warning: null,
    };
  }
}

// ---------- token / account linking ----------

const cleanAccountId = (s: string) => s.trim();

async function fetchAccountList(environment: OandaEnv, token: string): Promise<OandaAccount[]> {
  const r = await oandaFetch(environment, token, '/v3/accounts');
  if (r.status === 401 || r.status === 403) throw new BrokerError('OANDA rejected this token', 400);
  const b = ensure(r);
  const ids = ((b.accounts ?? []) as J[]).map((a) => String(a.id));
  // /v3/accounts lists ids only; add alias + currency from each summary (best effort).
  return Promise.all(
    ids.map(async (id): Promise<OandaAccount> => {
      try {
        const s = await oandaFetch(environment, token, `/v3/accounts/${encodeURIComponent(id)}/summary`);
        const a = s.body.account ?? {};
        return { id, alias: a.alias ?? null, currency: a.currency ?? null };
      } catch {
        return { id, alias: null, currency: null };
      }
    }),
  );
}

export async function oandaStatus(env: Env, accountId: string): Promise<OandaStatus> {
  const r = await authRow(env, accountId);
  if (!r) return { linked: false, environment: null, accounts: [], selected: null, tokenHint: null };
  const accounts = accountsOf(r);
  let hint: string | null = null;
  try {
    hint = (await decrypt(env, r.token_enc)).slice(-4);
  } catch {
    /* unreadable token */
  }
  return {
    linked: true,
    environment: r.environment === 'live' ? 'live' : 'practice',
    accounts,
    selected: accounts.find((a) => a.id === r.selected_account_id) ?? null,
    tokenHint: hint,
  };
}

export async function oandaLink(env: Env, accountId: string, token: string, environment: OandaEnv): Promise<OandaStatus> {
  const accounts = await fetchAccountList(environment, token);
  const prev = await authRow(env, accountId);
  let sel = prev?.selected_account_id ? accounts.find((a) => a.id === prev.selected_account_id) : undefined;
  if (!sel && accounts.length === 1) sel = accounts[0];
  await env.DB.prepare(
    `INSERT INTO oanda_auth (account_id, token_enc, environment, accounts_json, selected_account_id, updated_at) VALUES (?1, ?2, ?3, ?4, ?5, ?6)
     ON CONFLICT(account_id) DO UPDATE SET token_enc = ?2, environment = ?3, accounts_json = ?4, selected_account_id = ?5, updated_at = ?6`,
  )
    .bind(accountId, await encrypt(env, token), environment, JSON.stringify(accounts), sel?.id ?? null, Date.now())
    .run();
  return oandaStatus(env, accountId);
}

export async function oandaSelect(env: Env, accountId: string, oandaAccountId: string): Promise<OandaStatus> {
  const r = await authRow(env, accountId);
  if (!r) throw new BrokerError('OANDA account not connected', 400);
  const id = cleanAccountId(oandaAccountId);
  if (!accountsOf(r).some((a) => a.id === id)) throw new BrokerError('accountId is not in the linked account list', 400);
  await env.DB.prepare('UPDATE oanda_auth SET selected_account_id = ?, updated_at = ? WHERE account_id = ?').bind(id, Date.now(), accountId).run();
  return oandaStatus(env, accountId);
}

export async function oandaRefresh(env: Env, accountId: string): Promise<OandaStatus> {
  const r = await authRow(env, accountId);
  if (!r) throw new BrokerError('OANDA account not connected', 400);
  const environment: OandaEnv = r.environment === 'live' ? 'live' : 'practice';
  const accounts = await fetchAccountList(environment, await decrypt(env, r.token_enc));
  const sel = accounts.find((a) => a.id === r.selected_account_id) ?? (accounts.length === 1 ? accounts[0] : undefined);
  await env.DB.prepare('UPDATE oanda_auth SET accounts_json = ?, selected_account_id = ?, updated_at = ? WHERE account_id = ?')
    .bind(JSON.stringify(accounts), sel?.id ?? null, Date.now(), accountId)
    .run();
  return oandaStatus(env, accountId);
}

export async function oandaUnlink(env: Env, accountId: string): Promise<OandaStatus> {
  await env.DB.prepare('DELETE FROM oanda_auth WHERE account_id = ?').bind(accountId).run();
  return oandaStatus(env, accountId);
}
