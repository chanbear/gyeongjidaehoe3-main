CREATE TABLE IF NOT EXISTS guardian_pair_codes (
  senior_user_id INTEGER PRIMARY KEY REFERENCES users(id),
  code_hash TEXT NOT NULL,
  code_salt TEXT NOT NULL,
  expires_at TEXT NOT NULL,
  failed_attempts INTEGER DEFAULT 0,
  created_at TEXT DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS guardian_links (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  senior_user_id INTEGER NOT NULL REFERENCES users(id),
  guardian_name TEXT DEFAULT '',
  guardian_phone TEXT DEFAULT '',
  token_hash TEXT UNIQUE NOT NULL,
  notification_enabled INTEGER DEFAULT 1,
  active INTEGER DEFAULT 1,
  created_at TEXT DEFAULT (datetime('now')),
  last_seen_at TEXT,
  UNIQUE(senior_user_id, guardian_phone)
);

CREATE TABLE IF NOT EXISTS guardian_message_reads (
  link_id INTEGER NOT NULL REFERENCES guardian_links(id),
  message_id TEXT NOT NULL,
  read_at TEXT DEFAULT (datetime('now')),
  PRIMARY KEY(link_id, message_id)
);
