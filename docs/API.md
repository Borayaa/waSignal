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

---

# v4 — username & password accounts (supersedes every access-key / apiKey login section above)

Accounts are now username + password. The `accounts` table is rebuilt by `migrations/0003_users.sql`
(production had 0 accounts, so no data migration). Columns: `id TEXT PK, username TEXT NOT NULL UNIQUE COLLATE NOCASE,
password_hash TEXT NOT NULL, session_version INTEGER NOT NULL DEFAULT 1, failed_logins INTEGER NOT NULL DEFAULT 0,
locked_until INTEGER, created_at INTEGER NOT NULL, last_login_at INTEGER`. Other tables keep `REFERENCES accounts(id)`.

- Username: 3–32 chars `[A-Za-z0-9_.-]`, case-insensitive unique, stored as typed (display) but compared NOCASE.
- Password: 8–128 chars. Hash: PBKDF2-SHA256, 100,000 iterations (workerd max), 16-byte random salt,
  stored as `pbkdf2-sha256$100000$<b64 salt>$<b64 hash>`; constant-time verify. Unknown usernames still run one
  PBKDF2 against a dummy hash so timing doesn't reveal which usernames exist.
- Lockout: 5 consecutive failures → `locked_until = now + 15 min`; success resets `failed_logins`.
- Session JWT (cookie `wa_session`, 7 days) now carries `{ sub: accountId, v: session_version, exp }`. `requireAuth`
  loads the account and rejects (401, clears cookie) if it no longer exists or `v` ≠ `session_version`.

| Method | Path | Body | Response |
|---|---|---|---|
| POST | `/api/auth/signup` | `{ username, password, inviteCode? }` | 201 `Me` + session cookie. 400 `{error}` (validation message), 403 `"Sign-ups are disabled"` when `SIGNUP_ENABLED !== "true"`, 403 `"Invalid invite code"` when `INVITE_CODE` is set and doesn't match, 409 `"Username already taken"`. Creates `settings` + `wa_state` rows in the same batch. |
| POST | `/api/auth/login` | `{ username, password }` | `Me` + session cookie. 401 `"Invalid username or password"` (same message for unknown user / wrong password), 429 `"Too many failed attempts. Try again in N minutes."` |
| POST | `/api/auth/logout` | – | `{ ok: true }` |
| GET | `/api/me` | – | `Me` or 401 |
| PUT | `/api/auth/password` | `{ currentPassword, newPassword }` | `{ ok: true }` — verifies current, rehashes, increments `session_version` (logs out all other sessions) and re-issues this session's cookie. 400 validation, 401 `"Current password is incorrect"`. |

```ts
interface Me { id: string; username: string; createdAt: number; lastLoginAt: number | null }
```

---

# v5 — Telegram as a second signal source (in addition to WhatsApp)

Telegram is read through a **user session** (MTProto, GramJS `telegram` npm package) inside the existing bridge —
not a bot — so any channel/group the user has joined can be the signal source. Login by **QR code**
(Telegram app → Settings → Devices → Link Desktop Device) plus the 2FA cloud password when the account has one.
Bridge env: `TELEGRAM_API_ID`, `TELEGRAM_API_HASH` (from https://my.telegram.org → API development tools);
when missing, the bridge reports Telegram as unavailable and keeps WhatsApp working. Session string stored in
`${AUTH_DIR}/tg-<accountId>.session` (never sent to the Worker).

Each account can use WhatsApp and/or Telegram at the same time, each with its own target chat.

## Schema (migrations/0004_telegram.sql)
- `tg_state(account_id PK → accounts ON DELETE CASCADE, status TEXT NOT NULL DEFAULT 'disconnected', qr TEXT, user_label TEXT,
  desired TEXT NOT NULL DEFAULT 'disconnected', target_chat_id TEXT, target_chat_name TEXT, password_enc TEXT, error TEXT,
  bridge_seen_at INTEGER, updated_at INTEGER NOT NULL)`; signup also inserts a tg_state row (and the migration backfills rows for existing accounts).
- `tg_chats(account_id, chat_id, name, kind TEXT /* 'channel' | 'group' | 'user' */, updated_at, PK(account_id, chat_id))`.
- `signals` gets `source TEXT NOT NULL DEFAULT 'whatsapp'` (`'whatsapp' | 'telegram'`). Telegram message ids are stored as
  `tg:<chatId>:<messageId>` in `wa_message_id` so dedupe stays unique per account.

```ts
type TgStatus = 'unavailable' /* bridge has no API id/hash */ | 'disconnected' | 'connecting' | 'qr' | 'password' | 'connected' | 'logged_out';
type TgDesired = 'connected' | 'disconnected' | 'logout';
type SignalSource = 'whatsapp' | 'telegram';
```

## Dashboard API (cookie auth)
| GET | `/api/tg` | – | `{ status: TgStatus, qr: string\|null /* PNG data URL */, user: string\|null, desired: TgDesired, targetChatId, targetChatName, error: string\|null, bridgeOnline: boolean, chats: { id, name, kind }[] }` — chats sorted channels, groups, then users; by name |
| POST | `/api/tg/connect` | – | desired='connected' |
| POST | `/api/tg/disconnect` | – | desired='disconnected' |
| POST | `/api/tg/logout` | – | desired='logout', clears chats + target |
| PUT | `/api/tg/target` | `{ chatId: string\|null }` | `{ targetChatId, targetChatName }` (chatId must exist in tg_chats) |
| POST | `/api/tg/password` | `{ password }` | stores it encrypted (`password_enc`) for the bridge to pick up once → `{ ok: true }` (400 unless status is 'password') |
Signals list items gain `source: SignalSource`. `/api/stats` unchanged.

## Bridge API additions (Bearer BRIDGE_TOKEN)
| GET | `/api/bridge/sync` | – | adds `telegram: { accountId, desired: TgDesired, targetChatId: string\|null, password?: string }[]` — accounts whose tg desired ≠ 'disconnected' or status ∉ ('disconnected','unavailable'). `password` is decrypted, included once, then `password_enc` is cleared. |
| POST | `/api/bridge/telegram/state` | `{ accountId, status: TgStatus, qr?: string\|null, user?: string\|null, error?: string\|null }` | qr cleared unless status 'qr'; 'logged_out' → desired='disconnected', clear user/target, delete tg_chats |
| POST | `/api/bridge/telegram/chats` | `{ accountId, chats: { id: string, name: string\|null, kind: 'channel'\|'group'\|'user' }[] }` | upsert |
| POST | `/api/bridge/message` | `BridgeMessage & { source?: SignalSource }` | default 'whatsapp'. Target check uses wa_state for whatsapp, tg_state for telegram. |

Telegram chat ids are GramJS "marked" peer ids as strings (e.g. `-1001234567890` for channels/supergroups).
Bridge forwards only NewMessage events (incl. channel posts) from the target chat; text = message text or media caption; skips empty.

---

# v6 — OANDA as a second broker (alongside cTrader)

Each dashboard account picks its broker: `AutomationConfig.broker: 'ctrader' | 'oanda'` (default `'ctrader'`).
All trading goes through one interface; `/api/broker/*` routes dispatch to the selected broker. Shapes
(AccountInfo, Position, PendingOrder, Deal, TradeResult) stay as in v3; for OANDA: `ctidTraderAccountId` → use
`accountId: string` (add optional `accountId?: string`, `broker: 'ctrader'|'oanda'` to AccountInfo), `isLive` = environment === 'live',
`login` = 0, `brokerName` = "OANDA". OANDA trade ids are integers → Position.positionId (number).

## OANDA v20 REST (verify against https://developer.oanda.com/rest-live-v20/introduction/ before coding)
- Hosts: practice `https://api-fxpractice.oanda.com`, live `https://api-fxtrade.oanda.com`. Auth: `Authorization: Bearer <personal access token>`
  (generated by the user in OANDA → Manage API Access). Optional header `Accept-Datetime-Format: UNIX`.
- `GET /v3/accounts` (list), `GET /v3/accounts/{id}/summary`, `GET /v3/accounts/{id}/instruments?instruments=XAU_USD`
  (pipLocation, displayPrecision, tradeUnitsPrecision, minimumTradeSize, maximumOrderUnits),
  `POST /v3/accounts/{id}/orders` `{ order: { type: MARKET|LIMIT|STOP, instrument, units: "<signed>", price?, timeInForce, gtdTime?,
  positionFill: "DEFAULT", stopLossOnFill: { price }, takeProfitOnFill: { price }, clientExtensions: { tag: "waSignal", comment } } }`
  (prices as strings at displayPrecision; MARKET → timeInForce FOK; pending → GTC, or GTD + gtdTime when expires_at),
  `GET /v3/accounts/{id}/openTrades`, `GET /v3/accounts/{id}/pendingOrders`, `PUT /v3/accounts/{id}/trades/{tradeId}/close` `{ units: "ALL" | "<n>" }`,
  `GET /v3/accounts/{id}/trades?state=CLOSED&count=…` for history.
- Symbol conversion (broker symbol after mapping, before suffix): contains "_" → as-is; 6 letters → `XAU_USD` style; indices map
  `US30→US30_USD, NAS100→NAS100_USD, SPX500→SPX500_USD, GER40→DE30_EUR, UK100→UK100_GBP, JP225→JP225_USD`; otherwise as-is.
- Lots → units: XAU_* 100 per lot, XAG_* 5000 per lot, other metals/FX 100000 per lot, indices/CFDs 1 per lot; rounded to
  tradeUnitsPrecision, ≥ minimumTradeSize; sign negative for SELL. Position.volumeLots = |units| / unitsPerLot.

## Schema — migrations/0005_oanda.sql
`oanda_auth(account_id PK → accounts ON DELETE CASCADE, token_enc TEXT NOT NULL, environment TEXT NOT NULL /* practice|live */,
accounts_json TEXT NOT NULL DEFAULT '[]', selected_account_id TEXT, updated_at INTEGER NOT NULL)`.

## Dashboard API (cookie auth)
| GET | `/api/oanda` | – | `OandaStatus` |
| PUT | `/api/oanda` | `{ token: string, environment: 'practice'\|'live' }` | validates the token with `GET /v3/accounts` (401 → 400 `"OANDA rejected this token"`), stores it encrypted + account list, auto-selects if one → `OandaStatus` |
| PUT | `/api/oanda/account` | `{ accountId }` (must be in the list) | `OandaStatus` |
| POST | `/api/oanda/refresh-accounts` | – | `OandaStatus` |
| DELETE | `/api/oanda` | – | `OandaStatus` |
```ts
interface OandaAccount { id: string; alias: string | null; currency: string | null }
interface OandaStatus { linked: boolean; environment: 'practice' | 'live' | null; accounts: OandaAccount[]; selected: OandaAccount | null; tokenHint: string | null /* last 4 chars */ }
```
`PUT /api/settings { config: { broker } }` switches broker (validated: 'ctrader' | 'oanda').
`/api/broker/*`: not connected → 400 `{ error: "OANDA account not connected" }` / cTrader message as before. OANDA errors → 502 `"<errorCode>: <errorMessage>"`.
