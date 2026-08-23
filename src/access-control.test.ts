import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { issueMediaTicket } from './media-ticket';
import worker from './worker';

type ProfileOverrides = Partial<{
  username: string;
  role: string;
  group_name: string;
  can_public_publish: number;
  can_api: number;
  can_internal_access: number;
  can_upload: number;
  can_comment: number;
  quota_bytes: number;
  used_bytes: number;
  reserved_bytes: number;
}>;

type TestDbOptions = {
  profile?: ProfileOverrides;
  ownerProfile?: ProfileOverrides;
  content?: Record<string, unknown>;
  attachment?: Record<string, unknown>;
  apiKey?: Record<string, unknown>;
  group?: Record<string, unknown>;
  replacementGroup?: Record<string, unknown>;
  existingGroupByName?: Record<string, unknown>;
  userExists?: boolean;
};

type RecordedStatement = {
  sql: string;
  values: unknown[];
  bind: (...values: unknown[]) => RecordedStatement;
  first: <T>() => Promise<T | null>;
  run: () => Promise<{ meta: { changes: number } }>;
  all: <T>() => Promise<{ results: T[] }>;
};

function profileRow(overrides: ProfileOverrides = {}) {
  return {
    username: 'alice',
    role: 'user',
    group_name: 'user',
    can_public_publish: 1,
    can_api: 1,
    can_internal_access: 1,
    can_upload: 1,
    can_comment: 1,
    quota_bytes: 1024 * 1024,
    used_bytes: 0,
    reserved_bytes: 0,
    ...overrides,
  };
}

function contentRow(overrides: Record<string, unknown> = {}) {
  return {
    id: 'cnt_1',
    owner_username: 'alice',
    title: 'Shared item',
    slug: 'shared-item',
    type: 'text',
    format: 'plain',
    text_content: 'hello',
    visibility: 'public',
    status: 'active',
    password_hash: null,
    password_salt: null,
    expire_at: null,
    max_views: 0,
    view_count: 0,
    download_count: 0,
    file_size: 0,
    remark: null,
    created_at: '2026-08-22T00:00:00.000Z',
    updated_at: '2026-08-22T00:00:00.000Z',
    ...overrides,
  };
}

function attachmentRow(overrides: Record<string, unknown> = {}) {
  return {
    id: 'att_1',
    content_id: 'cnt_1',
    owner_username: 'alice',
    object_key: 'alice/cnt_1/att_1-file.txt',
    filename: 'file.txt',
    content_type: 'text/plain',
    size: 5,
    status: 'active',
    etag: null,
    completed_at: null,
    created_at: '2026-08-22T00:00:00.000Z',
    ...overrides,
  };
}

function testDb(options: TestDbOptions = {}) {
  const prepared: RecordedStatement[] = [];
  const batches: RecordedStatement[][] = [];
  const currentProfile = profileRow(options.profile);
  const currentContent = options.content ? contentRow(options.content) : null;
  const currentAttachment = options.attachment ? attachmentRow(options.attachment) : null;

  function firstFor(sql: string, values: unknown[]): unknown {
    if (sql.includes('p.name AS group_name')) {
      return values[0] === 'alice' && options.ownerProfile ? profileRow(options.ownerProfile) : currentProfile;
    }
    if (sql.includes('FROM permission_groups WHERE is_default = 1')) return { id: 'permission-group-user' };
    if (sql.startsWith('SELECT * FROM contents WHERE slug')) return currentContent;
    if (sql.startsWith('SELECT * FROM contents WHERE id')) return currentContent;
    if (sql.startsWith('SELECT visibility FROM contents WHERE id')) return currentContent;
    if (sql.startsWith('SELECT id, owner_username, title, slug')) return currentContent;
    if (sql.startsWith('SELECT * FROM attachments WHERE id')) return currentAttachment;
    if (sql.startsWith('SELECT * FROM upload_sessions WHERE attachment_id')) return null;
    if (sql.startsWith('SELECT * FROM api_keys WHERE key_hash')) return options.apiKey || null;
    if (sql.startsWith('SELECT * FROM api_keys WHERE id')) return options.apiKey || null;
    if (sql.startsWith('SELECT * FROM permission_groups WHERE id')) {
      return values[0] === 'replacement' ? options.replacementGroup || null : options.group || null;
    }
    if (sql.startsWith('SELECT id FROM permission_groups WHERE id')) {
      return values[0] === 'replacement' ? options.replacementGroup || null : options.group || null;
    }
    if (sql.startsWith('SELECT id FROM permission_groups WHERE name')) return options.existingGroupByName || null;
    if (sql.startsWith('SELECT username FROM users WHERE username')) return options.userExists === false ? null : { username: values[0] };
    if (sql.startsWith('SELECT id FROM contents WHERE slug')) return null;
    if (sql.startsWith('SELECT id FROM content_notes')) return { id: 'note_1', content_id: 'cnt_1' };
    if (sql.startsWith('SELECT COUNT(*) count FROM upload_sessions')) return { count: 0 };
    if (sql.startsWith('SELECT COUNT(*) count, COALESCE(SUM(size)')) return { count: 0, bytes: 0 };
    return null;
  }

  function allFor(sql: string): unknown[] {
    if (sql.includes('FROM attachments') && currentAttachment) return [currentAttachment];
    if (sql.includes('FROM users u') && sql.includes('permission_group_name') && sql.includes('reserved_bytes')) {
      return [{
        username: 'alice',
        role: 'user',
        permission_group_id: 'group_1',
        permission_group_name: 'staff',
        used_bytes: 50,
        reserved_bytes: 10,
        quota_bytes: 100,
      }];
    }
    return [];
  }

  function statement(sql: string, values: unknown[] = []): RecordedStatement {
    const item: RecordedStatement = {
      sql,
      values,
      bind: (...nextValues: unknown[]) => statement(sql, nextValues),
      first: async <T>() => {
        executed.push(item);
        return firstFor(sql, values) as T | null;
      },
      run: async () => {
        executed.push(item);
        return { meta: { changes: 1 } };
      },
      all: async <T>() => {
        executed.push(item);
        return { results: allFor(sql) as T[] };
      },
    };
    return item;
  }

  const executed: RecordedStatement[] = [];
  const db = {
    prepared,
    executed,
    batches,
    prepare(sql: string) {
      const item = statement(sql);
      prepared.push(item);
      return item;
    },
    async batch(items: RecordedStatement[]) {
      batches.push(items);
      executed.push(...items);
      return items.map(() => ({ meta: { changes: 1 } }));
    },
  };
  return db as unknown as D1Database & {
    prepared: RecordedStatement[];
    executed: RecordedStatement[];
    batches: RecordedStatement[][];
  };
}

function env(db: D1Database) {
  return {
    DB: db,
    SSO_URL: 'https://accounts.example.test',
    SSO_APP_ID: 'content-share',
    MEDIA_TICKET_SECRET: 'media-secret',
    PUBLIC_BASE_URL: 'https://content.example.test',
    BUCKET: {
      head: vi.fn().mockResolvedValue(null),
      get: vi.fn().mockResolvedValue(null),
      put: vi.fn(),
      delete: vi.fn(),
      createMultipartUpload: vi.fn(),
      resumeMultipartUpload: vi.fn(),
    },
    UPLOAD_QUEUE: { send: vi.fn() },
    ASSETS: { fetch: vi.fn() },
  } as unknown as Parameters<typeof worker.fetch>[1];
}

function request(path: string, init: RequestInit = {}) {
  const headers = new Headers(init.headers);
  if (!headers.has('authorization')) headers.set('authorization', 'Bearer x.e30.x');
  if (init.body && typeof init.body === 'string' && !headers.has('content-type')) headers.set('content-type', 'application/json');
  return new Request(`https://content.example.test${path}`, { ...init, headers });
}

async function invoke(db: D1Database, path: string, init: RequestInit = {}) {
  return worker.fetch(request(path, init), env(db), { waitUntil() {} } as unknown as ExecutionContext);
}

async function errorBody(response: Response) {
  return response.json() as Promise<{ ok: false; message: string; code?: string; details?: Record<string, unknown> }>;
}

async function apiKeyHash(raw: string): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(`api-key:${raw}`));
  return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, '0')).join('');
}

describe('route-level business permissions', () => {
  beforeEach(() => {
    vi.stubGlobal('fetch', vi.fn().mockImplementation(async () => new Response(JSON.stringify({
      user: { id: 'usr_1', username: 'alice', role: 'user' },
    }))));
  });

  afterEach(() => vi.unstubAllGlobals());

  it('rejects a default-public text create without public-publish permission', async () => {
    const db = testDb({ profile: { can_public_publish: 0 } });

    const response = await invoke(db, '/api/contents/text', { method: 'POST', body: JSON.stringify({ content: 'hello' }) });

    expect(response.status).toBe(403);
    await expect(errorBody(response)).resolves.toMatchObject({ ok: false, code: 'PUBLIC_PUBLISH_PERMISSION_REQUIRED' });
  });

  it('rejects storage creation before direct-upload configuration is evaluated', async () => {
    const db = testDb({ profile: { can_upload: 0 } });

    const response = await invoke(db, '/api/uploads/initiate', {
      method: 'POST',
      body: JSON.stringify({ visibility: 'private', files: [{ name: 'a.txt', size: 5 }] }),
    });

    expect(response.status).toBe(403);
    await expect(errorBody(response)).resolves.toMatchObject({ ok: false, code: 'STORAGE_PERMISSION_REQUIRED' });
  });

  it('rejects creation when storage permission is enabled but quota is zero', async () => {
    const db = testDb({ profile: { can_upload: 1, quota_bytes: 0 } });

    const response = await invoke(db, '/api/contents/text', {
      method: 'POST',
      body: JSON.stringify({ visibility: 'private', content: 'hello' }),
    });

    expect(response.status).toBe(403);
    await expect(errorBody(response)).resolves.toMatchObject({ code: 'STORAGE_PERMISSION_REQUIRED' });
  });

  it.each(['text', 'file', 'direct', 'cli'])('enforces storage permission on %s creation', async (kind) => {
    const db = testDb({
      profile: { can_upload: 0 },
      apiKey: { id: 'key_1', owner_username: 'alice', status: 'active', expire_at: null, locked_at: null },
    });
    let path = '/api/contents/text';
    let body: BodyInit = JSON.stringify({ visibility: 'private', content: 'x' });
    if (kind === 'file') {
      path = '/api/contents/upload';
      const form = new FormData();
      form.set('visibility', 'private');
      form.set('file', new File(['hello'], 'a.txt', { type: 'text/plain' }));
      body = form;
    } else if (kind === 'direct') {
      path = '/api/uploads/initiate';
      body = JSON.stringify({ visibility: 'private', files: [{ name: 'a.txt', size: 5 }] });
    } else if (kind === 'cli') {
      path = '/api/cli/upload-text';
    }

    const response = await invoke(db, path, { method: 'POST', body });

    expect(response.status).toBe(403);
    await expect(errorBody(response)).resolves.toMatchObject({ code: 'STORAGE_PERMISSION_REQUIRED' });
  });

  it('rejects changing content or CLI defaults to public without publish permission', async () => {
    const db = testDb({
      profile: { can_public_publish: 0 },
      content: contentRow({ visibility: 'private' }),
    });

    const update = await invoke(db, '/api/contents/cnt_1', { method: 'PATCH', body: JSON.stringify({ visibility: 'public' }) });
    const settings = await invoke(db, '/api/settings/cli', { method: 'PATCH', body: JSON.stringify({ default_visibility: 'public' }) });

    expect(update.status).toBe(403);
    expect(settings.status).toBe(403);
    await expect(errorBody(update)).resolves.toMatchObject({ code: 'PUBLIC_PUBLISH_PERMISSION_REQUIRED' });
    await expect(errorBody(settings)).resolves.toMatchObject({ code: 'PUBLIC_PUBLISH_PERMISSION_REQUIRED' });
  });

  it.each([
    { label: 'title', body: { title: 'Updated title' } },
    { label: 'text', body: { text_content: 'Updated text' } },
  ])('rejects owner $label-only updates when the effective visibility remains public', async ({ body }) => {
    const db = testDb({
      profile: { can_public_publish: 0 },
      content: contentRow({ visibility: 'public' }),
    });

    const response = await invoke(db, '/api/contents/cnt_1', { method: 'PATCH', body: JSON.stringify(body) });

    expect(response.status).toBe(403);
    await expect(errorBody(response)).resolves.toMatchObject({ code: 'PUBLIC_PUBLISH_PERMISSION_REQUIRED' });
    expect(db.executed.some((item) => item.sql.startsWith('UPDATE contents SET title='))).toBe(false);
  });

  it.each([
    ['/api/share/shared-item', {}],
    ['/api/attachments/att_1/preview-info', {}],
    ['/api/attachments/att_1/download', {}],
  ])('rejects internal metadata and media route %s without internal permission', async (path, init) => {
    const db = testDb({
      profile: { can_internal_access: 0 },
      content: contentRow({ visibility: 'internal' }),
      attachment: attachmentRow(),
    });

    const response = await invoke(db, path, init);

    expect(response.status).toBe(403);
    await expect(errorBody(response)).resolves.toMatchObject({ ok: false, code: 'INTERNAL_ACCESS_PERMISSION_REQUIRED' });
  });

  it('does not let an internal media ticket bypass login and current permission', async () => {
    const content = contentRow({ visibility: 'internal' });
    const ticket = await issueMediaTicket('media-secret', {
      attachmentId: 'att_1',
      actor: 'alice',
      policyVersion: String(content.updated_at),
    });
    const db = testDb({ content, attachment: attachmentRow() });

    const response = await worker.fetch(
      new Request(`https://content.example.test/api/attachments/att_1/preview-info?media=${encodeURIComponent(ticket)}`),
      env(db),
      { waitUntil() {} } as unknown as ExecutionContext,
    );

    expect(response.status).toBe(401);
    await expect(errorBody(response)).resolves.toMatchObject({ code: 'LOGIN_REQUIRED' });
  });

  it('requires SSO before returning the configured administrator mailto address', async () => {
    const configuredEnv = { ...env(testDb()), ADMIN_CONTACT_EMAIL: 'admin@example.com' };
    const unauthenticated = await worker.fetch(
      new Request('https://content.example.test/api/public/admin-contact'),
      configuredEnv,
      { waitUntil() {} } as unknown as ExecutionContext,
    );
    expect(unauthenticated.status).toBe(401);

    const authenticated = await worker.fetch(
      request('/api/public/admin-contact'),
      configuredEnv,
      { waitUntil() {} } as unknown as ExecutionContext,
    );
    expect(authenticated.status).toBe(200);
    await expect(authenticated.json()).resolves.toMatchObject({
      ok: true,
      href: 'mailto:admin@example.com?subject=ShareWorker%20access%20request&body=Please%20help%20me%20access%20a%20ShareWorker%20share.',
    });
  });

  it.each([
    ['/api/share/shared-item', 'content'],
    ['/api/attachments/att_1/preview-info?media=', 'attachment-info'],
    ['/api/attachments/att_1/preview?media=', 'attachment-preview'],
    ['/api/attachments/att_1/download?media=', 'attachment-download'],
  ])('requires x-share-password for password content even with a valid ticket on %s', async (path, target) => {
    const content = contentRow({ password_hash: 'hash', password_salt: 'salt' });
    const db = testDb({ content, attachment: attachmentRow() });
    const ticket = await issueMediaTicket('media-secret', {
      attachmentId: target === 'content' ? 'content:cnt_1' : 'att_1',
      actor: 'alice',
      policyVersion: String(content.updated_at),
    });
    const requestPath = path.endsWith('media=') ? `${path}${encodeURIComponent(ticket)}` : path;
    const init: RequestInit = target === 'content' ? { headers: { 'x-share-ticket': ticket } } : {};

    const response = await invoke(db, requestPath, init);

    expect(response.status).toBe(423);
    await expect(errorBody(response)).resolves.toMatchObject({ code: 'PASSWORD_REQUIRED_OR_INCORRECT' });
  });

  it('does not emit reusable share or media tickets for password content', async () => {
    const password = 'secret';
    const passwordSalt = 'test-salt';
    const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(`${passwordSalt}:${password}`));
    const passwordHash = [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, '0')).join('');
    const db = testDb({
      content: contentRow({ password_hash: passwordHash, password_salt: passwordSalt }),
      attachment: attachmentRow(),
    });

    const response = await invoke(db, '/api/share/shared-item', { headers: { 'x-share-password': password } });

    expect(response.status).toBe(200);
    const body = await response.json() as { item: { share_ticket?: string; attachments: Array<{ media_ticket?: string }> } };
    expect(body.item.share_ticket).toBeUndefined();
    expect(body.item.attachments[0]?.media_ticket).toBeUndefined();
  });

  it('keeps comments readable while blocking comment and memo writes', async () => {
    const publicDb = testDb({ profile: { can_comment: 0 }, content: contentRow() });
    const privateDb = testDb({ profile: { can_comment: 0 }, content: contentRow({ visibility: 'private' }) });

    const list = await invoke(publicDb, '/api/share/shared-item/notes');
    const comment = await invoke(publicDb, '/api/share/shared-item/notes', { method: 'POST', body: JSON.stringify({ body: 'hello' }) });
    const memo = await invoke(privateDb, '/api/share/shared-item/notes', { method: 'POST', body: JSON.stringify({ body: 'memo' }) });

    expect(list.status).toBe(200);
    expect(comment.status).toBe(403);
    expect(memo.status).toBe(403);
    await expect(errorBody(comment)).resolves.toMatchObject({ code: 'COMMENT_PERMISSION_REQUIRED' });
    await expect(errorBody(memo)).resolves.toMatchObject({ code: 'COMMENT_PERMISSION_REQUIRED' });
  });

  it.each([
    { label: 'comment', visibility: 'public' },
    { label: 'private memo', visibility: 'private' },
  ])('requires comment permission to delete a $label after ownership authorization', async ({ visibility }) => {
    const db = testDb({
      profile: { can_comment: 0 },
      content: contentRow({ visibility }),
    });

    const response = await invoke(db, '/api/share/shared-item/notes/note_1', { method: 'DELETE' });

    expect(response.status).toBe(403);
    await expect(errorBody(response)).resolves.toMatchObject({ code: 'COMMENT_PERMISSION_REQUIRED' });
    expect(db.executed.some((item) => item.sql.startsWith('SELECT id FROM content_notes'))).toBe(false);
    expect(db.executed.some((item) => item.sql.startsWith('UPDATE content_notes'))).toBe(false);
  });

  it('requires API permission on user key management routes', async () => {
    const db = testDb({ profile: { can_api: 0 } });

    const response = await invoke(db, '/api/api-keys');

    expect(response.status).toBe(403);
    await expect(errorBody(response)).resolves.toMatchObject({ code: 'API_PERMISSION_REQUIRED' });
  });

  it('does not let the admin business group elevate a user JWT into admin routes', async () => {
    const db = testDb({ profile: { role: 'user', group_name: 'admin' } });

    const response = await invoke(db, '/api/admin/permission-groups');

    expect(response.status).toBe(403);
    await expect(errorBody(response)).resolves.toMatchObject({ message: 'Admin permission required' });
  });

  it('allows an API-enabled owner to revoke a locked key without unlocking it', async () => {
    const db = testDb({
      apiKey: { id: 'key_1', owner_username: 'alice', status: 'active', expire_at: null, locked_at: '2026-08-22T00:00:00.000Z' },
    });

    const response = await invoke(db, '/api/api-keys/key_1/revoke', { method: 'POST' });

    expect(response.status).toBe(200);
    expect(db.prepared.some((item) => item.sql.includes('SET status="revoked"'))).toBe(true);
  });

  it('checks expiry, explicit lock, then current API permission for CLI auth', async () => {
    const expiredDb = testDb({
      profile: { can_api: 0 },
      apiKey: { id: 'key_1', owner_username: 'alice', status: 'active', expire_at: '2000-01-01T00:00:00.000Z', locked_at: '2026-08-22T00:00:00.000Z' },
    });
    const lockedDb = testDb({
      profile: { can_api: 0 },
      apiKey: { id: 'key_1', owner_username: 'alice', status: 'active', expire_at: null, locked_at: '2026-08-22T00:00:00.000Z' },
    });
    const deniedDb = testDb({
      profile: { can_api: 0 },
      apiKey: { id: 'key_1', owner_username: 'alice', status: 'active', expire_at: null, locked_at: null },
    });

    const expired = await invoke(expiredDb, '/api/cli/upload-text', { method: 'POST', body: JSON.stringify({ visibility: 'private', content: 'x' }) });
    const locked = await invoke(lockedDb, '/api/cli/upload-text', { method: 'POST', body: JSON.stringify({ visibility: 'private', content: 'x' }) });
    const denied = await invoke(deniedDb, '/api/cli/upload-text', { method: 'POST', body: JSON.stringify({ visibility: 'private', content: 'x' }) });

    await expect(errorBody(expired)).resolves.toMatchObject({ code: 'API_KEY_EXPIRED' });
    await expect(errorBody(locked)).resolves.toMatchObject({ code: 'API_KEY_LOCKED' });
    await expect(errorBody(denied)).resolves.toMatchObject({ code: 'API_PERMISSION_REQUIRED' });
    expect(deniedDb.prepared.some((item) => item.sql.includes('SET locked_at'))).toBe(true);
  });

  it('treats an already-expired key as expired even when lock metadata is present', async () => {
    const db = testDb({
      apiKey: { id: 'key_1', owner_username: 'alice', status: 'expired', expire_at: null, locked_at: '2026-08-22T00:00:00.000Z' },
    });

    const response = await invoke(db, '/api/cli/upload-text', { method: 'POST', body: JSON.stringify({ visibility: 'private', content: 'x' }) });

    expect(response.status).toBe(401);
    await expect(errorBody(response)).resolves.toMatchObject({ code: 'API_KEY_EXPIRED' });
  });
});

describe('route-level admin permission mutations', () => {
  beforeEach(() => {
    vi.stubGlobal('fetch', vi.fn().mockImplementation(async () => new Response(JSON.stringify({
      user: { id: 'usr_admin', username: 'root', role: 'admin' },
    }))));
  });

  afterEach(() => vi.unstubAllGlobals());

  it.each([
    { label: 'title', body: { title: 'Updated title' } },
    { label: 'text', body: { text_content: 'Updated text' } },
  ])('rejects admin $label-only updates when the effective visibility remains public', async ({ body }) => {
    const db = testDb({
      profile: { username: 'root', role: 'admin', group_name: 'admin', can_public_publish: 0 },
      content: contentRow({ visibility: 'public' }),
    });

    const response = await invoke(db, '/api/admin/contents/cnt_1', { method: 'PATCH', body: JSON.stringify(body) });

    expect(response.status).toBe(403);
    await expect(errorBody(response)).resolves.toMatchObject({ code: 'PUBLIC_PUBLISH_PERMISSION_REQUIRED' });
    expect(db.executed.some((item) => item.sql.startsWith('UPDATE contents SET visibility='))).toBe(false);
  });

  it('locks active keys in the same batch when a group loses API permission', async () => {
    const db = testDb({
      profile: { username: 'root', role: 'admin', group_name: 'admin' },
      group: { id: 'group_1', name: 'staff', is_system: 0, is_default: 0, can_api: 1 },
    });

    const response = await invoke(db, '/api/admin/permission-groups/group_1', { method: 'PATCH', body: JSON.stringify({ can_api: false }) });

    expect(response.status).toBe(200);
    const batch = db.batches.at(-1)!;
    expect(batch.map((item) => item.sql)).toEqual([
      expect.stringContaining('UPDATE permission_groups'),
      expect.stringContaining('UPDATE api_keys SET locked_at'),
      expect.stringContaining('INSERT INTO admin_actions'),
    ]);
    expect(batch[0].values.at(-1)).toBe('group_1');
    expect(batch[1].values).toEqual([expect.any(String), 'permission_group_api_removed', 'root', 'group_1']);
    expect(batch[2].values.slice(1, 5)).toEqual(['root', 'update_permission_group', 'permission_group', 'group_1']);
  });

  it('returns current group and storage accounting in user management rows', async () => {
    const db = testDb({ profile: { username: 'root', role: 'admin', group_name: 'admin' } });

    const response = await invoke(db, '/api/admin/users');
    const body = await response.json() as { items: Array<Record<string, unknown>> };

    expect(response.status).toBe(200);
    expect(body.items).toEqual([expect.objectContaining({
      username: 'alice',
      permission_group_id: 'group_1',
      permission_group_name: 'staff',
      used_bytes: 50,
      reserved_bytes: 10,
      quota_bytes: 100,
    })]);
  });

  it('locks keys with user reassignment but never unlocks them when permission returns', async () => {
    const noApiDb = testDb({
      profile: { username: 'root', role: 'admin', group_name: 'admin' },
      group: { id: 'group_1', name: 'restricted', is_system: 0, is_default: 0, can_api: 0 },
    });
    const restoredDb = testDb({
      profile: { username: 'root', role: 'admin', group_name: 'admin' },
      group: { id: 'group_1', name: 'staff', is_system: 0, is_default: 0, can_api: 0 },
    });

    const assigned = await invoke(noApiDb, '/api/admin/users/alice/group', { method: 'PATCH', body: JSON.stringify({ group_id: 'group_1' }) });
    const restored = await invoke(restoredDb, '/api/admin/permission-groups/group_1', { method: 'PATCH', body: JSON.stringify({ can_api: true }) });

    expect(assigned.status).toBe(200);
    const assignmentBatch = noApiDb.batches.at(-1)!;
    expect(assignmentBatch.map((item) => item.sql)).toEqual([
      expect.stringContaining('UPDATE users SET permission_group_id'),
      expect.stringContaining('UPDATE api_keys SET locked_at'),
      expect.stringContaining('INSERT INTO admin_actions'),
    ]);
    expect(assignmentBatch[0].values).toEqual(['group_1', expect.any(String), 'alice']);
    expect(assignmentBatch[1].values).toEqual([expect.any(String), 'user_reassigned_without_api', 'root', 'alice']);
    expect(assignmentBatch[2].values.slice(1, 5)).toEqual(['root', 'assign_user_permission_group', 'user', 'alice']);
    expect(restored.status).toBe(200);
    expect(restoredDb.batches.at(-1)!.map((item) => item.sql).join('\n')).not.toContain('locked_at=NULL');
  });

  it('protects system group identity and requires replacement when deleting a custom group', async () => {
    const systemDb = testDb({
      profile: { username: 'root', role: 'admin', group_name: 'admin' },
      group: { id: 'permission-group-user', name: 'user', is_system: 1, is_default: 1, can_api: 1 },
    });
    const customDb = testDb({
      profile: { username: 'root', role: 'admin', group_name: 'admin' },
      group: { id: 'group_1', name: 'staff', is_system: 0, is_default: 0, can_api: 1 },
    });

    const rename = await invoke(systemDb, '/api/admin/permission-groups/permission-group-user', { method: 'PATCH', body: JSON.stringify({ name: 'renamed' }) });
    const remove = await invoke(customDb, '/api/admin/permission-groups/group_1', { method: 'DELETE', body: JSON.stringify({}) });

    expect(rename.status).toBe(409);
    expect(remove.status).toBe(400);
  });

  it('creates a new default and deletes a custom group through audited reassignment batches', async () => {
    const createDb = testDb({ profile: { username: 'root', role: 'admin', group_name: 'admin' } });
    const deleteDb = testDb({
      profile: { username: 'root', role: 'admin', group_name: 'admin' },
      group: { id: 'group_1', name: 'staff', is_system: 0, is_default: 1, can_api: 1 },
      replacementGroup: { id: 'replacement', name: 'restricted', is_system: 0, is_default: 0, can_api: 0 },
    });

    const created = await invoke(createDb, '/api/admin/permission-groups', {
      method: 'POST',
      body: JSON.stringify({ name: 'partners', is_default: true, can_api: true, quota_bytes: 1024 }),
    });
    const removed = await invoke(deleteDb, '/api/admin/permission-groups/group_1', {
      method: 'DELETE',
      body: JSON.stringify({ replacement_group_id: 'replacement' }),
    });

    expect(created.status).toBe(201);
    const createBatch = createDb.batches.at(-1)!;
    expect(createBatch.map((item) => item.sql)).toEqual([
      expect.stringContaining('SET is_default=0'),
      expect.stringContaining('INSERT INTO permission_groups'),
      expect.stringContaining('INSERT INTO admin_actions'),
    ]);
    expect(createBatch[2].values.slice(1, 4)).toEqual(['root', 'create_permission_group', 'permission_group']);
    expect(removed.status).toBe(200);
    const deleteBatch = deleteDb.batches.at(-1)!;
    expect(deleteBatch.map((item) => item.sql)).toEqual([
      expect.stringContaining('UPDATE api_keys SET locked_at'),
      expect.stringContaining('UPDATE users SET permission_group_id'),
      expect.stringContaining('SET is_default=0'),
      expect.stringContaining('SET is_default=1'),
      expect.stringContaining('DELETE FROM permission_groups'),
      expect.stringContaining('INSERT INTO admin_actions'),
    ]);
    expect(deleteBatch[0].values.at(-1)).toBe('group_1');
    expect(deleteBatch[1].values).toEqual(['replacement', expect.any(String), 'group_1']);
    expect(deleteBatch[3].values.at(-1)).toBe('replacement');
    expect(deleteBatch[4].values).toEqual(['group_1']);
    expect(deleteBatch[5].values.slice(1, 5)).toEqual(['root', 'delete_permission_group', 'permission_group', 'group_1']);
  });

  it('rejects duplicate group names and assignments to missing users', async () => {
    const duplicateDb = testDb({
      profile: { username: 'root', role: 'admin', group_name: 'admin' },
      existingGroupByName: { id: 'existing' },
    });
    const missingUserDb = testDb({
      profile: { username: 'root', role: 'admin', group_name: 'admin' },
      group: { id: 'group_1', name: 'staff', is_system: 0, is_default: 0, can_api: 1 },
      userExists: false,
    });
    const duplicateUpdateDb = testDb({
      profile: { username: 'root', role: 'admin', group_name: 'admin' },
      group: { id: 'group_1', name: 'staff', is_system: 0, is_default: 0, can_api: 1 },
      existingGroupByName: { id: 'existing' },
    });

    const duplicate = await invoke(duplicateDb, '/api/admin/permission-groups', {
      method: 'POST',
      body: JSON.stringify({ name: 'staff' }),
    });
    const missingUser = await invoke(missingUserDb, '/api/admin/users/missing/group', {
      method: 'PATCH',
      body: JSON.stringify({ group_id: 'group_1' }),
    });
    const duplicateUpdate = await invoke(duplicateUpdateDb, '/api/admin/permission-groups/group_1', {
      method: 'PATCH',
      body: JSON.stringify({ name: 'existing-name' }),
    });

    expect(duplicate.status).toBe(409);
    expect(duplicateUpdate.status).toBe(409);
    expect(missingUser.status).toBe(404);
    expect(missingUserDb.batches).toHaveLength(0);
  });

  it('rejects admin unlock until API permission exists', async () => {
    const db = testDb({
      profile: { username: 'root', role: 'admin', group_name: 'admin', can_api: 1 },
      ownerProfile: { username: 'alice', can_api: 0 },
      apiKey: { id: 'key_1', owner_username: 'alice', status: 'active', locked_at: '2026-08-22T00:00:00.000Z' },
    });

    const response = await invoke(db, '/api/admin/api-keys/key_1/unlock', { method: 'POST' });

    expect(response.status).toBe(403);
    await expect(errorBody(response)).resolves.toMatchObject({ code: 'API_PERMISSION_REQUIRED' });
  });

  it('rejects admin rotation when the owner lacks API permission without creating a replacement', async () => {
    const db = testDb({
      profile: { username: 'root', role: 'admin', group_name: 'admin', can_api: 1 },
      ownerProfile: { username: 'alice', can_api: 0 },
      apiKey: { id: 'key_1', owner_username: 'alice', remark: 'client', status: 'active', expire_at: null, locked_at: null },
    });

    const response = await invoke(db, '/api/admin/api-keys/key_1/rotate', { method: 'POST' });

    expect(response.status).toBe(403);
    await expect(errorBody(response)).resolves.toMatchObject({ code: 'API_PERMISSION_REQUIRED' });
    expect(db.batches).toHaveLength(0);
    expect(db.executed.some((item) => item.sql.startsWith('INSERT INTO api_keys'))).toBe(false);
  });

  it('audits admin unlock and returns a rotated secret once', async () => {
    const unlockDb = testDb({
      profile: { username: 'alice', role: 'user', group_name: 'user', can_api: 1 },
      apiKey: { id: 'key_1', owner_username: 'alice', remark: 'client', status: 'active', expire_at: null, locked_at: '2026-08-22T00:00:00.000Z' },
    });
    const rotateDb = testDb({
      profile: { username: 'root', role: 'admin', group_name: 'admin', can_api: 1 },
      ownerProfile: { username: 'alice', can_api: 1 },
      apiKey: { id: 'key_1', owner_username: 'alice', remark: 'client', status: 'active', expire_at: null, locked_at: null },
    });

    const unlocked = await invoke(unlockDb, '/api/admin/api-keys/key_1/unlock', { method: 'POST' });
    const rotated = await invoke(rotateDb, '/api/admin/api-keys/key_1/rotate', { method: 'POST' });
    const rotatedBody = await rotated.json() as { key?: string };

    expect(unlocked.status).toBe(200);
    expect(unlockDb.batches.at(-1)!.map((item) => item.sql).join('\n')).toContain('locked_at=NULL');
    expect(rotated.status).toBe(200);
    expect(rotatedBody.key).toMatch(/^csk_[A-Za-z0-9_-]+$/);
    const raw = rotatedBody.key!;
    const batch = rotateDb.batches.at(-1)!;
    expect(batch.map((item) => item.sql)).toEqual([
      expect.stringContaining('UPDATE api_keys SET status="revoked"'),
      expect.stringContaining('INSERT INTO api_keys'),
      expect.stringContaining('INSERT INTO admin_actions'),
    ]);
    expect(batch[0].values).toEqual([expect.any(String), 'key_1']);
    expect(batch[1].values[1]).toBe('alice');
    expect(batch[1].values[3]).toBe(await apiKeyHash(raw));
    expect(batch[1].values[4]).toBe(raw.slice(0, 10));
    expect(batch[1].values[5]).toBe(raw.slice(-4));
    expect(batch[2].values.slice(1, 5)).toEqual(['root', 'rotate_api_key', 'api_key', 'key_1']);
    expect(rotateDb.executed.flatMap((item) => item.values).some((value) => value === raw || String(value).includes(raw))).toBe(false);
  });

  it.each(['lock', 'revoke'] as const)('keeps admin %s distinct and audited', async (action) => {
    const db = testDb({
      profile: { username: 'root', role: 'admin', group_name: 'admin' },
      apiKey: { id: 'key_1', owner_username: 'alice', status: 'active', locked_at: null },
    });

    const response = await invoke(db, `/api/admin/api-keys/key_1/${action}`, { method: 'POST' });

    expect(response.status).toBe(200);
    const sql = db.batches.at(-1)!.map((item) => item.sql).join('\n');
    expect(sql).toContain(action === 'lock' ? 'SET locked_at=' : 'SET status="revoked"');
    expect(sql).toContain('INSERT INTO admin_actions');
  });
});
