# HTTP API contract

All JSON. Errors: `{ "error": string }` with 4xx/5xx status. Types refer to `src/types.ts`.

## Auth (dashboard)
Session = HttpOnly, Secure, SameSite=Lax cookie `wa_session` holding an HS256 JWT `{ sub: accountId, exp }` (7 days), signed with `SESSION_SECRET`.

| Method | Path | Body | Response |
|---|---|---|---|
| POST | `/api/auth/login` | `{ apiKey: string, label?: string }` | `{ id, label, keyPreview }`. Looks up `accounts.key_hash = sha256(apiKey)`. Unknown key → creates the account if `SIGNUP_ENABLED === "true"`, else 401. Also inserts default `settings` + `wa_state` rows. |
| POST | `/api/auth/logout` | – | `{ ok: true }` |
| GET | `/api/me` | – | `{ id, label, keyPreview, createdAt }` or 401 |

All endpoints below require the cookie (401 otherwise).

## Settings
| GET | `/api/settings` | – | `AccountSettings` |
| PUT | `/api/settings` | `{ config?: Partial<AutomationConfig>, mt?: { login?, server?, password? } }` | `AccountSettings` |

## WhatsApp
| GET | `/api/wa` | – | `{ status: WaStatus, qr: string\|null, phone: string\|null, desired: WaDesired, targetChatId: string\|null, targetChatName: string\|null, bridgeOnline: boolean, chats: { id, name, isGroup }[] }` — `bridgeOnline` = `bridge_seen_at` within last 30s. Chats sorted groups first then name. |
| POST | `/api/wa/connect` | – | `{ ok: true }` sets desired='connected' |
| POST | `/api/wa/disconnect` | – | sets desired='disconnected' |
| POST | `/api/wa/logout` | – | sets desired='logout', clears chats + target |
| PUT | `/api/wa/target` | `{ chatId: string\|null }` | `{ targetChatId, targetChatName }` |

## Signals & trades
| GET | `/api/signals?limit=50` | – | `{ signals: { id, chatId, sender, text, receivedAt, status, reason, extraction: ExtractionResult\|null, signal: TradeSignal\|null }[] }` newest first |
| GET | `/api/trades?limit=50` | – | `{ trades: { id, signalId, action, request, response, ok: boolean, ticket, createdAt }[] }` (request/response parsed JSON when possible) |
| GET | `/api/stats` | – | `{ today: { received, executed, rejected, failed, ignored, dryRun }, total: { signals, trades } }` |
| POST | `/api/extract` | `{ text: string, execute?: boolean }` | `{ extraction: ExtractionResult, signal: TradeSignal\|null, errors: string[], results?: unknown[] }` — playground; `execute` places the trade for real (ignores dryRun/enabled) |

## MetaTrader proxy (uses the account's stored API key + MT credentials)
| GET | `/api/mt/account` | – | MetaTrader `account-info` response (passthrough) |
| GET | `/api/mt/positions` | – | `{ positions: any[] }` |
| GET | `/api/mt/orders` | – | `{ orders: any[] }` |
| GET | `/api/mt/history` | – | `{ history: any[] }` |
| POST | `/api/mt/close` | `{ ticket: number\|string, volume?: number }` | passthrough |
| POST | `/api/mt/test` | – | starts a fresh session → `{ ok, sessionId?, accountInfo?, error? }` |
MT errors → 502 `{ error }`. Missing MT credentials → 400 `{ error: "MetaTrader credentials not configured" }`.

## Baileys bridge (header `Authorization: Bearer <BRIDGE_TOKEN>`)
Every bridge call updates `wa_state.bridge_seen_at` for the involved accounts (sync updates all).

| GET | `/api/bridge/sync` | – | `BridgeSyncResponse` — every account whose wa_state.desired != 'disconnected' OR status != 'disconnected'. After returning a 'logout' row, the bridge logs out then posts state 'logged_out'; worker then sets desired='disconnected'. |
| POST | `/api/bridge/state` | `BridgeStateUpdate` | `{ ok: true }` |
| POST | `/api/bridge/chats` | `BridgeChatsUpdate` | `{ ok: true }` (upsert, batch) |
| POST | `/api/bridge/message` | `BridgeMessage` | `{ ok: true, status: SignalStatus }` — dropped (status 'ignored', not stored) if chatId != target chat. Otherwise `processIncomingMessage` runs (in `waitUntil`, response returns `received`). |

---

# v3 — cTrader Open API (IC Markets) — supersedes all MetaTrader / container sections above

No MetaTrader, no containers. Trades go straight from the Worker to **cTrader Open API** over a JSON
WebSocket (`wss://demo.ctraderapi.com:5036` / `wss://live.ctraderapi.com:5036`, verified reachable from
workerd). One Open API application per deployment (Worker secrets `CTRADER_CLIENT_ID`,
`CTRADER_CLIENT_SECRET`); each dashboard account links its own cTrader ID via OAuth and picks one
trading account (demo or live). Details of the protocol: docs/CTRADER.md.

The dashboard login key is an **access key** (any secret ≥ 8 chars). New accounts need `inviteCode`
when the `INVITE_CODE` secret is set (unchanged from v2).

## cTrader connection
| GET | `/api/ctrader/connect` | – | 302 → `https://id.ctrader.com/my/settings/openapi/grantingaccess/?client_id=…&redirect_uri=<origin>/api/ctrader/callback&scope=trading&product=web&state=<signed>` (state = HS256 JWT `{sub: accountId, nonce, exp: +10min}`) |
| GET | `/api/ctrader/callback?code&state` | – | verifies state, exchanges code, stores tokens (encrypted), loads the trading-account list, auto-selects if exactly one; 302 → `/dashboard#automation` (on error `/dashboard#automation?ctrader_error=<msg>`) |
| GET | `/api/ctrader` | – | `CtraderStatus` |
| PUT | `/api/ctrader/account` | `{ ctidTraderAccountId: number }` (must be in the linked list) | `CtraderStatus` |
| POST | `/api/ctrader/refresh-accounts` | – | re-fetches the account list → `CtraderStatus` |
| DELETE | `/api/ctrader` | – | unlink (delete tokens) → `CtraderStatus` |
```ts
interface CtraderAccount { ctidTraderAccountId: number; isLive: boolean; traderLogin: number; brokerTitleShort?: string | null }
interface CtraderStatus {
  configured: boolean;            // CTRADER_CLIENT_ID/SECRET secrets present
  linked: boolean;                // tokens stored
  accounts: CtraderAccount[];
  selected: CtraderAccount | null;
  tokenExpiresAt: number | null;  // unix ms
}
```

## Trading data (all open a short-lived WebSocket session; ~1 s)
| GET | `/api/broker/account` | – | `AccountInfo` |
| GET | `/api/broker/positions` | – | `{ positions: Position[] }` |
| GET | `/api/broker/orders` | – | `{ orders: PendingOrder[] }` |
| GET | `/api/broker/history?days=7` | – | `{ history: Deal[] }` |
| POST | `/api/broker/close` | `{ positionId: number, volumeLots?: number }` | `TradeResult` |
| POST | `/api/broker/test` | – | `{ ok, account?: AccountInfo, latencyMs?, error? }` |
Not linked / no account selected → 400 `{ error: "cTrader account not connected" }`. cTrader errors → 502 `{ error: "<errorCode>: <description>" }`.

```ts
interface AccountInfo { ctidTraderAccountId: number; login: number; isLive: boolean; brokerName: string | null;
  currency: string | null; balance: number; equity: number | null; leverage: number | null; moneyDigits: number }
interface Position { positionId: number; symbol: string; side: "BUY" | "SELL"; volumeLots: number; entryPrice: number;
  stopLoss: number | null; takeProfit: number | null; swap: number; commission: number; profit: number | null;
  openTime: number /* unix ms */; label: string | null; comment: string | null }
interface PendingOrder { orderId: number; symbol: string; side: "BUY" | "SELL"; type: "LIMIT" | "STOP" | string;
  volumeLots: number; price: number | null; stopLoss: number | null; takeProfit: number | null; createdAt: number }
interface Deal { dealId: number; positionId: number; symbol: string; side: "BUY" | "SELL"; volumeLots: number;
  price: number; profit: number | null; time: number; isClosing: boolean }
interface TradeResult { ok: true; positionId: number | null; orderId: number | null; price: number | null; volumeLots: number }
```
`equity`/`profit` may be null when cTrader doesn't provide them cheaply; the UI shows "—".

## Costs (no containers any more)
| GET | `/api/costs?month=YYYY-MM` | – | `CostsResponse` |
```ts
interface CostsResponse {
  month: string;
  plan: { name: "Workers Free" | "Workers Paid"; monthly: number };   // from var WORKERS_PLAN ("free" | "paid")
  lines: { item: string; usage: number; unit: string; included: number; unitPrice: number; cost: number; note?: string }[];
  // items: Worker requests (est.: bridge polls + dashboard), Queue operations (3 per signal), Clairic extraction (input tokens),
  //        D1 rows written (est.), cTrader Open API (free)
  totals: { usage: number; plan: number; total: number; projectedMonthEnd: number };
  counts: { signals: number; extractions: number; trades: number; daysElapsed: number; daysInMonth: number };
  daily: { date: string; signals: number; trades: number }[];
  notes: string[];
}
```
