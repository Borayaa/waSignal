#!/usr/bin/env bash
# Deploy waSignal Trading to Cloudflare (trading.infragreen.app).
# Safe to re-run: reuses the D1 database, only applies new migrations and
# only generates secrets that don't exist yet (ENCRYPTION_KEY is never rotated).
# Connects trading signals to cTrader Open API (IC Markets).
#
# Usage: scripts/deploy.sh            # full setup + deploy
#        scripts/deploy.sh --no-deploy # set up D1 + migrations only
set -euo pipefail

DB_NAME="wasignal-trading"
WORKER_NAME="wasignal-trading"
SITE_URL="https://trading.infragreen.app"
SECRETS=(SESSION_SECRET ENCRYPTION_KEY BRIDGE_TOKEN INVITE_CODE CTRADER_CLIENT_ID CTRADER_CLIENT_SECRET)

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT"

say()  { printf '\033[1;36m==>\033[0m %s\n' "$*"; }
warn() { printf '\033[1;33m!!\033[0m %s\n' "$*"; }
die()  { printf '\033[1;31mxx\033[0m %s\n' "$*" >&2; exit 1; }

DEPLOY=1
[[ "${1:-}" == "--no-deploy" ]] && DEPLOY=0

command -v node >/dev/null || die "node is required"
command -v openssl >/dev/null || die "openssl is required"

say "Installing dependencies"
npm install --no-audit --no-fund >/dev/null

say "Checking Cloudflare login"
npx wrangler whoami 2>&1 | grep -q "You are logged in" || die "Not logged in. Run: npx wrangler login"

# ---------- D1 database ----------
db_id() {
  npx wrangler d1 list --json 2>/dev/null |
    node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{const db=JSON.parse(s).find(d=>d.name===process.argv[1]);process.stdout.write(db?db.uuid:"")})' "$DB_NAME"
}

DB_ID="$(db_id)"
if [[ -z "$DB_ID" ]]; then
  say "Creating D1 database $DB_NAME"
  npx wrangler d1 create "$DB_NAME" >/dev/null
  DB_ID="$(db_id)"
  [[ -n "$DB_ID" ]] || die "Could not find D1 database $DB_NAME after creating it"
else
  say "Using existing D1 database $DB_NAME ($DB_ID)"
fi

# Point wrangler.jsonc at the database (replaces TODO_DATABASE_ID or a stale id).
sed -i -E "s|(\"database_name\": \"$DB_NAME\", \"database_id\": \")[^\"]*\"|\1$DB_ID\"|" wrangler.jsonc
grep -q "\"database_id\": \"$DB_ID\"" wrangler.jsonc || die "Failed to write database_id into wrangler.jsonc"

say "Applying migrations (remote)"
CI=true npx wrangler d1 migrations apply "$DB_NAME" --remote

[[ $DEPLOY -eq 1 ]] || { say "Done (--no-deploy)"; exit 0; }

# ---------- Queue ----------
say "Checking Cloudflare Queue wasignal-signals"
QUEUE_EXISTS="$(npx wrangler queues list 2>/dev/null | grep -qw "wasignal-signals" && echo 1 || true)"
if [[ -z "$QUEUE_EXISTS" ]]; then
  say "Creating queue wasignal-signals"
  npx wrangler queues create wasignal-signals
else
  say "Queue wasignal-signals already exists"
fi

# ---------- Secrets ----------
# `secret list` fails before the first deploy; treat that as "no secrets yet".
EXISTING="$(npx wrangler secret list --name "$WORKER_NAME" --format json 2>/dev/null || echo '[]')"
has_secret() {
  node -e 'try{process.exit(JSON.parse(process.argv[1]).some(s=>s.name===process.argv[2])?0:1)}catch{process.exit(1)}' "$EXISTING" "$1"
}

SECRETS_FILE="$(mktemp)"
chmod 600 "$SECRETS_FILE"
trap 'rm -f "$SECRETS_FILE"' EXIT

NEW_BRIDGE_TOKEN=""
NEW_INVITE_CODE=""
for name in "${SECRETS[@]}"; do
  if has_secret "$name"; then
    say "Secret $name already set — keeping it"
    continue
  fi
  case "$name" in
    SESSION_SECRET) value="$(openssl rand -base64 48 | tr -d '\n')" ;;
    ENCRYPTION_KEY) value="$(openssl rand -base64 32 | tr -d '\n')" ;;
    BRIDGE_TOKEN)   value="$(openssl rand -hex 32)"; NEW_BRIDGE_TOKEN="$value" ;;
    INVITE_CODE)    value="$(openssl rand -hex 6)"; NEW_INVITE_CODE="$value" ;;
    CTRADER_CLIENT_ID)
      # Check env var first, then prompt if TTY, otherwise skip
      if [[ -n "${CTRADER_CLIENT_ID:-}" ]]; then
        value="$CTRADER_CLIENT_ID"
      elif [[ -t 0 ]]; then
        read -r -p "Enter cTrader Client ID (from https://openapi.ctrader.com → Applications): " value || value=""
      else
        value=""
      fi
      if [[ -z "$value" ]]; then
        warn "CTRADER_CLIENT_ID not provided. cTrader will not work until set with:"
        warn "  npx wrangler secret put CTRADER_CLIENT_ID"
        continue
      fi
      ;;
    CTRADER_CLIENT_SECRET)
      # Check env var first, then prompt if TTY, otherwise skip
      if [[ -n "${CTRADER_CLIENT_SECRET:-}" ]]; then
        value="$CTRADER_CLIENT_SECRET"
      elif [[ -t 0 ]]; then
        read -rs -p "Enter cTrader Client Secret (hidden): " value || value=""
        echo
      else
        value=""
      fi
      if [[ -z "$value" ]]; then
        warn "CTRADER_CLIENT_SECRET not provided. cTrader will not work until set with:"
        warn "  npx wrangler secret put CTRADER_CLIENT_SECRET"
        continue
      fi
      ;;
  esac
  [[ -z "$value" ]] && continue
  printf '%s=%s\n' "$name" "$value" >> "$SECRETS_FILE"
  say "Generated secret $name"
done

# ---------- Deploy ----------
say "Deploying Worker to $SITE_URL"
if [[ -s "$SECRETS_FILE" ]]; then
  npx wrangler deploy --secrets-file "$SECRETS_FILE"
else
  npx wrangler deploy
fi

# ---------- Landing page ----------
say "Deploying landing page to https://infragreen.app"
npx wrangler deploy -c landing/wrangler.jsonc

# ---------- Bridge config ----------
BRIDGE_ENV="bridge/.env"
if [[ -n "$NEW_BRIDGE_TOKEN" ]]; then
  [[ -f "$BRIDGE_ENV" ]] || cp bridge/.env.example "$BRIDGE_ENV"
  sed -i -E "s|^BRIDGE_TOKEN=.*|BRIDGE_TOKEN=$NEW_BRIDGE_TOKEN|; s|^WORKER_URL=.*|WORKER_URL=$SITE_URL|" "$BRIDGE_ENV"
  chmod 600 "$BRIDGE_ENV"
  say "Wrote BRIDGE_TOKEN to $BRIDGE_ENV (copy this file to the bridge host)"
elif ! grep -qE '^BRIDGE_TOKEN=.{16,}' "$BRIDGE_ENV" 2>/dev/null || grep -q '^BRIDGE_TOKEN=change-me' "$BRIDGE_ENV"; then
  warn "BRIDGE_TOKEN already exists in Cloudflare but $BRIDGE_ENV has no valid token."
  warn "Secrets can't be read back. Rotate it with:"
  warn "  T=\$(openssl rand -hex 32); echo \$T | npx wrangler secret put BRIDGE_TOKEN; sed -i \"s|^BRIDGE_TOKEN=.*|BRIDGE_TOKEN=\$T|\" $BRIDGE_ENV"
fi

# ---------- Smoke test ----------
say "Smoke test (custom domain certificates can take a few minutes on first deploy)"
for i in {1..12}; do
  code="$(curl -s -o /dev/null -w '%{http_code}' "$SITE_URL/api/me" || true)"
  if [[ "$code" == "401" ]]; then say "API is up ($SITE_URL/api/me → 401 as expected)"; break; fi
  [[ $i -eq 12 ]] && warn "API not reachable yet (last status: $code). Check again in a few minutes."
  sleep 5
done

say "Printing invite code and next steps..."
cat <<EOF

Deployed: $SITE_URL

Invite code for creating accounts: ${NEW_INVITE_CODE:-(existing code, not shown)}

Next steps:
  1. Set up cTrader Open API (if not already done):
       - Create an app at https://openapi.ctrader.com → Applications
       - Redirect URI: $SITE_URL/api/ctrader/callback
       - Scope: trading (and other required scopes)
       - Note: Spotware may require approval for new apps (check in 1–2 business days)
       - Once approved, you'll have Client ID and Secret
  2. Set cTrader credentials in Cloudflare (if not already set during deploy):
       npx wrangler secret put CTRADER_CLIENT_ID
       npx wrangler secret put CTRADER_CLIENT_SECRET
  3. Start the bridge (on this machine or any server, copy bridge/ incl. bridge/.env):
       - For WhatsApp only: cd bridge && docker compose up -d    # or: npm install && npm start
       - For Telegram support (optional): set TELEGRAM_API_ID and TELEGRAM_API_HASH in bridge/.env
         (get them from https://my.telegram.org → API development tools)
  4. Open $SITE_URL, create an account:
       - Create account: choose a username and password (≥ 8 characters)
       - Invite Code: ${NEW_INVITE_CODE:-(from above)}
  5. Automation tab → click "Connect with cTrader" → log in with IC Markets credentials → select demo or live account.
  6. Sources tab → connect WhatsApp and/or Telegram, and choose your target chat/channel.
  7. Playground → test a signal. Keep Dry run on until results look right.
  8. Costs tab → check Workers/Queues/Workers AI usage (likely \$0 on Workers Free plan).
  9. Once verified with demo account, disable Dry run to enable live trading on your chosen account.
EOF
