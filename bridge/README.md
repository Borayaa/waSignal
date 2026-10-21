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
