-- cTrader Open API (IC Markets). Replaces the MetaTrader / Cloudflare Containers layer.

-- OAuth tokens + linked trading accounts per dashboard account.
CREATE TABLE ctrader_auth (
  account_id TEXT PRIMARY KEY REFERENCES accounts(id) ON DELETE CASCADE,
  access_token_enc TEXT NOT NULL,      -- AES-GCM encrypted
  refresh_token_enc TEXT NOT NULL,     -- AES-GCM encrypted
  expires_at INTEGER NOT NULL,         -- unix ms, access token expiry
  accounts_json TEXT NOT NULL DEFAULT '[]',  -- JSON CtraderAccount[]
  selected_ctid INTEGER,               -- chosen ctidTraderAccountId
  selected_is_live INTEGER,            -- 0 | 1
  updated_at INTEGER NOT NULL
);

-- Symbol / asset lookup cache per cTrader trading account (24 h TTL).
-- name = upper-cased symbol name, '#<symbolId>' for id lookups, '@asset:<assetId>' for deposit assets.
CREATE TABLE ctrader_symbols (
  ctid INTEGER NOT NULL,
  name TEXT NOT NULL,
  symbol_id INTEGER,
  details TEXT NOT NULL,               -- JSON
  updated_at INTEGER NOT NULL,
  PRIMARY KEY (ctid, name)
);

DROP TABLE mt_sessions;
