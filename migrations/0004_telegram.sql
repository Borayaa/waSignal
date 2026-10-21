-- Telegram (MTProto user session via the bridge) as a second signal source.
CREATE TABLE tg_state (
  account_id TEXT PRIMARY KEY REFERENCES accounts(id) ON DELETE CASCADE,
  status TEXT NOT NULL DEFAULT 'disconnected',
  qr TEXT,
  user_label TEXT,
  desired TEXT NOT NULL DEFAULT 'disconnected',
  target_chat_id TEXT,
  target_chat_name TEXT,
  password_enc TEXT,
  error TEXT,
  bridge_seen_at INTEGER,
  updated_at INTEGER NOT NULL
);

CREATE TABLE tg_chats (
  account_id TEXT NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  chat_id TEXT NOT NULL,
  name TEXT,
  kind TEXT NOT NULL DEFAULT 'group',
  updated_at INTEGER NOT NULL,
  PRIMARY KEY (account_id, chat_id)
);

ALTER TABLE signals ADD COLUMN source TEXT NOT NULL DEFAULT 'whatsapp';

INSERT INTO tg_state (account_id, updated_at) SELECT id, unixepoch() * 1000 FROM accounts;
