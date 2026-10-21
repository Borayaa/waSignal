// Shared contract between the Worker modules, the dashboard frontend and the Baileys bridge.

export interface AiBinding {
  run(model: string, input: unknown): Promise<unknown>;
}

export interface Env {
  DB: D1Database;
  AI: AiBinding;
  ASSETS: Fetcher;
  SIGNAL_QUEUE: Queue<SignalQueueMessage>;
  SIGNUP_ENABLED: string;
  INVITE_CODE?: string; // optional secret: required to create new accounts when set
  SESSION_SECRET: string;
  ENCRYPTION_KEY: string; // base64-encoded 32 random bytes
  BRIDGE_TOKEN: string;
  CTRADER_CLIENT_ID?: string; // cTrader Open API application
  CTRADER_CLIENT_SECRET?: string;
  WORKERS_PLAN?: string; // 'free' | 'paid' (costs estimate)
}

export interface SignalQueueMessage {
  accountId: string;
  msg: IncomingMessage;
}

// Hono context variables set by the auth middleware.
export type AppBindings = { Bindings: Env; Variables: { accountId: string } };

// ---------- Automation config (stored as JSON in settings.config) ----------

export interface AutomationConfig {
  enabled: boolean; // master switch: execute trades from WhatsApp signals
  dryRun: boolean; // extract + build JSON but never call trade/open
  lotMode: 'fixed' | 'signal'; // 'signal' = use lot from message, falling back to fixedLot
  fixedLot: number;
  maxLot: number; // hard cap per position
  tpStrategy: 'first' | 'last' | 'split'; // split = one position per TP, lot divided evenly (min 0.01)
  minConfidence: number; // 0..1, reject extraction below this
  requireStopLoss: boolean;
  symbolSuffix: string; // appended to broker symbol, e.g. ".m"
  symbolMap: Record<string, string>; // alias -> broker symbol, e.g. { GOLD: "XAUUSD" } (keys uppercase)
  allowedSymbols: string[]; // empty = allow all (compared after mapping, before suffix)
  maxOpenPositions: number; // 0 = unlimited; skip new signals when reached
  commentPrefix: string; // trade comment, e.g. "waSignal"
  defaultSymbol: string; // used when a message names no symbol (e.g. a gold-only group); '' = require a symbol
  pipSizes: Record<string, number>; // broker symbol (after mapping, before suffix) -> price size of 1 pip; fallback: JPY pairs 0.01, else 0.0001
  timezone: string; // IANA zone for "time entry" windows in messages, e.g. "Asia/Jakarta"
}

export const DEFAULT_CONFIG: AutomationConfig = {
  enabled: false,
  dryRun: true,
  lotMode: 'fixed',
  fixedLot: 0.01,
  maxLot: 1,
  tpStrategy: 'first',
  minConfidence: 0.6,
  requireStopLoss: true,
  symbolSuffix: '',
  symbolMap: { GOLD: 'XAUUSD', SILVER: 'XAGUSD', US30: 'US30', NAS100: 'NAS100' },
  allowedSymbols: [],
  maxOpenPositions: 0,
  commentPrefix: 'waSignal',
  defaultSymbol: '',
  pipSizes: { XAUUSD: 0.1, XAGUSD: 0.01, US30: 1, NAS100: 1 },
  timezone: 'Asia/Jakarta',
};

export interface AccountSettings {
  config: AutomationConfig;
}

// ---------- Signal pipeline ----------

export type TradeSide = 'BUY' | 'SELL';
export type OrderKind = 'MARKET' | 'LIMIT' | 'STOP';

/** Raw Clairic output, normalized. */
export interface ExtractionResult {
  isSignal: boolean;
  side: TradeSide | null;
  orderKind: OrderKind;
  rawSymbol: string | null;
  entry: number | null;
  stopLoss: number | null;
  takeProfits: number[];
  volume: number | null;
  stopLossPips: number | null; // SL given as a distance in pips ("SL 25 pips"); converted with pipSizes
  takeProfitPips: number[]; // TP distances in pips ("TP 600 pips")
  entryWindow: { start: string; end: string } | null; // "Time entry 20.10-23.20" → { start: "20:10", end: "23:20" } (account timezone)
  symbolFromDefault: boolean; // true when rawSymbol came from config.defaultSymbol
  confidence: number; // min confidence across the required fields (side, symbol)
  fields: Record<string, { value: unknown; confidence: number | null }>; // per-field raw answers
}

/** The structured trade JSON handed to the cTrader broker client (one entry per position). */
export interface TradeSignal {
  symbol: string; // final broker symbol (mapped + suffix)
  rawSymbol: string;
  side: TradeSide;
  orderKind: OrderKind;
  entry: number | null;
  stopLoss: number | null;
  takeProfits: number[];
  orders: OrderRequest[];
  confidence: number;
}

/** One order to place via cTrader (lots; prices absolute). */
export interface OrderRequest {
  symbol: string;
  trade_type: string; // "BUY" | "SELL" | "BUY_LIMIT" | "SELL_LIMIT" | "BUY_STOP" | "SELL_STOP"
  volume: number; // lots
  price?: number; // pending orders only
  stop_loss?: number;
  take_profit?: number;
  comment?: string;
  expires_at?: number; // unix ms; pending orders only (cTrader expirationTimestamp, GOOD_TILL_DATE)
}

export type SignalStatus =
  | 'received' // stored, not processed yet
  | 'ignored' // not a trading signal / automation disabled
  | 'rejected' // looked like a signal but failed validation
  | 'dry_run' // valid, JSON built, not sent
  | 'executed' // all orders accepted
  | 'partial' // some orders failed
  | 'failed'; // all orders failed / API error

export type SignalSource = 'whatsapp' | 'telegram';
export type TgStatus = 'unavailable' | 'disconnected' | 'connecting' | 'qr' | 'password' | 'connected' | 'logged_out';
export type TgDesired = 'connected' | 'disconnected' | 'logout';

export interface IncomingMessage {
  source: SignalSource;
  messageId: string;
  chatId: string;
  sender: string | null;
  text: string;
  timestamp: number; // unix ms
}

// ---------- Baileys bridge protocol (Authorization: Bearer BRIDGE_TOKEN) ----------

export type WaStatus = 'disconnected' | 'connecting' | 'qr' | 'connected' | 'logged_out';
export type WaDesired = 'connected' | 'disconnected' | 'logout';

/** GET /api/bridge/sync */
export interface BridgeSyncResponse {
  accounts: { accountId: string; desired: WaDesired; targetChatId: string | null }[];
  telegram: { accountId: string; desired: TgDesired; targetChatId: string | null; password?: string }[];
}
/** POST /api/bridge/telegram/state */
export interface BridgeTgStateUpdate {
  accountId: string;
  status: TgStatus;
  qr?: string | null;
  user?: string | null;
  error?: string | null;
}
/** POST /api/bridge/telegram/chats (upsert) */
export interface BridgeTgChatsUpdate {
  accountId: string;
  chats: { id: string; name: string | null; kind: 'channel' | 'group' | 'user' }[];
}
/** POST /api/bridge/state */
export interface BridgeStateUpdate {
  accountId: string;
  status: WaStatus;
  qr?: string | null; // data URL png
  phone?: string | null;
}
/** POST /api/bridge/chats (upsert) */
export interface BridgeChatsUpdate {
  accountId: string;
  chats: { id: string; name: string | null; isGroup: boolean }[];
}
/** POST /api/bridge/message */
export interface BridgeMessage extends Omit<IncomingMessage, 'source'> {
  accountId: string;
  source?: SignalSource;
}

// ---------- cTrader (see docs/API.md v3) ----------

export interface CtraderAccount { ctidTraderAccountId: number; isLive: boolean; traderLogin: number; brokerTitleShort?: string | null }
export interface CtraderStatus {
  configured: boolean;
  linked: boolean;
  accounts: CtraderAccount[];
  selected: CtraderAccount | null;
  tokenExpiresAt: number | null;
}
export interface AccountInfo {
  ctidTraderAccountId: number; login: number; isLive: boolean; brokerName: string | null; currency: string | null;
  balance: number; equity: number | null; leverage: number | null; moneyDigits: number;
}
export interface Position {
  positionId: number; symbol: string; side: TradeSide; volumeLots: number; entryPrice: number;
  stopLoss: number | null; takeProfit: number | null; swap: number; commission: number; profit: number | null;
  openTime: number; label: string | null; comment: string | null;
}
export interface PendingOrder {
  orderId: number; symbol: string; side: TradeSide; type: 'LIMIT' | 'STOP' | string; volumeLots: number;
  price: number | null; stopLoss: number | null; takeProfit: number | null; createdAt: number; expiresAt: number | null;
}
export interface Deal {
  dealId: number; positionId: number; symbol: string; side: TradeSide; volumeLots: number; price: number;
  profit: number | null; time: number; isClosing: boolean;
}
export interface TradeResult {
  ok: true; positionId: number | null; orderId: number | null; price: number | null; volumeLots: number;
  /** Set when a non-fatal step failed (e.g. exact SL/TP amend after a market fill). */
  warning?: string | null;
  /** Pending-order expiry (unix ms) when one was set. */
  expiresAt?: number;
}

// ---------- Costs ----------

export interface CostLine { item: string; usage: number; unit: string; included: number; unitPrice: number; cost: number; note?: string }
export interface CostsResponse {
  month: string;
  plan: { name: 'Workers Free' | 'Workers Paid'; monthly: number };
  lines: CostLine[];
  totals: { usage: number; plan: number; total: number; projectedMonthEnd: number };
  counts: { signals: number; extractions: number; trades: number; daysElapsed: number; daysInMonth: number };
  daily: { date: string; signals: number; trades: number }[];
  notes: string[];
}
