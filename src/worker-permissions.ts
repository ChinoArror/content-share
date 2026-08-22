import {
  PERMISSION_KEYS,
  PolicyError,
  type PermissionKey,
  type PermissionSet,
  type UserAccessProfile,
} from './permission-policy';

type AccessProfileRow = {
  username: string;
  role: string;
  group_name: string;
  quota_bytes: number;
  used_bytes: number;
  reserved_bytes: number;
} & Record<PermissionKey, number>;

export type StorageReservationInput = {
  id: string;
  username: string;
  contentId: string;
  bytes: number;
  expiresAt: string;
};

export async function ensureUserGroup(db: D1Database, username: string, _jwtRole: string): Promise<void> {
  const group = await db.prepare(
    'SELECT id FROM permission_groups WHERE is_default = 1 LIMIT 1'
  ).first<{ id: string }>();
  if (!group) throw new PolicyError('PERMISSION_GROUP_NOT_FOUND', 500);
  await db.prepare(
    'UPDATE users SET permission_group_id = ?1 WHERE username = ?2 AND permission_group_id IS NULL'
  ).bind(group.id, username).run();
}

export async function loadUserAccessProfile(db: D1Database, username: string): Promise<UserAccessProfile> {
  const row = await db.prepare(
    `SELECT
      u.username,
      u.role,
      p.name AS group_name,
      p.can_public_publish,
      p.can_api,
      p.can_internal_access,
      p.can_upload,
      p.can_comment,
      p.quota_bytes,
      COALESCE((
        SELECT SUM(COALESCE(c.file_size, 0) + COALESCE(c.text_size, 0))
        FROM contents c
        WHERE c.owner_username = u.username
      ), 0) AS used_bytes,
      COALESCE((
        SELECT SUM(r.bytes)
        FROM storage_reservations r
        WHERE r.owner_username = u.username
          AND r.status = 'active'
          AND julianday(r.expires_at) > julianday('now')
      ), 0) AS reserved_bytes
    FROM users u
    JOIN permission_groups p ON p.id = u.permission_group_id
    WHERE u.username = ?1`
  ).bind(username).first<AccessProfileRow>();
  if (!row) throw new PolicyError('PERMISSION_GROUP_NOT_FOUND', 403);

  const permissions = Object.fromEntries(
    PERMISSION_KEYS.map((key) => [key, Boolean(row[key])])
  ) as PermissionSet;
  return {
    username: row.username,
    role: row.role,
    groupName: row.group_name,
    permissions,
    quota_bytes: Number(row.quota_bytes),
    used_bytes: Number(row.used_bytes),
    reserved_bytes: Number(row.reserved_bytes),
  };
}

export function requireBusinessPermission(profile: UserAccessProfile, key: PermissionKey): void {
  if (!profile.permissions[key]) throw new PolicyError('PERMISSION_REQUIRED', 403);
}

export async function reserveStorage(db: D1Database, input: StorageReservationInput): Promise<string | null> {
  if (input.bytes === 0) return null;
  if (!Number.isInteger(input.bytes) || input.bytes < 0) {
    throw new PolicyError('STORAGE_QUOTA_EXCEEDED', 413, { requested_bytes: input.bytes });
  }

  const result = await db.prepare(
    `INSERT INTO storage_reservations (
      id, owner_username, content_id, bytes, status, expires_at, created_at, updated_at
    )
    SELECT ?1, ?2, ?3, ?4, 'active', ?5, datetime('now'), datetime('now')
    WHERE EXISTS (
      SELECT 1
      FROM users u
      JOIN permission_groups p ON p.id = u.permission_group_id
      WHERE u.username = ?2
        AND p.can_upload = 1
        AND p.quota_bytes >=
          (SELECT COALESCE(SUM(COALESCE(c.file_size, 0) + COALESCE(c.text_size, 0)), 0) FROM contents c WHERE c.owner_username = ?2) +
          (SELECT COALESCE(SUM(r.bytes), 0) FROM storage_reservations r
            WHERE r.owner_username = ?2
              AND r.status = 'active'
              AND julianday(r.expires_at) > julianday('now')) +
          ?4
    )`
  ).bind(input.id, input.username, input.contentId, input.bytes, input.expiresAt).run();
  if (!result.meta.changes) {
    throw new PolicyError('STORAGE_QUOTA_EXCEEDED', 413, { requested_bytes: input.bytes });
  }
  return input.id;
}

export async function releaseStorageReservation(db: D1Database, reservationId: string): Promise<void> {
  await db.prepare(
    "UPDATE storage_reservations SET status = 'released', released_at = datetime('now'), updated_at = datetime('now') WHERE id = ?1 AND status = 'active'"
  ).bind(reservationId).run();
}
