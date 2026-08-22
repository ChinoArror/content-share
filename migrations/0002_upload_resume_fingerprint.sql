ALTER TABLE upload_sessions ADD COLUMN file_fingerprint TEXT;
ALTER TABLE upload_sessions ADD COLUMN last_activity_at TEXT;

UPDATE upload_sessions
SET last_activity_at = COALESCE(updated_at, created_at)
WHERE last_activity_at IS NULL;

CREATE INDEX IF NOT EXISTS idx_upload_sessions_resume
  ON upload_sessions(owner_username, file_fingerprint, size, status, last_activity_at);
