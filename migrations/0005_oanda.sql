-- OANDA v20 REST as a second broker. Personal access token stored AES-GCM encrypted.
CREATE TABLE oanda_auth (
  account_id TEXT PRIMARY KEY REFERENCES accounts(id) ON DELETE CASCADE,
  token_enc TEXT NOT NULL,
  environment TEXT NOT NULL,                 -- 'practice' | 'live'
  accounts_json TEXT NOT NULL DEFAULT '[]',  -- JSON OandaAccount[]
  selected_account_id TEXT,
  updated_at INTEGER NOT NULL
);
