import { describe, expect, it, vi } from 'vitest';
import worker from './worker';
import {
  ensureUserGroup,
  loadUserAccessProfile,
  requireBusinessPermission,
  releaseStorageReservation,
  reserveStorage,
} from './worker-permissions';

type RecordingOptions = {
  changes?: number;
  first?: unknown | ((sql: string) => unknown);
};

function recordingDb(options: RecordingOptions = {}) {
  const sql: string[] = [];
  const statement = (query: string) => ({
    bind: () => statement(query),
    first: async () => typeof options.first === 'function' ? options.first(query) : options.first ?? null,
    run: async () => ({ meta: { changes: options.changes ?? 1 } }),
    all: async () => ({ results: [] }),
  });
  return {
    sql,
    prepare(query: string) {
      sql.push(query);
      return statement(query);
    },
  } as unknown as D1Database & { sql: string[] };
}

describe('worker permission store', () => {
  it('assigns the default group only when a user has no group', async () => {
    const db = recordingDb({ first: { id: 'grp_user' } });

    await ensureUserGroup(db, 'alice', 'user');

    expect(db.sql.join('\n')).toContain('permission_group_id IS NULL');
    expect(db.sql.join('\n')).toContain('is_default = 1');
  });

  it('loads all retained content and only unexpired active reservations', async () => {
    const db = recordingDb({
      first: {
        username: 'alice', role: 'user', group_name: 'user',
        can_public_publish: 1, can_api: 0, can_internal_access: 1, can_upload: 1, can_comment: 0,
        quota_bytes: 1000, used_bytes: 700, reserved_bytes: 100,
      },
    });

    const profile = await loadUserAccessProfile(db, 'alice');

    expect(profile).toMatchObject({
      username: 'alice',
      groupName: 'user',
      permissions: { can_api: false, can_comment: false },
      used_bytes: 700,
      reserved_bytes: 100,
    });
    const query = db.sql.join('\n');
    expect(query).toContain('COALESCE(c.file_size, 0) + COALESCE(c.text_size, 0)');
    expect(query).not.toContain('c.status =');
    expect(query).toContain("r.status = 'active'");
    expect(query).toContain("julianday(r.expires_at) > julianday('now')");
  });

  it('uses one conditional insert to reserve storage', async () => {
    const db = recordingDb({ changes: 1 });

    const reservation = await reserveStorage(db, {
      id: 'res_1', username: 'alice', contentId: 'cnt_1', bytes: 1024, expiresAt: '2026-08-22T00:30:00.000Z',
    });

    expect(reservation).toBe('res_1');
    expect(db.sql.filter((sql) => sql.includes('INSERT INTO storage_reservations'))).toHaveLength(1);
    expect(db.sql[0]).toContain('p.can_upload = 1');
    expect(db.sql[0]).toContain("r.status = 'active'");
  });

  it('coalesces both nullable content byte columns in the reservation gate', async () => {
    const db = recordingDb({ changes: 1 });

    await reserveStorage(db, {
      id: 'res_1', username: 'alice', contentId: 'cnt_1', bytes: 1024, expiresAt: '2026-08-22T00:30:00.000Z',
    });

    expect(db.sql[0]).toContain('SUM(COALESCE(c.file_size, 0) + COALESCE(c.text_size, 0))');
    expect(db.sql[0]).not.toContain('SUM(c.file_size + c.text_size)');
  });

  it('does not create a reservation for a zero-byte payload', async () => {
    const db = recordingDb();

    await expect(reserveStorage(db, {
      id: 'res_1', username: 'alice', contentId: 'cnt_1', bytes: 0, expiresAt: '2026-08-22T00:30:00.000Z',
    })).resolves.toBeNull();
    expect(db.sql).toEqual([]);
  });

  it('releases only active reservations', async () => {
    const db = recordingDb();

    await releaseStorageReservation(db, 'res_1');

    expect(db.sql[0]).toContain("status = 'released'");
    expect(db.sql[0]).toContain("status = 'active'");
  });

  it('rejects an unavailable business permission', () => {
    expect(() => requireBusinessPermission({
      username: 'alice', role: 'user', groupName: 'user', quota_bytes: 0, used_bytes: 0, reserved_bytes: 0,
      permissions: { can_public_publish: true, can_api: false, can_internal_access: true, can_upload: true, can_comment: true },
    }, 'can_api')).toThrowError(expect.objectContaining({ code: 'PERMISSION_REQUIRED', status: 403 }));
  });

  it('keeps the legacy user payload while adding profile data to /api/me', async () => {
    const db = recordingDb({
      first: (sql: string) => sql.includes('FROM users u')
        ? {
            username: 'alice', role: 'user', group_name: 'user',
            can_public_publish: 1, can_api: 1, can_internal_access: 1, can_upload: 1, can_comment: 1,
            quota_bytes: 1000, used_bytes: 700, reserved_bytes: 100,
          }
        : { id: 'permission-group-user' },
    });
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response(JSON.stringify({ user: { username: 'alice', role: 'user' } }))));
    const env = {
      DB: db,
      SSO_URL: 'https://accounts.example.test',
      SSO_APP_ID: 'content-share',
      PUBLIC_BASE_URL: 'https://content.example.test',
    } as unknown as Parameters<typeof worker.fetch>[1];

    const response = await worker.fetch(
      new Request('https://content.example.test/api/me', { headers: { authorization: 'Bearer x.e30.x' } }),
      env,
      { waitUntil() {} } as unknown as ExecutionContext,
    );

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({
      ok: true,
      user: { username: 'alice', role: 'user' },
      group: 'user',
      permissions: { can_upload: true },
      storage: { used_bytes: 700, reserved_bytes: 100, quota_bytes: 1000, available_bytes: 200 },
    });
    vi.unstubAllGlobals();
  });

  it('rejects the admin username when its verified JWT role is user', async () => {
    const db = recordingDb({ first: { id: 'permission-group-user' } });
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response(JSON.stringify({ user: { username: 'admin', role: 'user' } }))));
    const env = {
      DB: db,
      SSO_URL: 'https://accounts.example.test',
      SSO_APP_ID: 'content-share',
      PUBLIC_BASE_URL: 'https://content.example.test',
    } as unknown as Parameters<typeof worker.fetch>[1];

    const response = await worker.fetch(
      new Request('https://content.example.test/api/admin/dashboard', { headers: { authorization: 'Bearer x.e30.x' } }),
      env,
      { waitUntil() {} } as unknown as ExecutionContext,
    );

    expect(response.status).toBe(403);
    await expect(response.json()).resolves.toMatchObject({ ok: false, message: 'Admin permission required' });
    vi.unstubAllGlobals();
  });
});
