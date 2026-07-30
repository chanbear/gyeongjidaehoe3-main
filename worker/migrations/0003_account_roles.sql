ALTER TABLE users
  ADD COLUMN role TEXT NOT NULL DEFAULT 'senior'
  CHECK(role IN ('senior', 'guardian'));

ALTER TABLE guardian_links
  ADD COLUMN guardian_user_id INTEGER REFERENCES users(id);

CREATE INDEX IF NOT EXISTS idx_guardian_links_user
  ON guardian_links(guardian_user_id, active, last_seen_at);
