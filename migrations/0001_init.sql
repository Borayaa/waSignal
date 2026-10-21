-- One row per dashboard account. The MetaTrader API key is the login password.
CREATE TABLE accounts (
  id TEXT PRIMARY KEY,                 -- random uuid
  key_hash TEXT NOT NULL UNIQUE,       -- sha256 hex of the API key (login lookup)
  api_key_enc TEXT NOT NULL,           -- AES-GCM encrypted API key (used for trading while user is offline)
  key_preview TEXT NOT NULL,           -- e.g. "abcd…wxyz"
  label TEXT,
  created_at INTEGER NOT NULL,         -- unix ms
  last_login_at INTEGER
);

-- Automation config (JSON AutomationConfig) + MT login credentials.
CREATE TABLE settings (
  account_id TEXT PRIMARY KEY REFERENCES accounts(id) ON DELETE CASCADE,
  config TEXT NOT NULL DEFAULT '{}',
  mt_login TEXT,
  mt_password_enc TEXT,
  mt_server TEXT,
  updated_at INTEGER NOT NULL
);

-- Cached MetaTrader API session per account.
CREATE TABLE mt_sessions (
  account_id TEXT PRIMARY KEY REFERENCES accounts(id) ON DELETE CASCADE,
  session_id TEXT NOT NULL,
  expires_at INTEGER NOT NULL          -- unix ms
);

-- WhatsApp (Baileys bridge) state per account.
CREATE TABLE wa_state (
  account_id TEXT PRIMARY KEY REFERENCES accounts(id) ON DELETE CASCADE,
  status TEXT NOT NULL DEFAULT 'disconnected',  -- WaStatus
  qr TEXT,                                      -- data:image/png;base64,... while status = 'qr'
  phone TEXT,
  desired TEXT NOT NULL DEFAULT 'disconnected', -- WaDesired
  target_chat_id TEXT,
  target_chat_name TEXT,
  bridge_seen_at INTEGER,
  updated_at INTEGER NOT NULL
);

CREATE TABLE wa_chats (
  account_id TEXT NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  chat_id TEXT NOT NULL,
  name TEXT,
  is_group INTEGER NOT NULL DEFAULT 0,
  updated_at INTEGER NOT NULL,
  PRIMARY KEY (account_id, chat_id)
);

-- Every message received from the target chat and what happened to it.
CREATE TABLE signals (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  account_id TEXT NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  wa_message_id TEXT NOT NULL,
  chat_id TEXT NOT NULL,
  sender TEXT,
  text TEXT NOT NULL,
  received_at INTEGER NOT NULL,        -- unix ms
  extraction TEXT,                     -- JSON ExtractionResult
  signal TEXT,                         -- JSON TradeSignal (structured JSON sent to MetaTrader)
  status TEXT NOT NULL,                -- SignalStatus
  reason TEXT,
  UNIQUE (account_id, wa_message_id)
);
CREATE INDEX idx_signals_account_time ON signals(account_id, received_at DESC);

-- Every MetaTrader API trade call.
CREATE TABLE trades (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  account_id TEXT NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  signal_id INTEGER REFERENCES signals(id) ON DELETE SET NULL,
  action TEXT NOT NULL,                -- 'open' | 'close' | 'modify'
  request TEXT NOT NULL,               -- JSON body sent
  response TEXT,                       -- JSON/text response
  ok INTEGER NOT NULL,
  ticket TEXT,
  created_at INTEGER NOT NULL
);
CREATE INDEX idx_trades_account_time ON trades(account_id, created_at DESC);
