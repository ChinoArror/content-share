CREATE TABLE IF NOT EXISTS user_ui_settings (username TEXT PRIMARY KEY, settings_json TEXT NOT NULL, updated_at TEXT NOT NULL);
CREATE INDEX IF NOT EXISTS idx_users_uuid ON users(uuid);
