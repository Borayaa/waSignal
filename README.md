# waSignal Trading

A trading dashboard that bridges WhatsApp and Telegram trading signals directly to cTrader Open API (IC Markets) via automated trade execution. Hosted at https://trading.infragreen.app.

## Overview

waSignal Trading automates the workflow from WhatsApp and Telegram trading signals to live trading accounts. A bridge service monitors one WhatsApp chat or Telegram channel/group for trade signals and forwards them to the Cloudflare Worker, which enqueues them in a Cloudflare Queue for processing. The queue consumer extracts structured data using Workers AI (Clairic model), validates against your automation rules, and executes trades via the cTrader Open API (~1 second per trade).

```
WhatsApp/Telegram     Bridge Service             Cloudflare Worker    Cloudflare Queue
  Chat       →   (Node.js + Baileys/GramJS) →   (TypeScript + Hono)  →  (wasignal-signals)
                      ↓                                                       ↓
                  Sessions in                                    Clairic AI extraction
                  bridge/auth/                                   (Workers AI model)
                                                                       ↓
                                            Signal validation         cTrader Open API
                                            (automation rules)        (IC Markets)
                                                 ↓
                                        Trade execution
                                      (demo or live account)

  Signal text: "BUY AAPL
   Entry 150                          Validate vs config:
   SL 148.5                           - symbol map/suffix
   TP 152 153.5"                      - allowed symbols
                                       - dry run mode
  Multi-account:                       - confidence threshold
  Each account can use
  WhatsApp and/or Telegram           Store: signals, trades, costs
  + dedicated cTrader account
```

## Repo Layout

- **src/index.ts** — main Worker entry point, request routing
- **src/routes/auth.ts** — login/logout, session JWT, invite code validation
- **src/routes/dashboard.ts** — settings, WhatsApp state, signal/trade logs, test extraction
- **src/routes/bridge.ts** — Baileys bridge sync/state/chats/message API
- **src/routes/ctrader.ts** — cTrader OAuth callback, account/position queries
- **src/lib/ctrader.ts** — cTrader Open API WebSocket client
- **src/lib/ctauth.ts** — cTrader OAuth token storage and refresh
- **src/lib/broker.ts** — trade execution (connect/open/close), account switching
- **src/lib/clairic.ts** — Workers AI extraction, field normalization
- **src/lib/queue.ts** — signal enqueue/dequeue, queue consumer loop
- **src/lib/pipeline.ts** — signal validation, automation config rules
- **src/lib/settings.ts** — load/save account config and cTrader OAuth token
- **src/lib/costs.ts** — calculate Workers/Queues/Workers AI usage
- **src/lib/crypto.ts** — AES-GCM encrypt/decrypt for cTrader token
- **src/lib/auth.ts** — session JWT, middleware
- **src/types.ts** — shared TypeScript interfaces (Env, AutomationConfig, TradeSignal, etc.)
- **public/** — dashboard UI (HTML/CSS/JS, served as static assets); includes Costs tab
- **migrations/0001_init.sql** — D1 schema: accounts, settings, wa_state, wa_chats, signals, trades
- **migrations/0002_costs.sql** — D1 tables: usage_logs (for billing)
- **bridge/** — Baileys Node.js service (separate npm package, runs on VPS/home server/Docker)
- **docs/API.md** — complete HTTP API reference (v3 section covers cTrader endpoints)
- **landing/** — static marketing page for https://infragreen.app (own Worker, `landing/wrangler.jsonc`; deployed by `scripts/deploy.sh`)
- **docs/CTRADER.md** — cTrader Open API architecture, OAuth flow, WebSocket protocol

## Set Up cTrader Open API

Before deploying, create a cTrader application on Spotware's developer portal:

1. Go to https://openapi.ctrader.com → **Applications**
2. Create a new application:
   - **App Name**: e.g., "waSignal"
   - **Redirect URI**: `https://trading.infragreen.app/api/ctrader/callback` (or your custom domain)
   - **Scopes**: select `trading` (required for trade execution) and any other needed scopes
   - **Agreement**: check the terms
3. Once created, copy the **Client ID** and **Client Secret**
4. **Note**: Spotware may require approval (check email in 1–2 business days). New apps start in sandbox/demo mode.

## Deploy to Cloudflare

### Prerequisites
- Cloudflare account with a domain (e.g., infragreen.app) on your account
- Wrangler CLI installed globally or via `npm install -g wrangler`
- Node.js and openssl CLI tools
- cTrader Client ID and Client Secret (see above)

### Quick Deploy

The `scripts/deploy.sh` script automates the entire setup:

```bash
# Option 1: Interactive (prompts for cTrader secrets if stdin is a TTY)
scripts/deploy.sh

# Option 2: Non-interactive (reads env vars CTRADER_CLIENT_ID / CTRADER_CLIENT_SECRET)
export CTRADER_CLIENT_ID="your-client-id"
export CTRADER_CLIENT_SECRET="your-client-secret"
scripts/deploy.sh
```

It will:
1. Create the D1 database if missing, auto-detecting its ID
2. Apply all migrations
3. Generate or reuse secrets: `SESSION_SECRET`, `ENCRYPTION_KEY`, `BRIDGE_TOKEN`, `INVITE_CODE`, `CTRADER_CLIENT_ID`, `CTRADER_CLIENT_SECRET`
4. Create the Cloudflare Queue `wasignal-signals`
5. Deploy the Worker with all bindings

**On first deploy**, the script will print your invite code (can't be read back from Cloudflare):
```
Invite code for creating accounts: a1b2c3d4e5f6
```
Save this — users need it to create accounts (unless `INVITE_CODE` is unset to allow signup without a code).

To skip the actual deploy and only set up the database: `scripts/deploy.sh --no-deploy`.

### Manual Setup (if not using `scripts/deploy.sh`)

1. **Install dependencies:**
   ```bash
   npm install
   ```

2. **Log in to Cloudflare:**
   ```bash
   npx wrangler login
   ```

3. **Create D1 database and apply migrations:**
   ```bash
   npx wrangler d1 create wasignal-trading
   ```
   Copy the `database_id` and paste it into `wrangler.jsonc` (replace `TODO_DATABASE_ID`).
   ```bash
   CI=true npx wrangler d1 migrations apply wasignal-trading --remote
   ```

4. **Create the Cloudflare Queue:**
   ```bash
   npx wrangler queues create wasignal-signals
   ```

5. **Set secrets:**
   ```bash
   openssl rand -base64 48 | npx wrangler secret put SESSION_SECRET
   openssl rand -base64 32 | npx wrangler secret put ENCRYPTION_KEY
   openssl rand -hex 32 | npx wrangler secret put BRIDGE_TOKEN
   openssl rand -hex 6 | npx wrangler secret put INVITE_CODE
   npx wrangler secret put CTRADER_CLIENT_ID       # paste your Client ID
   npx wrangler secret put CTRADER_CLIENT_SECRET   # paste your Client Secret
   ```

6. **Deploy Worker:**
   ```bash
   npm run deploy
   ```
   The custom domain `trading.infragreen.app` is automatically wired via the `routes` config in `wrangler.jsonc`.

### Post-Deploy

7. **Optional: require signup codes** — after creating accounts, you can delete the `INVITE_CODE` secret to require all future signups to provide a code. Or set `SIGNUP_ENABLED` to `"false"` in `wrangler.jsonc` to block all new signups, then re-deploy.

## Local Development

### Setup

1. **Copy dev environment file:**
   ```bash
   cp .dev.vars.example .dev.vars
   ```

2. **Generate or paste secrets into `.dev.vars`** matching the format (use the same commands as above).

3. **Apply local database migrations:**
   ```bash
   npm run db:migrate:local
   ```

4. **Run the dev server:**
   ```bash
   npm run dev
   ```
   
   The Worker will be available at `http://localhost:8787`. Dashboard at `http://localhost:8787/`.
   
   **Note:** Workers AI calls the remote Clairic model even in local dev; you must be logged in (`npx wrangler login`) for it to work.

## Running the Bridge (Node Service with Baileys & GramJS)

The bridge polls the Worker at `/api/bridge/sync` and manages WhatsApp sessions via Baileys (unofficial WhatsApp Web client) and Telegram sessions via GramJS (MTProto user session).

### Setup

1. **Enter the bridge directory:**
   ```bash
   cd bridge
   ```

2. **Copy the example env file:**
   ```bash
   cp .env.example .env
   ```

3. **Configure `.env`:**
   - `WORKER_URL`: full URL to your Worker (e.g., `https://trading.infragreen.app`)
   - `BRIDGE_TOKEN`: same value as the Worker secret
   - `TELEGRAM_API_ID` (optional): from https://my.telegram.org → API development tools
   - `TELEGRAM_API_HASH` (optional): from https://my.telegram.org → API development tools
   
   Without `TELEGRAM_API_ID` and `TELEGRAM_API_HASH`, WhatsApp continues to work normally and Telegram shows as unavailable.

4. **Install and start:**
   ```bash
   npm install
   npm start
   ```

5. **Or use Docker:**
   ```bash
   docker compose up -d
   ```

**Important:** Keep `bridge/auth/` persistent (mounted volume if using Docker) — it stores WhatsApp and Telegram session keys. Telegram session files are as sensitive as a logged-in device on Telegram Desktop. If you lose them, you must reconnect all accounts.

## Using the Dashboard

### Login & Account Setup

1. Open https://trading.infragreen.app
2. **Create an account:**
   - **Create account**: choose a username (3–32 letters, numbers, . _ -) and a password (≥ 8 characters)
   - **Invite Code**: required if `INVITE_CODE` secret is set (ask your admin for the code from the deploy output)
   - **Label**: optional, for your reference
   - The invite code is required to create an account (if `INVITE_CODE` is set); afterwards just sign in with username + password

### cTrader Account Setup

1. **Automation tab** → click **Connect with cTrader**
   - You'll be redirected to IC Markets cTrader login
   - Log in with your IC Markets username/password
   - Authorize waSignal to access your account (one-time)
   - Select **demo** or **live** trading account
2. The connection is now active; you can execute trades via signals

### Sources Setup (WhatsApp and/or Telegram)

1. **Sources tab** → connect one or both signal sources:

   **WhatsApp:**
   - Click **Connect**
   - Scan the QR code with your phone
   - Once connected, **choose a target chat** where trade signals are posted

   **Telegram:**
   - Click **Connect**
   - Scan the QR code with your Telegram app (Settings → Devices → Link Desktop Device)
   - If your account has 2-step verification enabled, enter the cloud password when prompted
   - Once connected, **choose a target channel or group** where trade signals are posted
   - Note: any channel or group you have joined can be a signal source

2. Each source has its own target chat/channel. Signals show a source badge and can be filtered by source.

### Testing Extraction

1. **Playground tab** → paste a sample signal text, e.g.:
   ```
   BUY AAPL
   Entry 150
   SL 148.5
   TP 152 153.5
   ```
2. See the extracted JSON (side, symbol, entry, SL, TPs, lot)
3. Click **Execute** to place a live trade (requires automation enabled + dry run off)

### Enable Automation

1. **Automation tab** → configure your rules:
   - **Automation enabled** — master switch (start disabled)
   - **Dry run** — when on, builds JSON but never calls cTrader (start on)
   - **Lot mode** — 'fixed' (use `fixedLot`) or 'signal' (extract lot from message)
   - **TP strategy** — 'first' (one position, first TP), 'last' (last TP), or 'split' (one position per TP)
   - **Min confidence** — reject extractions below this threshold (0–1)
   - **Symbol map** — alias translations (e.g., `GOLD` → `XAUUSD`)
   - **Allowed symbols** — whitelist; empty = allow all
2. **Start with dry run on** to verify signal processing
3. Disable dry run to enable live trade execution

## Running Costs

**Workers Free Plan** (sufficient for most users):
- **Worker requests**: 100,000/day free (bridge polling ~28,800/day + dashboard usage)
- **Queue operations**: 10,000/day free (~3,300 signals/day)
- **Workers AI**: 10,000 neurons/day free (text extraction ~1,000 neurons/signal = 10+ signals/day)

Typical monthly cost: **$0** on Workers Free plan.

If you outgrow the free tier, upgrade to **Workers Paid** ($5/mo), which includes significantly higher limits.

**cTrader Open API**: Free. Spread and commission charged by IC Markets (standard forex/CFD rates), not by Spotware.

**Baileys Bridge**: Runs on your own infrastructure (VPS/home server/Docker), no cost from waSignal.

### Cost Estimate (if on Paid plan)

Example: trading ~2 hours/day for 22 trading days/month = 44 total hours:

- **Workers**: 100k free requests/month + $0.50/million over = negligible
- **Queues**: 10k free ops/month + $0.01/million over = negligible
- **Workers AI**: 10k neurons/day free + $2.50/million over = likely $0–$1/month

**Total**: ~$5/month base + negligible overages for typical usage.

## Safety Notes

**Before Live Trading:**

- **Test on a demo account first.** The system is new; automation can fail unexpectedly.
- **Start with small position sizes** (e.g., 0.01 lot).
- **Enable dry run** and verify extraction accuracy before disabling it.
- **Set a symbol whitelist** to trade only approved pairs.
- **Set a high confidence threshold** (0.8+) to reject ambiguous signals.
- **Monitor for 24–48 hours** (at least one full trading session) before scaling up.

**Security & Risk Mitigation:**

- **Automation starts disabled + dry run on** by default.
- **Extraction confidence threshold** — set `minConfidence` high to reject ambiguous signals.
- **Target chat only** — signals from other chats are ignored.
- **Symbol whitelist** — use `allowedSymbols` to trade only approved pairs.
- **Encryption** — cTrader OAuth token is AES-GCM encrypted in the D1 database; never displayed in logs.
- **Multi-account isolation** — each user account is separate, with its own cTrader connection, WhatsApp session, and config.
- **Live account warnings** — dashboard highlights when you're connected to a live (not demo) account.

**External Terms of Service:**

- **WhatsApp ToS** — Baileys (unofficial WhatsApp Web) is not endorsed by Meta. Use at your own risk; accounts may be rate-limited or suspended. See https://www.baileys.so for details.
- **Telegram ToS** — Telegram user sessions (GramJS/MTProto) are subject to Telegram's terms of service. The bridge logs in as a user, not a bot, so review Telegram's policies on automated access. Session files are as sensitive as a logged-in Telegram Desktop device — keep them private and backed up.
- **Broker ToS** — automating trades may violate your broker's terms of service. Check with IC Markets and your broker before deploying live.

**Getting Started Safely:**

1. Deploy to a **demo IC Markets account** with small balance
2. Log in, enable dry run, connect WhatsApp
3. Send test signals to the target chat and verify extraction in the logs
4. Once confident in extraction accuracy, disable dry run on a **small fixed lot** (e.g., 0.01)
5. Monitor for 24–48 hours before scaling up
6. Check the **Costs tab** to monitor resource usage and expenses
