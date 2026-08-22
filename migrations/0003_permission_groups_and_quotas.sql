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

INSERT OR IGNORE INTO permission_groups (
  id, name, is_system, is_default, can_public_publish, can_api,
  can_internal_access, can_upload, quota_bytes, can_comment, created_at, updated_at
) VALUES
  ('permission-group-user', 'user', 1, 1, 1, 1, 1, 1, 5368709120, 1, datetime('now'), datetime('now')),
  ('permission-group-admin', 'admin', 1, 0, 1, 1, 1, 1, 107374182400, 1, datetime('now'), datetime('now'));

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

ALTER TABLE users ADD COLUMN permission_group_id TEXT REFERENCES permission_groups(id);

UPDATE users
SET permission_group_id = CASE WHEN role = 'admin'
  THEN 'permission-group-admin'
  ELSE 'permission-group-user'
END
WHERE permission_group_id IS NULL;

CREATE TRIGGER IF NOT EXISTS users_assign_default_permission_group
AFTER INSERT ON users
WHEN NEW.permission_group_id IS NULL
BEGIN
  UPDATE users
  SET permission_group_id = 'permission-group-user'
  WHERE id = NEW.id AND permission_group_id IS NULL;
END;

CREATE INDEX IF NOT EXISTS idx_users_permission_group ON users(permission_group_id);

ALTER TABLE contents ADD COLUMN text_size INTEGER NOT NULL DEFAULT 0;

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

CREATE INDEX IF NOT EXISTS idx_storage_reservations_owner_status
  ON storage_reservations(owner_username, status);
CREATE INDEX IF NOT EXISTS idx_storage_reservations_expiry
  ON storage_reservations(status, expires_at);

ALTER TABLE api_keys ADD COLUMN locked_at TEXT;
ALTER TABLE api_keys ADD COLUMN lock_reason TEXT;
ALTER TABLE api_keys ADD COLUMN locked_by TEXT;
