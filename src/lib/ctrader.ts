// Minimal cTrader Open API client: JSON over WebSocket, usable from workerd.
// Verified against spotware/openapi-proto-messages (see docs/CTRADER.md).
import type { CtraderAccount, Env } from '../types';

export const HOSTS = { demo: 'demo.ctraderapi.com', live: 'live.ctraderapi.com' } as const;
const PORT = 5036;
const REQUEST_TIMEOUT_MS = 10_000;
const HEARTBEAT_MS = 10_000;

/** ProtoOAPayloadType / ProtoPayloadType numbers used here. */
export const PT = {
  HEARTBEAT: 51,
  ERROR_RES_COMMON: 50,
  APP_AUTH_REQ: 2100,
  APP_AUTH_RES: 2101,
  ACCOUNT_AUTH_REQ: 2102,
  VERSION_REQ: 2104,
  NEW_ORDER_REQ: 2106,
  AMEND_POSITION_SLTP_REQ: 2110,
  CLOSE_POSITION_REQ: 2111,
  ASSET_LIST_REQ: 2112,
  SYMBOLS_LIST_REQ: 2114,
  SYMBOL_BY_ID_REQ: 2116,
  TRADER_REQ: 2121,
  RECONCILE_REQ: 2124,
  EXECUTION_EVENT: 2126,
  SUBSCRIBE_SPOTS_REQ: 2127,
  UNSUBSCRIBE_SPOTS_REQ: 2129,
  SPOT_EVENT: 2131,
  ORDER_ERROR_EVENT: 2132,
  DEAL_LIST_REQ: 2133,
  ERROR_RES: 2142,
  GET_ACCOUNTS_BY_TOKEN_REQ: 2149,
  GET_POSITION_UNREALIZED_PNL_REQ: 2187,
} as const;

/** Enum values (sent / received as numbers in JSON mode). */
export const ORDER_TYPE = { MARKET: 1, LIMIT: 2, STOP: 3 } as const;
export const TRADE_SIDE = { BUY: 1, SELL: 2 } as const;
export const EXEC_TYPE = { ACCEPTED: 2, FILLED: 3, REPLACED: 4, CANCELLED: 5, EXPIRED: 6, REJECTED: 7, CANCEL_REJECTED: 8, PARTIAL_FILL: 11 } as const;

export class CtraderError extends Error {
  constructor(
    public code: string,
    public description: string,
  ) {
    super(`${code}: ${description}`);
    this.name = 'CtraderError';
  }
}

export interface Msg {
  payloadType: number;
  clientMsgId?: string;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  payload: any;
}

/** Enum field that may arrive as a number or as its name. */
export const isEnum = (v: unknown, num: number, name: string) => v === num || v === name;

export class CtraderSession {
  private pending = new Map<string, { resolve: (m: Msg) => void; reject: (e: Error) => void; timer: ReturnType<typeof setTimeout> }>();
  private listeners = new Set<(m: Msg) => void>();
  private heartbeat: ReturnType<typeof setInterval> | null = null;
  private seq = 0;
  private closedReason: Error | null = null;

  private constructor(private ws: WebSocket) {
    ws.addEventListener('message', (ev) => this.onMessage(ev as MessageEvent));
    ws.addEventListener('close', () => this.fail(new CtraderError('CONNECTION_CLOSED', 'cTrader socket closed')));
    ws.addEventListener('error', () => this.fail(new CtraderError('CONNECTION_ERROR', 'cTrader socket error')));
    this.heartbeat = setInterval(() => this.rawSend({ payloadType: PT.HEARTBEAT, payload: {} }), HEARTBEAT_MS);
  }

  static async open(isLive: boolean): Promise<CtraderSession> {
    const host = isLive ? HOSTS.live : HOSTS.demo;
    const resp = await fetch(`https://${host}:${PORT}`, { headers: { Upgrade: 'websocket' } });
    const ws = resp.webSocket;
    if (!ws) throw new CtraderError('CONNECTION_FAILED', `${host} did not upgrade to WebSocket (HTTP ${resp.status})`);
    ws.accept();
    return new CtraderSession(ws);
  }

  private rawSend(m: object): void {
    try {
      this.ws.send(JSON.stringify(m));
    } catch {
      /* socket already closed; pending requests are failed by the close handler */
    }
  }

  private onMessage(ev: MessageEvent): void {
    let m: Msg;
    try {
      m = JSON.parse(typeof ev.data === 'string' ? ev.data : new TextDecoder().decode(ev.data as ArrayBuffer));
    } catch {
      return;
    }
    if (m.payloadType === PT.HEARTBEAT) return;
    for (const l of [...this.listeners]) l(m);
    const id = m.clientMsgId;
    const p = id ? this.pending.get(id) : undefined;
    if (!p || !id) return;
    this.pending.delete(id);
    clearTimeout(p.timer);
    const err = errorOf(m);
    if (err) p.reject(err);
    else p.resolve(m);
  }

  private fail(e: Error): void {
    this.closedReason ??= e;
    for (const [id, p] of this.pending) {
      clearTimeout(p.timer);
      p.reject(e);
      this.pending.delete(id);
    }
    for (const l of [...this.listeners]) l({ payloadType: -1, payload: { errorCode: 'CONNECTION_CLOSED', description: e.message } });
  }

  /** Send a request and resolve with the response that echoes its clientMsgId. */
  request(payloadType: number, payload: object = {}, timeoutMs = REQUEST_TIMEOUT_MS): Promise<Msg> {
    if (this.closedReason) return Promise.reject(this.closedReason);
    const clientMsgId = `m${++this.seq}`;
    return new Promise<Msg>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(clientMsgId);
        reject(new CtraderError('TIMEOUT', `no response to payloadType ${payloadType} within ${timeoutMs / 1000} s`));
      }, timeoutMs);
      this.pending.set(clientMsgId, { resolve, reject, timer });
      this.rawSend({ clientMsgId, payloadType, payload });
    });
  }

  /**
   * Send a request whose outcome arrives as events (orders): resolves with the first message `pick` returns
   * a value for. ProtoOAErrorRes / ProtoOAOrderErrorEvent / socket close reject with CtraderError. On timeout
   * resolves with `onTimeout()` if given, else rejects.
   */
  sendAndWait<T>(payloadType: number, payload: object, pick: (m: Msg) => T | undefined, timeoutMs = REQUEST_TIMEOUT_MS, onTimeout?: () => T): Promise<T> {
    if (this.closedReason) return Promise.reject(this.closedReason);
    return new Promise<T>((resolve, reject) => {
      const done = (fn: () => void) => {
        clearTimeout(timer);
        this.listeners.delete(listener);
        fn();
      };
      const listener = (m: Msg) => {
        const err = errorOf(m);
        if (err) return done(() => reject(err));
        let v: T | undefined;
        try {
          v = pick(m);
        } catch (e) {
          return done(() => reject(e));
        }
        if (v !== undefined) done(() => resolve(v));
      };
      const timer = setTimeout(() => {
        if (onTimeout) {
          try {
            const v = onTimeout();
            done(() => resolve(v));
          } catch (e) {
            done(() => reject(e));
          }
        } else done(() => reject(new CtraderError('TIMEOUT', `no result for payloadType ${payloadType} within ${timeoutMs / 1000} s`)));
      }, timeoutMs);
      this.listeners.add(listener);
      this.rawSend({ clientMsgId: `m${++this.seq}`, payloadType, payload });
    });
  }

  /** Wait for an unsolicited event (e.g. the first spot after subscribing). */
  waitFor<T>(pick: (m: Msg) => T | undefined, timeoutMs = REQUEST_TIMEOUT_MS): Promise<T> {
    return new Promise<T>((resolve, reject) => {
      const done = (fn: () => void) => {
        clearTimeout(timer);
        this.listeners.delete(listener);
        fn();
      };
      const listener = (m: Msg) => {
        const err = errorOf(m);
        if (err) return done(() => reject(err));
        let v: T | undefined;
        try {
          v = pick(m);
        } catch (e) {
          return done(() => reject(e));
        }
        if (v !== undefined) done(() => resolve(v));
      };
      const timer = setTimeout(() => done(() => reject(new CtraderError('TIMEOUT', 'timed out waiting for event'))), timeoutMs);
      this.listeners.add(listener);
    });
  }

  close(): void {
    if (this.heartbeat) clearInterval(this.heartbeat);
    this.heartbeat = null;
    this.closedReason ??= new CtraderError('CONNECTION_CLOSED', 'session closed');
    for (const [id, p] of this.pending) {
      clearTimeout(p.timer);
      p.reject(this.closedReason);
      this.pending.delete(id);
    }
    this.listeners.clear();
    try {
      this.ws.close(1000, 'done');
    } catch {
      /* ignore */
    }
  }

  async appAuth(env: Env): Promise<void> {
    if (!env.CTRADER_CLIENT_ID || !env.CTRADER_CLIENT_SECRET) throw new CtraderError('NOT_CONFIGURED', 'CTRADER_CLIENT_ID / CTRADER_CLIENT_SECRET are not set');
    await this.request(PT.APP_AUTH_REQ, { clientId: env.CTRADER_CLIENT_ID, clientSecret: env.CTRADER_CLIENT_SECRET });
  }

  async accountAuth(ctidTraderAccountId: number, accessToken: string): Promise<void> {
    await this.request(PT.ACCOUNT_AUTH_REQ, { ctidTraderAccountId, accessToken });
  }
}

/** ProtoOAErrorRes (2142), ProtoErrorRes (50) or ProtoOAOrderErrorEvent (2132) -> CtraderError. */
function errorOf(m: Msg): CtraderError | null {
  if (m.payloadType === PT.ERROR_RES || m.payloadType === PT.ERROR_RES_COMMON || m.payloadType === PT.ORDER_ERROR_EVENT) {
    return new CtraderError(String(m.payload?.errorCode ?? 'UNKNOWN_ERROR'), String(m.payload?.description ?? ''));
  }
  if (m.payloadType === -1) return new CtraderError(m.payload.errorCode, m.payload.description);
  return null;
}

export interface SessionTarget {
  accessToken: string;
  ctidTraderAccountId: number;
  isLive: boolean;
}

/** Open a socket, authenticate the application and the trading account, run `fn`, always close. */
export async function withSession<T>(env: Env, t: SessionTarget, fn: (s: CtraderSession) => Promise<T>): Promise<T> {
  const s = await CtraderSession.open(t.isLive);
  try {
    await s.appAuth(env);
    await s.accountAuth(t.ctidTraderAccountId, t.accessToken);
    return await fn(s);
  } finally {
    s.close();
  }
}

/** Trading accounts visible to an access token (application auth only; the demo host serves both). */
export async function getAccountList(env: Env, accessToken: string): Promise<CtraderAccount[]> {
  const s = await CtraderSession.open(false);
  try {
    await s.appAuth(env);
    const r = await s.request(PT.GET_ACCOUNTS_BY_TOKEN_REQ, { accessToken });
    const list = (r.payload?.ctidTraderAccount ?? []) as { ctidTraderAccountId: number; isLive?: boolean; traderLogin?: number; brokerTitleShort?: string }[];
    return list.map((a) => ({
      ctidTraderAccountId: Number(a.ctidTraderAccountId),
      isLive: !!a.isLive,
      traderLogin: Number(a.traderLogin ?? 0),
      brokerTitleShort: a.brokerTitleShort ?? null,
    }));
  } finally {
    s.close();
  }
}

/** Unauthenticated probe: ProtoOAVersionReq (2104). */
export async function version(isLive = false): Promise<string> {
  const s = await CtraderSession.open(isLive);
  try {
    const r = await s.request(PT.VERSION_REQ, {});
    return String(r.payload?.version);
  } finally {
    s.close();
  }
}
