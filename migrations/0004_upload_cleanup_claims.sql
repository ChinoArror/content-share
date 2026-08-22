CREATE TABLE IF NOT EXISTS upload_cleanup_claims (
  content_id TEXT PRIMARY KEY,
  claim_token TEXT NOT NULL,
  claimed_at TEXT NOT NULL,
  expires_at TEXT NOT NULL,
  FOREIGN KEY (content_id) REFERENCES contents(id)
);

CREATE INDEX IF NOT EXISTS idx_upload_cleanup_claims_expiry
  ON upload_cleanup_claims(expires_at);
