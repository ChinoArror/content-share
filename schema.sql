CREATE TABLE IF NOT EXISTS permission_groups (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL UNIQUE,
  is_system INTEGER NOT NULL DEFAULT 0 CHECK (is_system IN (0, 1)),
  is_default INTEGER NOT NULL DEFAULT 0 CHECK (is_default IN (0, 1)),
  can_public_publish INTEGER NOT NULL DEFAULT 0 CHECK (can_public_publish IN (0, 1)),
  can_api INTEGER NOT NULL DEFAULT 0 CHECK (can_api IN (0, 1)),
  can_internal_access INTEGER NOT NULL DEFAULT 0 CHECK (can_internal_access IN (0, 1)),
  can_upload INTEGER NOT NULL DEFAULT 0 CHECK (can_upload IN (0, 1)),
  quota_bytes INTEGER NOT NULL DEFAULT 0 CHECK (quota_bytes >= 0),
  can_comment INTEGER NOT NULL DEFAULT 0 CHECK (can_comment IN (0, 1)),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_permission_groups_single_default
  ON permission_groups(is_default)
  WHERE is_default = 1;

CREATE TRIGGER IF NOT EXISTS permission_groups_protect_system_name
BEFORE UPDATE OF name ON permission_groups
WHEN OLD.is_system = 1 AND NEW.name <> OLD.name
BEGIN
  SELECT RAISE(ABORT, 'system permission groups cannot be changed');
END;

CREATE TRIGGER IF NOT EXISTS permission_groups_protect_system_flag
BEFORE UPDATE OF is_system ON permission_groups
WHEN OLD.is_system = 1 AND NEW.is_system <> OLD.is_system
BEGIN
  SELECT RAISE(ABORT, 'system permission groups cannot be changed');
END;

CREATE TRIGGER IF NOT EXISTS permission_groups_protect_system_delete
BEFORE DELETE ON permission_groups
WHEN OLD.is_system = 1
BEGIN
  SELECT RAISE(ABORT, 'system permission groups cannot be changed');
END;

CREATE TABLE IF NOT EXISTS users (
  id TEXT PRIMARY KEY,
  uuid TEXT,
  username TEXT NOT NULL UNIQUE,
  name TEXT,
  role TEXT NOT NULL DEFAULT 'user',
  avatar_url TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  last_login_at TEXT,
  permission_group_id TEXT NOT NULL DEFAULT 'permission-group-user' REFERENCES permission_groups(id)
);

CREATE TRIGGER IF NOT EXISTS users_assign_default_permission_group
AFTER INSERT ON users
WHEN NEW.permission_group_id IS NULL
BEGIN
  UPDATE users
  SET permission_group_id = 'permission-group-user'
  WHERE id = NEW.id AND permission_group_id IS NULL;
END;

CREATE TRIGGER IF NOT EXISTS users_reject_null_permission_group
BEFORE UPDATE OF permission_group_id ON users
WHEN NEW.permission_group_id IS NULL
BEGIN
  SELECT RAISE(ABORT, 'users must have a permission group');
END;

CREATE TABLE IF NOT EXISTS contents (
  id TEXT PRIMARY KEY,
  owner_username TEXT NOT NULL,
  title TEXT NOT NULL,
  slug TEXT NOT NULL UNIQUE,
  type TEXT NOT NULL CHECK (type IN ('text','file','mixed')),
  format TEXT NOT NULL DEFAULT 'plain',
  text_content TEXT,
  text_size INTEGER NOT NULL DEFAULT 0,
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
  etag TEXT,
  created_at TEXT NOT NULL,
  completed_at TEXT,
  FOREIGN KEY (content_id) REFERENCES contents(id)
);

CREATE TABLE IF NOT EXISTS storage_reservations (
  id TEXT PRIMARY KEY,
  owner_username TEXT NOT NULL,
  content_id TEXT NOT NULL,
  bytes INTEGER NOT NULL CHECK (bytes > 0),
  status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'released', 'expired')),
  expires_at TEXT NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  released_at TEXT,
  FOREIGN KEY (content_id) REFERENCES contents(id)
);

CREATE TABLE IF NOT EXISTS upload_sessions (
  id TEXT PRIMARY KEY,
  content_id TEXT NOT NULL,
  attachment_id TEXT NOT NULL UNIQUE,
  owner_username TEXT NOT NULL,
  object_key TEXT NOT NULL UNIQUE,
  filename TEXT NOT NULL,
  content_type TEXT NOT NULL,
  size INTEGER NOT NULL,
  mode TEXT NOT NULL CHECK (mode IN ('single','multipart')),
  upload_id TEXT,
  expected_parts INTEGER NOT NULL DEFAULT 1,
  completed_parts INTEGER NOT NULL DEFAULT 0,
  uploaded_bytes INTEGER NOT NULL DEFAULT 0,
  status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','uploading','completing','completed','failed','cancelled','expired')),
  etag TEXT,
  source TEXT NOT NULL DEFAULT 'web' CHECK (source IN ('web','cli')),
  file_fingerprint TEXT,
  expires_at TEXT NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  last_activity_at TEXT NOT NULL,
  completed_at TEXT,
  FOREIGN KEY (content_id) REFERENCES contents(id),
  FOREIGN KEY (attachment_id) REFERENCES attachments(id)
);

CREATE TABLE IF NOT EXISTS upload_parts (
  session_id TEXT NOT NULL,
  part_number INTEGER NOT NULL,
  etag TEXT NOT NULL,
  size INTEGER NOT NULL,
  completed_at TEXT NOT NULL,
  PRIMARY KEY (session_id, part_number),
  FOREIGN KEY (session_id) REFERENCES upload_sessions(id)
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
  revoked_at TEXT,
  locked_at TEXT,
  lock_reason TEXT,
  locked_by TEXT
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
CREATE INDEX IF NOT EXISTS idx_users_permission_group ON users(permission_group_id);
CREATE INDEX IF NOT EXISTS idx_storage_reservations_owner_status ON storage_reservations(owner_username, status);
CREATE INDEX IF NOT EXISTS idx_storage_reservations_expiry ON storage_reservations(status, expires_at);
CREATE INDEX IF NOT EXISTS idx_upload_sessions_content ON upload_sessions(content_id);
CREATE INDEX IF NOT EXISTS idx_upload_sessions_owner ON upload_sessions(owner_username, created_at);
CREATE INDEX IF NOT EXISTS idx_upload_sessions_object ON upload_sessions(object_key);
CREATE INDEX IF NOT EXISTS idx_upload_sessions_resume ON upload_sessions(owner_username, file_fingerprint, size, status, last_activity_at);
CREATE INDEX IF NOT EXISTS idx_access_logs_created ON access_logs(created_at);
CREATE INDEX IF NOT EXISTS idx_api_keys_owner ON api_keys(owner_username);
CREATE INDEX IF NOT EXISTS idx_content_notes_content ON content_notes(content_id, created_at);
CREATE INDEX IF NOT EXISTS idx_content_notes_parent ON content_notes(parent_id);

INSERT OR IGNORE INTO permission_groups (
  id, name, is_system, is_default, can_public_publish, can_api,
  can_internal_access, can_upload, quota_bytes, can_comment, created_at, updated_at
) VALUES
  ('permission-group-user', 'user', 1, 1, 1, 1, 1, 1, 5368709120, 1, datetime('now'), datetime('now')),
  ('permission-group-admin', 'admin', 1, 0, 1, 1, 1, 1, 107374182400, 1, datetime('now'), datetime('now'));

UPDATE users
SET permission_group_id = CASE WHEN role = 'admin'
  THEN 'permission-group-admin'
  ELSE 'permission-group-user'
END
WHERE permission_group_id IS NULL;
