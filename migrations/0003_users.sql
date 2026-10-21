-- Username + password accounts (replaces the access-key login). Production had 0 accounts.
PRAGMA defer_foreign_keys = true;

CREATE TABLE accounts_new (
  id TEXT PRIMARY KEY,
  username TEXT NOT NULL UNIQUE COLLATE NOCASE,
  password_hash TEXT NOT NULL,
  session_version INTEGER NOT NULL DEFAULT 1,
  failed_logins INTEGER NOT NULL DEFAULT 0,
  locked_until INTEGER,
  created_at INTEGER NOT NULL,
  last_login_at INTEGER
);

DROP TABLE accounts;
ALTER TABLE accounts_new RENAME TO accounts;
