# waSignal Baileys bridge

Connects WhatsApp accounts (one Baileys session per dashboard account) to the Cloudflare Worker dashboard. It polls `GET /api/bridge/sync` and reconciles sessions; it only makes outbound HTTPS requests, so it can run on any VPS or home server (no inbound ports).

## Run locally
    cp .env.example .env   # set BRIDGE_TOKEN
    npm install
    npm start              # tsx src/index.ts
    npm run typecheck

## Docker
    cp .env.example .env
    docker compose up -d --build

Credentials persist in `./auth/<accountId>` (mounted volume). Keep it private and backed up.

## Telegram (optional second signal source)
The bridge can also read Telegram channels/groups through a user session (GramJS/MTProto, not a bot).

1. Go to https://my.telegram.org -> API development tools, create an app, and put the values in `.env`:
   `TELEGRAM_API_ID=...` and `TELEGRAM_API_HASH=...`. Restart the bridge. Without them Telegram is reported as "unavailable" and WhatsApp keeps working.
2. In the dashboard click Connect Telegram, then in the Telegram app open Settings -> Devices -> Link Desktop Device and scan the QR code.
3. If the account has two-step verification (2FA), the dashboard asks for the cloud password; it is relayed once and never stored by the bridge. A wrong password re-prompts.
4. Pick the target chat in the dashboard; only new messages from it are forwarded.

Session strings are stored in `${AUTH_DIR}/tg-<accountId>.session` (mode 600). They grant full access to the Telegram account: treat them as secrets, never commit or share them. Logging out from the dashboard revokes the session and deletes the file.
