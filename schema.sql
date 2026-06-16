CREATE TABLE IF NOT EXISTS users (
  id TEXT PRIMARY KEY,
  uuid TEXT,
  username TEXT NOT NULL UNIQUE,
  name TEXT,
  role TEXT NOT NULL DEFAULT 'user',
  avatar_url TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  last_login_at TEXT
);

CREATE TABLE IF NOT EXISTS contents (
  id TEXT PRIMARY KEY,
  owner_username TEXT NOT NULL,
  title TEXT NOT NULL,
  slug TEXT NOT NULL UNIQUE,
  type TEXT NOT NULL CHECK (type IN ('text','file','mixed')),
  format TEXT NOT NULL DEFAULT 'plain',
  text_content TEXT,
  visibility TEXT NOT NULL CHECK (visibility IN ('public','internal','private')),
  status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active','expired','deleted','processing')),
  password_hash TEXT,
  password_salt TEXT,
  expire_at TEXT,
  max_views INTEGER NOT NULL DEFAULT 0,
  view_count INTEGER NOT NULL DEFAULT 0,
  download_count INTEGER NOT NULL DEFAULT 0,
  file_size INTEGER NOT NULL DEFAULT 0,
  remark TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  deleted_at TEXT,
  forced_expired_at TEXT
);

CREATE TABLE IF NOT EXISTS attachments (
  id TEXT PRIMARY KEY,
  content_id TEXT NOT NULL,
  owner_username TEXT NOT NULL,
  object_key TEXT NOT NULL,
  filename TEXT NOT NULL,
  content_type TEXT,
  size INTEGER NOT NULL DEFAULT 0,
  status TEXT NOT NULL DEFAULT 'active',
  created_at TEXT NOT NULL,
  FOREIGN KEY (content_id) REFERENCES contents(id)
);

CREATE TABLE IF NOT EXISTS access_logs (
  id TEXT PRIMARY KEY,
  content_id TEXT NOT NULL,
  slug TEXT NOT NULL,
  username TEXT,
  action TEXT NOT NULL CHECK (action IN ('view','download','preview','denied')),
  ip TEXT,
  user_agent TEXT,
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS api_keys (
  id TEXT PRIMARY KEY,
  owner_username TEXT NOT NULL,
  remark TEXT,
  key_hash TEXT NOT NULL UNIQUE,
  key_prefix TEXT NOT NULL,
  key_suffix TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active','expired','revoked')),
  expire_at TEXT,
  last_used_at TEXT,
  usage_count INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL,
  revoked_at TEXT
);

CREATE TABLE IF NOT EXISTS api_key_usage_logs (
  id TEXT PRIMARY KEY,
  api_key_id TEXT NOT NULL,
  owner_username TEXT NOT NULL,
  endpoint TEXT NOT NULL,
  ip TEXT,
  user_agent TEXT,
  ok INTEGER NOT NULL,
  message TEXT,
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS user_cli_settings (
  username TEXT PRIMARY KEY,
  default_visibility TEXT NOT NULL DEFAULT 'public',
  default_expire_days INTEGER NOT NULL DEFAULT 0,
  default_max_views INTEGER NOT NULL DEFAULT 0,
  default_format TEXT NOT NULL DEFAULT 'markdown',
  default_endpoint TEXT NOT NULL DEFAULT 'https://content.aryuki.com',
  default_slug_mode TEXT NOT NULL DEFAULT 'random',
  updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS admin_actions (
  id TEXT PRIMARY KEY,
  admin_username TEXT NOT NULL,
  action TEXT NOT NULL,
  target_type TEXT NOT NULL,
  target_id TEXT NOT NULL,
  detail TEXT,
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS system_settings (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  updated_by TEXT
);

CREATE TABLE IF NOT EXISTS content_notes (
  id TEXT PRIMARY KEY,
  content_id TEXT NOT NULL,
  parent_id TEXT,
  author_username TEXT NOT NULL,
  body TEXT NOT NULL,
  visibility TEXT NOT NULL DEFAULT 'public' CHECK (visibility IN ('public','private')),
  mode TEXT NOT NULL DEFAULT 'comment' CHECK (mode IN ('comment','memo')),
  ip TEXT,
  ip_region TEXT,
  user_agent TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  deleted_at TEXT,
  FOREIGN KEY (content_id) REFERENCES contents(id),
  FOREIGN KEY (parent_id) REFERENCES content_notes(id)
);

CREATE INDEX IF NOT EXISTS idx_contents_owner ON contents(owner_username);
CREATE INDEX IF NOT EXISTS idx_contents_slug ON contents(slug);
CREATE INDEX IF NOT EXISTS idx_contents_created ON contents(created_at);
CREATE INDEX IF NOT EXISTS idx_attachments_content ON attachments(content_id);
CREATE INDEX IF NOT EXISTS idx_access_logs_created ON access_logs(created_at);
CREATE INDEX IF NOT EXISTS idx_api_keys_owner ON api_keys(owner_username);
CREATE INDEX IF NOT EXISTS idx_content_notes_content ON content_notes(content_id, created_at);
CREATE INDEX IF NOT EXISTS idx_content_notes_parent ON content_notes(parent_id);
