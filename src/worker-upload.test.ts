import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { GiB, MiB } from './transfer-policy';
import worker from './worker';

const NOW = Date.now();

type RecordedStatement = {
  sql: string;
  values: unknown[];
  bind: (...values: unknown[]) => RecordedStatement;
  first: <T>() => Promise<T | null>;
  run: () => Promise<{ meta: { changes: number } }>;
  all: <T>() => Promise<{ results: T[] }>;
};

type DbOptions = {
  profile?: Record<string, unknown>;
  activationState?: Record<string, unknown>;
  first?: (sql: string, values: unknown[]) => unknown;
  all?: (sql: string, values: unknown[]) => unknown[] | undefined;
  run?: (sql: string, values: unknown[]) => number | undefined;
  batch?: (items: RecordedStatement[], batchNumber: number) => void | number[] | Promise<void | number[]>;
  timeline?: string[];
};

function profileRow(overrides: Record<string, unknown> = {}) {
  return {
    username: 'alice',
    role: 'user',
    group_name: 'user',
    can_public_publish: 1,
    can_api: 1,
    can_internal_access: 1,
    can_upload: 1,
    can_comment: 1,
    quota_bytes: 20 * GiB,
    used_bytes: 0,
    reserved_bytes: 0,
    ...overrides,
  };
}

function sessionRow(overrides: Record<string, unknown> = {}) {
  return {
    id: 'upl_1',
    content_id: 'cnt_1',
    attachment_id: 'att_1',
    owner_username: 'alice',
    object_key: 'upload-staging/alice/cnt_1/att_1',
    filename: 'archive.bin',
    content_type: 'application/octet-stream',
    size: 5,
    mode: 'single',
    upload_id: null,
    expected_parts: 1,
    completed_parts: 0,
    uploaded_bytes: 0,
    status: 'pending',
    etag: null,
    file_fingerprint: 'a'.repeat(64),
    expires_at: new Date(NOW + 24 * 60 * 60 * 1000).toISOString(),
    last_activity_at: new Date(NOW - 5 * 60 * 1000).toISOString(),
    created_at: new Date(NOW - 5 * 60 * 1000).toISOString(),
    updated_at: new Date(NOW - 5 * 60 * 1000).toISOString(),
    ...overrides,
  };
}

function recordingDb(options: DbOptions = {}) {
  const prepared: RecordedStatement[] = [];
  const executed: RecordedStatement[] = [];
  const batches: RecordedStatement[][] = [];
  const timeline = options.timeline ?? [];

  function defaultFirst(sql: string): unknown {
    if (sql.includes('p.name AS group_name')) return profileRow(options.profile);
    if (sql.includes('FROM permission_groups WHERE is_default = 1')) return { id: 'permission-group-user' };
    if (sql.startsWith('SELECT id FROM contents WHERE slug')) return null;
    if (sql.startsWith('SELECT COUNT(*) count, COALESCE(SUM(size)')) return { count: 0, bytes: 0 };
    if (sql.includes('FROM contents c') && sql.includes('LEFT JOIN attachments')) {
      return options.activationState ?? { owner_username: 'alice', expected: 1, completed: 1, failed: 0, total_size: 5, text_content: '' };
    }
    if (sql.startsWith('SELECT COUNT(*) total, SUM(status="completed")')) {
      return { total: 1, completed: 0, incomplete: 0 };
    }
    return null;
  }

  function statement(sql: string, values: unknown[] = []): RecordedStatement {
    const item: RecordedStatement = {
      sql,
      values,
      bind: (...nextValues: unknown[]) => statement(sql, nextValues),
      first: async <T>() => {
        executed.push(item);
        timeline.push(`db:first:${sql}`);
        const custom = options.first?.(sql, values);
        return (custom === undefined ? defaultFirst(sql) : custom) as T | null;
      },
      run: async () => {
        executed.push(item);
        timeline.push(`db:run:${sql}`);
        return { meta: { changes: options.run?.(sql, values) ?? 1 } };
      },
      all: async <T>() => {
        executed.push(item);
        timeline.push(`db:all:${sql}`);
        return { results: (options.all?.(sql, values) ?? []) as T[] };
      },
    };
    return item;
  }

  const db = {
    prepared,
    executed,
    batches,
    timeline,
    prepare(sql: string) {
      const item = statement(sql);
      prepared.push(item);
      return item;
    },
    async batch(items: RecordedStatement[]) {
      batches.push(items);
      executed.push(...items);
      timeline.push(`db:batch:${items.map((item) => item.sql).join(' | ')}`);
      const changes = await options.batch?.(items, batches.length);
      return items.map((_, index) => ({ meta: { changes: changes?.[index] ?? 1 } }));
    },
  };
  return db as unknown as D1Database & {
    prepared: RecordedStatement[];
    executed: RecordedStatement[];
    batches: RecordedStatement[][];
    timeline: string[];
  };
}

type RuntimeOptions = {
  timeline?: string[];
  bucket?: Record<string, unknown>;
  queueSend?: (...args: unknown[]) => unknown;
};

function runtime(db: D1Database, options: RuntimeOptions = {}) {
  const timeline = options.timeline ?? [];
  const multipartAbort = vi.fn(async () => { timeline.push('r2:multipart-abort'); });
  const resumedAbort = vi.fn(async () => { timeline.push('r2:resumed-abort'); });
  const bucket = {
    head: vi.fn(async () => null),
    get: vi.fn(async () => null),
    put: vi.fn(async (key: string) => {
      timeline.push(`r2:put:${key}`);
      return { key, size: 5, httpEtag: '"etag"' };
    }),
    delete: vi.fn(async (key: string) => { timeline.push(`r2:delete:${key}`); }),
    createMultipartUpload: vi.fn(async (key: string) => {
      timeline.push(`r2:create-multipart:${key}`);
      return { key, uploadId: 'multipart_1', abort: multipartAbort };
    }),
    resumeMultipartUpload: vi.fn((key: string) => ({
      key,
      uploadId: 'multipart_1',
      abort: resumedAbort,
      complete: vi.fn(async () => { timeline.push(`r2:complete:${key}`); }),
    })),
    ...options.bucket,
  };
  const send = vi.fn(async (...args: unknown[]) => {
    timeline.push('queue:send');
    return options.queueSend?.(...args);
  });
  const env = {
    DB: db,
    BUCKET: bucket,
    UPLOAD_QUEUE: { send },
    ASSETS: { fetch: vi.fn() },
    SSO_URL: 'https://accounts.example.test',
    SSO_APP_ID: 'content-share',
    MEDIA_TICKET_SECRET: 'media-secret',
    PUBLIC_BASE_URL: 'https://content.example.test',
    R2_ACCOUNT_ID: 'account-id',
    R2_BUCKET_NAME: 'content-share-save',
    R2_UPLOAD_ACCESS_KEY_ID: 'A'.repeat(32),
    R2_UPLOAD_SECRET_ACCESS_KEY: 'upload-secret',
  } as unknown as Parameters<typeof worker.fetch>[1];
  return { env, bucket, send, multipartAbort, resumedAbort, timeline };
}

function request(path: string, init: RequestInit = {}) {
  const headers = new Headers(init.headers);
  if (!headers.has('authorization')) headers.set('authorization', 'Bearer x.e30.x');
  if (init.body && typeof init.body === 'string' && !headers.has('content-type')) headers.set('content-type', 'application/json');
  return new Request(`https://content.example.test${path}`, { ...init, headers });
}

async function invoke(db: D1Database, path: string, init: RequestInit = {}, runtimeOptions: RuntimeOptions = {}) {
  const current = runtime(db, runtimeOptions);
  const response = await worker.fetch(request(path, init), current.env, { waitUntil() {} } as unknown as ExecutionContext);
  return { response, ...current };
}

function fakeSizedFile(size: number, name = 'large.bin') {
  const file = new File(['x'], name, { type: 'application/octet-stream' });
  Object.defineProperty(file, 'size', { configurable: true, value: size });
  return file;
}

function formRequest(path: string, form: FormData) {
  const req = request(path, { method: 'POST' });
  vi.spyOn(req, 'formData').mockResolvedValue(form);
  return req;
}

function sqlIndex(statements: RecordedStatement[], fragment: string) {
  return statements.findIndex((item) => item.sql.includes(fragment));
}

function queueMessage(body: unknown, attempts = 1) {
  return {
    body,
    attempts,
    ack: vi.fn(),
    retry: vi.fn(),
  };
}

function queueBatch(messages: Array<ReturnType<typeof queueMessage>>) {
  return { messages } as unknown as Parameters<NonNullable<typeof worker.queue>>[0];
}

describe('Worker quota reservations and upload lifecycle', () => {
  beforeEach(() => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({
      user: { id: 'usr_1', username: 'alice', role: 'user' },
    }))));
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  it('creates, reserves, and atomically activates UTF-8 text without double counting', async () => {
    const db = recordingDb();

    const { response } = await invoke(db, '/api/contents/text', {
      method: 'POST',
      body: JSON.stringify({ visibility: 'private', title: 'Unicode', content: 'é' }),
    });

    expect(response.status).toBe(200);
    const placeholder = db.executed.find((item) => item.sql.startsWith('INSERT INTO contents'))!;
    const reservation = db.executed.find((item) => item.sql.includes('INSERT INTO storage_reservations'))!;
    expect(placeholder.sql).toContain('"processing"');
    expect(placeholder.sql).toContain('text_size');
    expect(placeholder.sql).toContain('file_size');
    expect(reservation.values[3]).toBe(2);
    expect(db.executed.indexOf(placeholder)).toBeLessThan(db.executed.indexOf(reservation));
    const activation = db.batches.find((batch) => batch.some((item) => item.sql.includes('SET status="active"') && item.sql.includes('text_size')))!;
    expect(activation).toHaveLength(2);
    expect(activation[0].values.slice(0, 2)).toEqual([2, 0]);
    expect(activation[1].sql).toMatch(/status\s*=\s*'released'/);
  });

  it('deletes the text placeholder after a structured quota denial', async () => {
    const db = recordingDb({
      profile: { quota_bytes: 100, used_bytes: 70, reserved_bytes: 20 },
      run: (sql) => sql.includes('INSERT INTO storage_reservations') ? 0 : undefined,
    });

    const { response } = await invoke(db, '/api/contents/text', {
      method: 'POST',
      body: JSON.stringify({ visibility: 'private', content: 'eleven byte' }),
    });

    expect(response.status).toBe(413);
    await expect(response.json()).resolves.toMatchObject({
      code: 'STORAGE_QUOTA_EXCEEDED',
      details: { used_bytes: 70, reserved_bytes: 20, requested_bytes: 11, quota_bytes: 100 },
    });
    expect(db.executed.some((item) => item.sql.startsWith('DELETE FROM contents'))).toBe(true);
  });

  it('reserves legacy text and file bytes while leaving final sizes for Queue activation', async () => {
    const timeline: string[] = [];
    const db = recordingDb({ timeline });
    const current = runtime(db, { timeline });
    const form = new FormData();
    form.set('visibility', 'private');
    form.set('allow_download', 'false');
    form.set('content', 'é');
    form.set('file', new File([new Uint8Array([1, 2, 3])], 'small.bin'));

    const response = await worker.fetch(formRequest('/api/contents/upload', form), current.env, { waitUntil() {} } as unknown as ExecutionContext);

    expect(response.status).toBe(200);
    const placeholder = db.executed.find((item) => item.sql.startsWith('INSERT INTO contents'))!;
    expect(placeholder.sql).toContain('allow_download');
    expect(placeholder.values).toContain(0);
    const reservation = db.executed.find((item) => item.sql.includes('INSERT INTO storage_reservations'))!;
    expect(reservation.values.slice(1, 4)).toEqual(['alice', placeholder.values[0], 5]);
    expect(reservation.values[3]).toBe(5);
    expect(db.executed.filter((item) => item.sql.includes('UPDATE contents SET file_size'))).toEqual([]);
    expect(timeline.findIndex((entry) => entry.includes('db:run:INSERT INTO storage_reservations')))
      .toBeLessThan(timeline.findIndex((entry) => entry.startsWith('r2:put:')));
    expect(current.send).toHaveBeenCalledOnce();
  });

  it('activates a legacy upload and releases its reservation in one Queue batch', async () => {
    const db = recordingDb({
      activationState: { owner_username: 'alice', expected: 1, completed: 1, failed: 0, total_size: 3, text_content: 'é' },
    });
    const current = runtime(db);
    const message = queueMessage({ type: 'finalize-upload', contentId: 'cnt_legacy', owner: 'alice' });

    await worker.queue!(queueBatch([message]), current.env);

    const activation = db.batches.find((batch) => batch.some((item) => item.sql.includes('text_size')))!;
    expect(activation[0].values.slice(0, 2)).toEqual([2, 3]);
    expect(activation[1].sql).toMatch(/status\s*=\s*'released'/);
    expect(message.ack).toHaveBeenCalledOnce();
    expect(message.retry).not.toHaveBeenCalled();
  });

  it.each([
    { size: 100 * MiB + 1, code: 'RESUMABLE_UPLOAD_REQUIRED' },
    { size: 5 * GiB, code: 'RESUMABLE_UPLOAD_REQUIRED' },
    { size: 5 * GiB + 1, code: 'FILE_TOO_LARGE' },
  ])('returns stable legacy 413 $code at $size bytes', async ({ size, code }) => {
    const db = recordingDb();
    const current = runtime(db);
    const form = new FormData();
    form.set('visibility', 'private');
    form.set('file', fakeSizedFile(size));

    const response = await worker.fetch(formRequest('/api/contents/upload', form), current.env, { waitUntil() {} } as unknown as ExecutionContext);

    expect(response.status).toBe(413);
    await expect(response.json()).resolves.toMatchObject({ code });
    expect(current.bucket.put).not.toHaveBeenCalled();
  });

  it('accepts exactly 5 GiB directly, reserves once, and signs only the first eight parts', async () => {
    const timeline: string[] = [];
    const db = recordingDb({ timeline });

    const { response } = await invoke(db, '/api/uploads/initiate', {
      method: 'POST',
      body: JSON.stringify({
        visibility: 'private',
        allow_download: false,
        content: 'é',
        files: [{ client_id: 'client-1', name: 'five-gib.bin', size: 5 * GiB, fingerprint: 'a'.repeat(64) }],
      }),
    }, { timeline });

    expect(response.status).toBe(201);
    const body = await response.json() as { files: Array<{ parts: Array<{ part_number: number }>; next_part_number: number; has_more_parts: boolean }> };
    expect(body.files[0].parts.map((part) => part.part_number)).toEqual([1, 2, 3, 4, 5, 6, 7, 8]);
    expect(body.files[0]).toMatchObject({ next_part_number: 9, has_more_parts: true });
    expect(db.executed.filter((item) => item.sql.includes('INSERT INTO storage_reservations'))).toHaveLength(1);
    const placeholder = db.executed.find((item) => item.sql.startsWith('INSERT INTO contents'))!;
    expect(placeholder.sql).toContain('allow_download');
    expect(placeholder.values).toContain(0);
    const reservation = db.executed.find((item) => item.sql.includes('INSERT INTO storage_reservations'))!;
    expect(reservation.values.slice(1, 4)).toEqual(['alice', placeholder.values[0], 5 * GiB + 2]);
    expect(db.prepared.some((item) => item.sql.includes('COALESCE(SUM(size), 0) bytes'))).toBe(false);
    expect(timeline.findIndex((entry) => entry.startsWith('db:run:INSERT INTO contents')))
      .toBeLessThan(timeline.findIndex((entry) => entry.startsWith('r2:create-multipart')));
    expect(timeline.findIndex((entry) => entry.includes('db:run:INSERT INTO storage_reservations')))
      .toBeLessThan(timeline.findIndex((entry) => entry.startsWith('r2:create-multipart')));
  });

  it.each(['/api/uploads/initiate', '/api/cli/uploads/initiate'])('rejects more than 5 GiB through transfer policy on %s', async (path) => {
    const db = recordingDb({
      first: (sql) => sql.startsWith('SELECT * FROM api_keys WHERE key_hash')
        ? { id: 'key_1', owner_username: 'alice', status: 'active', expire_at: null, locked_at: null }
        : undefined,
    });

    const { response } = await invoke(db, path, {
      method: 'POST',
      body: JSON.stringify({ visibility: 'private', files: [{ name: 'too-large.bin', size: 5 * GiB + 1, fingerprint: 'b'.repeat(64) }] }),
    });

    expect(response.status).toBe(413);
    await expect(response.json()).resolves.toMatchObject({ code: 'FILE_TOO_LARGE' });
    expect(db.executed.some((item) => item.sql.startsWith('INSERT INTO contents'))).toBe(false);
  });

  it.each([
    { activeReservation: false, expectedInserts: 1 },
    { activeReservation: true, expectedInserts: 0 },
  ])('reuses sessions with one current reservation (active=$activeReservation)', async ({ activeReservation, expectedInserts }) => {
    vi.useFakeTimers();
    vi.setSystemTime(NOW);
    const size = 1024 * MiB;
    const session = sessionRow({
      size,
      mode: 'multipart',
      upload_id: 'multipart_reuse',
      expected_parts: 16,
      file_fingerprint: 'c'.repeat(64),
    });
    const db = recordingDb({
      first: (sql) => {
        if (sql.startsWith('SELECT * FROM upload_sessions WHERE owner_username')) return session;
        if (sql.startsWith('SELECT COUNT(*) count FROM upload_sessions')) return { count: 1 };
        if (sql.startsWith('SELECT id, slug, status')) return { id: 'cnt_1', slug: 'reused', status: 'processing', text_content: 'é' };
        if (sql.includes('FROM storage_reservations') && sql.includes('content_id')) {
          return activeReservation ? { id: 'res_cnt_1', bytes: size + 2, expires_at: new Date(NOW + 10_000).toISOString() } : null;
        }
        return undefined;
      },
      all: (sql) => sql.includes('FROM upload_parts')
        ? [
            { part_number: 1, etag: 'one', size: 64 * MiB, completed_at: new Date(NOW).toISOString() },
            { part_number: 3, etag: 'three', size: 64 * MiB, completed_at: new Date(NOW).toISOString() },
          ]
        : undefined,
    });

    const { response, bucket } = await invoke(db, '/api/uploads/initiate', {
      method: 'POST',
      body: JSON.stringify({
        visibility: 'private',
        files: [{ client_id: 'reuse-client', name: 'reuse.bin', size, fingerprint: 'c'.repeat(64) }],
      }),
    });

    expect(response.status).toBe(200);
    const body = await response.json() as { resumed: boolean; files: Array<{ parts: Array<{ part_number: number }> }> };
    expect(body.resumed).toBe(true);
    expect(body.files[0].parts.map((part) => part.part_number)).toEqual([2, 4, 5, 6, 7, 8, 9, 10]);
    expect(db.executed.filter((item) => item.sql.includes('INSERT INTO storage_reservations'))).toHaveLength(expectedInserts);
    expect(db.batches.some((batch) => batch.some((item) => item.sql.includes('UPDATE storage_reservations') && item.sql.includes('expires_at')))).toBe(true);
    expect(bucket.createMultipartUpload).not.toHaveBeenCalled();
  });

  it.each([
    { path: '/api/uploads/upl_parts/parts?after=0&limit=99', cli: false },
    { path: '/api/cli/uploads/upl_parts/parts?after=0&limit=99', cli: true },
  ])('authenticates and signs at most eight missing parts for $path', async ({ path, cli }) => {
    const session = sessionRow({
      id: 'upl_parts',
      size: 1024 * MiB,
      mode: 'multipart',
      upload_id: 'multipart_parts',
      expected_parts: 16,
    });
    const db = recordingDb({
      first: (sql) => {
        if (sql.startsWith('SELECT * FROM api_keys WHERE key_hash')) {
          return cli ? { id: 'key_1', owner_username: 'alice', status: 'active', expire_at: null, locked_at: null } : null;
        }
        if (sql.startsWith('SELECT * FROM upload_sessions WHERE id = ?1 AND owner_username')) return session;
        if (sql.includes('FROM contents c') && sql.includes('JOIN upload_sessions')) {
          return { owner_username: 'alice', text_content: 'é', file_size: session.size };
        }
        return undefined;
      },
      all: (sql) => sql.includes('FROM upload_parts')
        ? [
            { part_number: 1, etag: 'one', size: 64 * MiB, completed_at: new Date(NOW).toISOString() },
            { part_number: 3, etag: 'three', size: 64 * MiB, completed_at: new Date(NOW).toISOString() },
          ]
        : undefined,
    });

    const { response } = await invoke(db, path);

    expect(response.status).toBe(200);
    const body = await response.json() as { item: { parts: Array<{ part_number: number }>; next_part_number: number; has_more_parts: boolean } };
    expect(body.item.parts.map((part) => part.part_number)).toEqual([2, 4, 5, 6, 7, 8, 9, 10]);
    expect(body.item).toMatchObject({ next_part_number: 11, has_more_parts: true });
    const ownedSession = db.executed.find((item) => item.sql.startsWith('SELECT * FROM upload_sessions WHERE id = ?1 AND owner_username'))!;
    expect(ownedSession.values).toEqual(['upl_parts', 'alice']);
    const apiKey = db.executed.find((item) => item.sql.startsWith('SELECT * FROM api_keys WHERE key_hash'));
    if (cli) {
      expect(apiKey?.values).toHaveLength(1);
      expect(apiKey?.values[0]).toMatch(/^[a-f0-9]{64}$/);
    } else {
      expect(apiKey).toBeUndefined();
    }
    const reservation = db.executed.find((item) => item.sql.includes('INSERT INTO storage_reservations'))!;
    expect(reservation.values.slice(1, 4)).toEqual(['alice', 'cnt_1', session.size + 2]);
  });

  it('reports finalized session state separately from pending content activation', async () => {
    const session = sessionRow({ status: 'completed', completed_parts: 1, uploaded_bytes: 5 });
    const db = recordingDb({
      first: (sql) => {
        if (sql.startsWith('SELECT * FROM upload_sessions WHERE id = ?1 AND owner_username')) return session;
        if (sql.startsWith('SELECT status FROM contents WHERE id=?1 AND owner_username=?2')) return { status: 'processing' };
        return undefined;
      },
    });

    const { response } = await invoke(db, '/api/uploads/upl_1/status');

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({
      item: {
        status: 'completed',
        content_status: 'processing',
        content_active: false,
      },
    });
    const contentState = db.executed.find((item) => item.sql.startsWith('SELECT status FROM contents WHERE id=?1 AND owner_username=?2'))!;
    expect(contentState.values).toEqual(['cnt_1', 'alice']);
  });

  it('keeps a finalized complete response queued until content activation', async () => {
    const session = sessionRow({ status: 'completed', completed_parts: 1, uploaded_bytes: 5 });
    const db = recordingDb({
      first: (sql) => {
        if (sql.startsWith('SELECT * FROM upload_sessions WHERE id = ?1 AND owner_username')) return session;
        if (sql.startsWith('SELECT status FROM contents WHERE id=?1 AND owner_username=?2')) return { status: 'processing' };
        return undefined;
      },
    });

    const { response } = await invoke(db, '/api/uploads/upl_1/complete', { method: 'POST', body: '{}' });

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({
      queued: true,
      session_status: 'completed',
      content_status: 'processing',
      content_active: false,
    });
    const contentState = db.executed.find((item) => item.sql.startsWith('SELECT status FROM contents WHERE id=?1 AND owner_username=?2'))!;
    expect(contentState.values).toEqual(['cnt_1', 'alice']);
  });

  it('renews from the first missing part after the requested cursor and clamps the window', async () => {
    const session = sessionRow({ size: 1024 * MiB, mode: 'multipart', upload_id: 'multipart_renew', expected_parts: 16 });
    const db = recordingDb({
      first: (sql) => {
        if (sql.startsWith('SELECT * FROM upload_sessions WHERE id = ?1 AND owner_username')) return session;
        if (sql.startsWith('SELECT id, bytes, expires_at FROM storage_reservations')) {
          return { id: 'res_cnt_1', bytes: session.size, expires_at: new Date(NOW + 60_000).toISOString() };
        }
        return undefined;
      },
      all: (sql) => sql.includes('FROM upload_parts')
        ? [{ part_number: 5, etag: 'five', size: 64 * MiB, completed_at: new Date(NOW).toISOString() }]
        : undefined,
    });

    const { response } = await invoke(db, '/api/uploads/upl_1/renew', {
      method: 'POST',
      body: JSON.stringify({ after: 4, limit: 999 }),
    });

    expect(response.status).toBe(200);
    const body = await response.json() as { item: { parts: Array<{ part_number: number }> } };
    expect(body.item.parts.map((part) => part.part_number)).toEqual([6, 7, 8, 9, 10, 11, 12, 13]);
  });

  it('heartbeats session hard TTL and reservation inactivity expiry in one ordered batch', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(NOW);
    const session = sessionRow();
    const db = recordingDb({
      first: (sql) => sql.startsWith('SELECT * FROM upload_sessions WHERE id = ?1 AND owner_username') ? session : undefined,
    });

    const { response } = await invoke(db, '/api/uploads/upl_1/heartbeat', {
      method: 'POST',
      body: JSON.stringify({ fingerprint: session.file_fingerprint }),
    });

    expect(response.status).toBe(200);
    const heartbeat = db.batches.find((batch) => batch.some((item) => item.sql.includes('UPDATE upload_sessions SET last_activity_at')))!;
    expect(heartbeat).toHaveLength(2);
    expect(heartbeat[0].values[1]).toBe(new Date(NOW + 24 * 60 * 60 * 1000).toISOString());
    expect(heartbeat[1].sql).toContain('UPDATE storage_reservations');
    expect(heartbeat[1].values[1]).toBe(new Date(NOW + 30 * 60 * 1000).toISOString());
  });

  it('rejects a heartbeat when an active cleanup claim owns the content group', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(NOW);
    const session = sessionRow();
    const db = recordingDb({
      first: (sql) => sql.startsWith('SELECT * FROM upload_sessions WHERE id = ?1 AND owner_username') ? session : undefined,
      batch: (items) => items.some((item) => item.sql.includes('UPDATE upload_sessions SET last_activity_at'))
        ? [0, 0]
        : undefined,
    });

    const { response } = await invoke(db, '/api/uploads/upl_1/heartbeat', {
      method: 'POST',
      body: JSON.stringify({ fingerprint: session.file_fingerprint }),
    });

    expect(response.status).toBe(409);
    await expect(response.json()).resolves.toMatchObject({ code: 'UPLOAD_CLEANUP_IN_PROGRESS' });
    const heartbeat = db.batches.find((batch) => batch.some((item) => item.sql.includes('UPDATE upload_sessions SET last_activity_at')))!;
    expect(heartbeat[0].sql).toContain('NOT EXISTS');
    expect(heartbeat[0].sql).toContain('upload_cleanup_claims');
    expect(heartbeat[0].values).toEqual([
      new Date(NOW).toISOString(),
      new Date(NOW + 24 * 60 * 60 * 1000).toISOString(),
      'upl_1',
    ]);
    expect(heartbeat[1].sql).toContain('upload_cleanup_claims');
  });

  it('does not clean a content group when any non-terminal sibling is recently active', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(NOW);
    const stale = sessionRow({
      mode: 'multipart',
      upload_id: 'multipart_stale',
      last_activity_at: new Date(NOW - 31 * 60 * 1000).toISOString(),
      updated_at: new Date(NOW - 31 * 60 * 1000).toISOString(),
    });
    const activeSibling = sessionRow({
      id: 'upl_active',
      attachment_id: 'att_active',
      object_key: 'attachments/alice/cnt_1/att_active',
      mode: 'multipart',
      upload_id: 'multipart_active',
      last_activity_at: new Date(NOW - 2 * 60 * 1000).toISOString(),
      updated_at: new Date(NOW - 2 * 60 * 1000).toISOString(),
    });
    const db = recordingDb({
      all: (sql) => {
        if (sql.includes('COALESCE(last_activity_at')) return [stale];
        if (sql.startsWith('SELECT * FROM upload_sessions WHERE content_id')) return [stale, activeSibling];
        if (sql.startsWith('SELECT object_key FROM attachments WHERE content_id')) {
          return [{ object_key: stale.object_key }, { object_key: activeSibling.object_key }];
        }
        return undefined;
      },
    });
    const current = runtime(db);
    const pending: Promise<unknown>[] = [];

    worker.scheduled!({} as ScheduledController, current.env, {
      waitUntil(value: Promise<unknown>) { pending.push(value); },
    } as unknown as ExecutionContext);
    await Promise.all(pending);

    expect(current.resumedAbort).not.toHaveBeenCalled();
    expect(current.bucket.delete).not.toHaveBeenCalled();
    expect(db.batches.some((batch) => batch.some((item) => item.sql.includes('status="expired"')))).toBe(false);
    expect(db.batches.some((batch) => batch.some((item) => item.sql.includes("status='expired'")))).toBe(false);
  });

  it('does not clean when a concurrent heartbeat wins the conditional cleanup claim', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(NOW);
    const stale = sessionRow({
      mode: 'multipart',
      upload_id: 'multipart_stale',
      last_activity_at: new Date(NOW - 31 * 60 * 1000).toISOString(),
      updated_at: new Date(NOW - 31 * 60 * 1000).toISOString(),
    });
    const cutoff = new Date(NOW - 30 * 60 * 1000).toISOString();
    const db = recordingDb({
      all: (sql) => {
        if (sql.includes('COALESCE(last_activity_at')) return [stale];
        if (sql.startsWith('SELECT * FROM upload_sessions WHERE content_id')) return [stale];
        if (sql.startsWith('SELECT object_key FROM attachments WHERE content_id')) return [{ object_key: stale.object_key }];
        return undefined;
      },
      batch: (items) => items.some((item) => item.sql.includes('INSERT INTO upload_cleanup_claims'))
        ? [0, 0]
        : undefined,
    });
    const current = runtime(db);
    const pending: Promise<unknown>[] = [];

    worker.scheduled!({} as ScheduledController, current.env, {
      waitUntil(value: Promise<unknown>) { pending.push(value); },
    } as unknown as ExecutionContext);
    await Promise.all(pending);

    const claim = db.batches.find((batch) => batch.some((item) => item.sql.includes('INSERT INTO upload_cleanup_claims')))![0];
    expect(claim.sql).toContain("julianday(r.expires_at) <= julianday(?3)");
    expect(claim.sql).toContain('NOT EXISTS');
    expect(claim.sql).toContain('last_activity_at');
    expect(claim.values).toEqual([
      'cnt_1',
      expect.stringMatching(/^ucl_/),
      new Date(NOW).toISOString(),
      new Date(NOW + 10 * 60 * 1000).toISOString(),
      cutoff,
    ]);
    expect(current.resumedAbort).not.toHaveBeenCalled();
    expect(current.bucket.delete).not.toHaveBeenCalled();
  });

  it('aborts and removes stale upload state before expiring the reservation', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(NOW);
    const timeline: string[] = [];
    const stale = sessionRow({
      mode: 'multipart',
      upload_id: 'multipart_stale',
      last_activity_at: new Date(NOW - 31 * 60 * 1000).toISOString(),
      updated_at: new Date(NOW - 31 * 60 * 1000).toISOString(),
    });
    const completedSibling = sessionRow({
      id: 'upl_completed',
      attachment_id: 'att_completed',
      object_key: 'attachments/alice/cnt_1/att_completed',
      status: 'completed',
      completed_parts: 1,
      uploaded_bytes: 5,
    });
    const db = recordingDb({
      timeline,
      all: (sql) => {
        if (sql.includes('COALESCE(last_activity_at')) return [stale];
        if (sql.startsWith('SELECT * FROM upload_sessions WHERE content_id')) return [stale, completedSibling];
        if (sql.startsWith('SELECT object_key FROM attachments WHERE content_id')) {
          return [
            { object_key: stale.object_key },
            { object_key: 'attachments/alice/cnt_1/att_completed' },
          ];
        }
        return undefined;
      },
    });
    const current = runtime(db, { timeline });
    const pending: Promise<unknown>[] = [];

    worker.scheduled!({} as ScheduledController, current.env, {
      waitUntil(value: Promise<unknown>) { pending.push(value); },
    } as unknown as ExecutionContext);
    await Promise.all(pending);

    expect(current.resumedAbort).toHaveBeenCalledOnce();
    expect(current.bucket.delete).toHaveBeenCalledWith('attachments/alice/cnt_1/att_completed');
    const cleanup = db.batches.find((batch) => batch.some((item) => item.sql.includes('DELETE FROM upload_parts')))!;
    expect(sqlIndex(cleanup, 'DELETE FROM upload_parts')).toBeLessThan(sqlIndex(cleanup, 'UPDATE storage_reservations'));
    expect(sqlIndex(cleanup, 'UPDATE upload_sessions SET status="expired"')).toBeLessThan(sqlIndex(cleanup, 'UPDATE storage_reservations'));
    expect(cleanup.some((item) => item.sql.includes('text_content=NULL'))).toBe(true);
    const reservationBatchIndex = timeline.findIndex((entry) => entry.includes("SET status='expired'"));
    expect(timeline.findIndex((entry) => entry === 'r2:resumed-abort')).toBeLessThan(reservationBatchIndex);
    expect(timeline.findIndex((entry) => entry.startsWith('r2:delete:'))).toBeLessThan(reservationBatchIndex);
  });

  it('retains stale metadata and reservation accounting when R2 cleanup fails', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(NOW);
    const stale = sessionRow({
      mode: 'multipart',
      upload_id: 'multipart_stale',
      last_activity_at: new Date(NOW - 31 * 60 * 1000).toISOString(),
      updated_at: new Date(NOW - 31 * 60 * 1000).toISOString(),
    });
    const abort = vi.fn(async () => { throw new Error('R2 abort failed'); });
    const db = recordingDb({
      all: (sql) => {
        if (sql.includes('COALESCE(last_activity_at')) return [stale];
        if (sql.startsWith('SELECT * FROM upload_sessions WHERE content_id')) return [stale];
        if (sql.startsWith('SELECT object_key FROM attachments WHERE content_id')) return [{ object_key: stale.object_key }];
        return undefined;
      },
    });
    const current = runtime(db, {
      bucket: {
        resumeMultipartUpload: vi.fn(() => ({ abort })),
      },
    });
    const pending: Promise<unknown>[] = [];

    worker.scheduled!({} as ScheduledController, current.env, {
      waitUntil(value: Promise<unknown>) { pending.push(value); },
    } as unknown as ExecutionContext);
    await Promise.all(pending);

    expect(abort).toHaveBeenCalledOnce();
    expect(db.batches.some((batch) => batch.some((item) => item.sql.includes('UPDATE contents SET status="expired"')))).toBe(false);
    expect(db.batches.some((batch) => batch.some((item) => item.sql.includes("SET status='expired'")))).toBe(false);
    const claim = db.batches.find((batch) => batch.some((item) => item.sql.includes('INSERT INTO upload_cleanup_claims')));
    expect(claim?.[1].sql).toContain('UPDATE storage_reservations SET expires_at');
    expect(db.executed.some((item) => item.sql.startsWith('DELETE FROM upload_cleanup_claims'))).toBe(false);
  });

  it('sets final text/file sizes and releases the reservation in the direct Queue activation batch', async () => {
    const db = recordingDb({
      activationState: { owner_username: 'alice', expected: 1, completed: 1, failed: 0, total_size: 5, text_content: 'é' },
      first: (sql) => sql.startsWith('SELECT * FROM upload_sessions WHERE id=?1') ? sessionRow() : undefined,
    });
    const current = runtime(db, {
      bucket: {
        head: vi.fn(async () => ({ size: 5, httpEtag: '"etag"' })),
        get: vi.fn(async () => ({ body: new Blob(['12345']).stream() })),
        put: vi.fn(async (key: string) => ({ key, size: 5, httpEtag: '"etag"' })),
      },
    });
    const message = queueMessage({ type: 'finalize-upload', sessionId: 'upl_1' });

    await worker.queue!(queueBatch([message]), current.env);

    const activation = db.batches.find((batch) => batch.some((item) => item.sql.includes('SET status="active"') && item.sql.includes('text_size')))!;
    expect(db.executed.find((item) => item.sql.includes('INSERT INTO storage_reservations'))?.values[3]).toBe(7);
    expect(activation[0].values.slice(0, 2)).toEqual([2, 5]);
    expect(activation[1].sql).toMatch(/status\s*=\s*'released'/);
    expect(message.ack).toHaveBeenCalledOnce();
    expect(message.retry).not.toHaveBeenCalled();
  });

  it('keeps activation and release rollback-coupled when the Queue batch fails', async () => {
    const db = recordingDb({
      activationState: { owner_username: 'alice', expected: 1, completed: 1, failed: 0, total_size: 5, text_content: '' },
      first: (sql) => sql.startsWith('SELECT * FROM upload_sessions WHERE id=?1') ? sessionRow() : undefined,
      batch: (items) => {
        if (items.some((item) => item.sql.includes('SET status="active"') && item.sql.includes('text_size'))) {
          throw new Error('activation transaction failed');
        }
      },
    });
    const current = runtime(db, {
      bucket: {
        head: vi.fn(async () => ({ size: 5, httpEtag: '"etag"' })),
        get: vi.fn(async () => ({ body: new Blob(['12345']).stream() })),
        put: vi.fn(async (key: string) => ({ key, size: 5, httpEtag: '"etag"' })),
      },
    });
    const message = queueMessage({ type: 'finalize-upload', sessionId: 'upl_1' });

    await worker.queue!(queueBatch([message]), current.env);

    const failedBatch = db.batches.find((batch) => batch.some((item) => item.sql.includes('SET status="active"') && item.sql.includes('text_size')))!;
    expect(failedBatch.some((item) => /status\s*=\s*'released'/.test(item.sql))).toBe(true);
    expect(db.executed.filter((item) => /status\s*=\s*'released'/.test(item.sql) && !failedBatch.includes(item))).toEqual([]);
    expect(message.ack).not.toHaveBeenCalled();
    expect(message.retry).toHaveBeenCalledOnce();
  });

  it('retries Queue activation when the reservation expires before the atomic batch', async () => {
    const db = recordingDb({
      activationState: { owner_username: 'alice', expected: 1, completed: 1, failed: 0, total_size: 5, text_content: '' },
      first: (sql) => {
        if (sql.startsWith('SELECT * FROM upload_sessions WHERE id=?1')) return sessionRow();
        if (sql.startsWith('SELECT id, bytes, expires_at FROM storage_reservations')) {
          return { id: 'res_cnt_1', bytes: 5, expires_at: new Date(NOW + 60_000).toISOString() };
        }
        return undefined;
      },
      batch: (items) => items.some((item) => item.sql.includes('SET status="active"') && item.sql.includes('text_size'))
        ? [0, 0]
        : undefined,
    });
    const current = runtime(db, {
      bucket: {
        head: vi.fn(async () => ({ size: 5, httpEtag: '"etag"' })),
        get: vi.fn(async () => ({ body: new Blob(['12345']).stream() })),
        put: vi.fn(async (key: string) => ({ key, size: 5, httpEtag: '"etag"' })),
      },
    });
    const message = queueMessage({ type: 'finalize-upload', sessionId: 'upl_1' });

    await worker.queue!(queueBatch([message]), current.env);

    expect(message.ack).not.toHaveBeenCalled();
    expect(message.retry).toHaveBeenCalledOnce();
  });

  it('removes completed upload objects before expiring a terminally failed activation reservation', async () => {
    const timeline: string[] = [];
    const completedSession = sessionRow({
      status: 'completed',
      completed_parts: 1,
      uploaded_bytes: 5,
      etag: 'etag',
    });
    const db = recordingDb({
      timeline,
      activationState: { owner_username: 'alice', expected: 1, completed: 1, failed: 0, total_size: 5, text_content: '' },
      first: (sql) => {
        if (sql.startsWith('SELECT * FROM upload_sessions WHERE id=?1')) return completedSession;
        if (sql.startsWith('SELECT id, bytes, expires_at FROM storage_reservations')) {
          return { id: 'res_cnt_1', bytes: 5, expires_at: new Date(NOW + 60_000).toISOString() };
        }
        if (sql.startsWith('SELECT status FROM contents WHERE id=?1')) return { status: 'processing' };
        return undefined;
      },
      all: (sql) => {
        if (sql.startsWith('SELECT * FROM upload_sessions WHERE content_id=?1')) return [completedSession];
        if (sql.startsWith('SELECT object_key FROM attachments WHERE content_id=?1')) {
          return [{ object_key: 'attachments/alice/cnt_1/att_1' }];
        }
        return undefined;
      },
      batch: (items) => {
        if (items.some((item) => item.sql.includes('SET status="active"') && item.sql.includes('text_size'))) {
          throw new Error('activation transaction failed');
        }
      },
    });
    const current = runtime(db, { timeline });
    const message = queueMessage({ type: 'finalize-upload', sessionId: 'upl_1' }, 6);

    await worker.queue!(queueBatch([message]), current.env);

    expect(current.bucket.delete).toHaveBeenCalledWith('attachments/alice/cnt_1/att_1');
    const cleanup = db.batches.find((batch) => batch.some((item) => item.sql.includes('upload_queue_failed')))!;
    expect(sqlIndex(cleanup, 'UPDATE upload_sessions SET status="failed"')).toBeLessThan(sqlIndex(cleanup, 'UPDATE storage_reservations'));
    expect(sqlIndex(cleanup, 'UPDATE contents SET status="expired"')).toBeLessThan(sqlIndex(cleanup, 'UPDATE storage_reservations'));
    const reservationBatchIndex = timeline.findIndex((entry) => entry.includes('upload_queue_failed'));
    expect(timeline.findIndex((entry) => entry === 'r2:delete:attachments/alice/cnt_1/att_1')).toBeLessThan(reservationBatchIndex);
    expect(message.retry).toHaveBeenCalledOnce();
  });

  it('keeps terminal Queue metadata and reservation when finalized-object cleanup fails', async () => {
    const completedSession = sessionRow({
      status: 'completed',
      mode: 'multipart',
      upload_id: 'multipart_completed',
      object_key: 'attachments/alice/cnt_1/att_1',
      completed_parts: 1,
      uploaded_bytes: 5,
      etag: 'etag',
    });
    const db = recordingDb({
      activationState: { owner_username: 'alice', expected: 1, completed: 1, failed: 0, total_size: 5, text_content: '' },
      first: (sql) => {
        if (sql.startsWith('SELECT * FROM upload_sessions WHERE id=?1')) return completedSession;
        if (sql.startsWith('SELECT id, bytes, expires_at FROM storage_reservations')) {
          return { id: 'res_cnt_1', bytes: 5, expires_at: new Date(NOW + 60_000).toISOString() };
        }
        if (sql.startsWith('SELECT status FROM contents WHERE id=?1')) return { status: 'processing' };
        return undefined;
      },
      all: (sql) => {
        if (sql.startsWith('SELECT * FROM upload_sessions WHERE content_id=?1')) return [completedSession];
        if (sql.startsWith('SELECT object_key FROM attachments WHERE content_id=?1')) {
          return [{ object_key: completedSession.object_key }];
        }
        return undefined;
      },
      batch: (items) => {
        if (items.some((item) => item.sql.includes('SET status="active"') && item.sql.includes('text_size'))) {
          throw new Error('activation transaction failed');
        }
      },
    });
    const remove = vi.fn(async () => { throw new Error('R2 delete failed'); });
    const current = runtime(db, { bucket: { delete: remove } });
    const message = queueMessage({ type: 'finalize-upload', sessionId: 'upl_1' }, 6);

    await expect(worker.queue!(queueBatch([message]), current.env)).resolves.toBeUndefined();

    expect(remove).toHaveBeenCalledWith(completedSession.object_key);
    expect(db.batches.some((batch) => batch.some((item) => item.sql.includes('upload_queue_failed')))).toBe(false);
    expect(db.batches.some((batch) => batch.some((item) => item.sql.includes("SET status='expired'")))).toBe(false);
    expect(message.ack).not.toHaveBeenCalled();
    expect(message.retry).toHaveBeenCalledOnce();
  });

  it('does not reject upload metadata when integrity cleanup cannot delete the object', async () => {
    const session = sessionRow();
    const db = recordingDb({
      first: (sql) => {
        if (sql.startsWith('SELECT * FROM upload_sessions WHERE id = ?1 AND owner_username')) return session;
        if (sql.startsWith('SELECT id, bytes, expires_at FROM storage_reservations')) {
          return { id: 'res_cnt_1', bytes: session.size, expires_at: new Date(NOW + 60_000).toISOString() };
        }
        return undefined;
      },
    });
    const remove = vi.fn(async () => { throw new Error('R2 delete failed'); });
    const { response } = await invoke(db, '/api/uploads/upl_1/complete', { method: 'POST', body: '{}' }, {
      bucket: {
        head: vi.fn(async () => ({ size: session.size - 1, httpEtag: 'bad' })),
        delete: remove,
      },
    });

    expect(response.status).toBe(500);
    expect(remove).toHaveBeenCalledWith(session.object_key);
    expect(db.batches.some((batch) => batch.some((item) => item.sql.includes('UPDATE contents SET status="expired"')))).toBe(false);
    expect(db.batches.some((batch) => batch.some((item) => item.sql.includes("SET status='expired'")))).toBe(false);
  });

  it('does not cancel multipart metadata when its R2 abort fails', async () => {
    const session = sessionRow({ mode: 'multipart', upload_id: 'multipart_cancel' });
    const db = recordingDb({
      first: (sql) => sql.startsWith('SELECT * FROM upload_sessions WHERE id = ?1 AND owner_username') ? session : undefined,
    });
    const abort = vi.fn(async () => { throw new Error('R2 abort failed'); });
    const { response } = await invoke(db, '/api/uploads/upl_1', { method: 'DELETE' }, {
      bucket: { resumeMultipartUpload: vi.fn(() => ({ abort })) },
    });

    expect(response.status).toBe(500);
    expect(abort).toHaveBeenCalledOnce();
    expect(db.batches.some((batch) => batch.some((item) => item.sql.includes('status="cancelled"')))).toBe(false);
  });

  it('aborts multipart setup and deletes rows in FK-safe order after a direct setup failure', async () => {
    const timeline: string[] = [];
    const db = recordingDb({
      timeline,
      batch: (items) => {
        if (items.some((item) => item.sql.startsWith('INSERT INTO attachments'))) throw new Error('D1 setup failed');
      },
    });
    const current = runtime(db, { timeline });

    const response = await worker.fetch(request('/api/uploads/initiate', {
      method: 'POST',
      body: JSON.stringify({
        visibility: 'private',
        files: [{ name: 'rollback.bin', size: 20 * MiB, fingerprint: 'd'.repeat(64) }],
      }),
    }), current.env, { waitUntil() {} } as unknown as ExecutionContext);

    expect(response.status).toBe(500);
    expect(current.multipartAbort).toHaveBeenCalledOnce();
    const cleanup = db.executed.filter((item) => item.sql.startsWith('DELETE FROM'));
    expect(sqlIndex(cleanup, 'DELETE FROM upload_parts')).toBeLessThan(sqlIndex(cleanup, 'DELETE FROM upload_sessions'));
    expect(sqlIndex(cleanup, 'DELETE FROM upload_sessions')).toBeLessThan(sqlIndex(cleanup, 'DELETE FROM attachments'));
    expect(sqlIndex(cleanup, 'DELETE FROM attachments')).toBeLessThan(sqlIndex(cleanup, 'DELETE FROM storage_reservations'));
    expect(sqlIndex(cleanup, 'DELETE FROM storage_reservations')).toBeLessThan(sqlIndex(cleanup, 'DELETE FROM contents'));
    expect(timeline.findIndex((entry) => entry === 'r2:multipart-abort'))
      .toBeLessThan(timeline.findIndex((entry) => entry.includes('DELETE FROM storage_reservations')));
  });

  it('retains setup metadata and quota when multipart rollback cannot abort R2', async () => {
    const timeline: string[] = [];
    const abort = vi.fn(async () => {
      timeline.push('r2:multipart-abort-failed');
      throw new Error('R2 abort failed');
    });
    const db = recordingDb({
      timeline,
      batch: (items) => {
        if (items.some((item) => item.sql.startsWith('INSERT INTO attachments'))) throw new Error('D1 setup failed');
      },
    });
    const current = runtime(db, {
      timeline,
      bucket: {
        createMultipartUpload: vi.fn(async (key: string) => {
          timeline.push(`r2:create-multipart:${key}`);
          return { key, uploadId: 'multipart_rollback', abort };
        }),
      },
    });

    const response = await worker.fetch(request('/api/uploads/initiate', {
      method: 'POST',
      body: JSON.stringify({
        visibility: 'private',
        files: [{ name: 'rollback-failure.bin', size: 20 * MiB, fingerprint: 'e'.repeat(64) }],
      }),
    }), current.env, { waitUntil() {} } as unknown as ExecutionContext);

    expect(response.status).toBe(500);
    expect(abort).toHaveBeenCalledOnce();
    expect(db.executed.some((item) => item.sql.startsWith('DELETE FROM upload_sessions'))).toBe(false);
    expect(db.executed.some((item) => item.sql.startsWith('DELETE FROM storage_reservations'))).toBe(false);
    expect(db.executed.some((item) => item.sql.startsWith('DELETE FROM contents'))).toBe(false);
    const reservation = db.executed.find((item) => item.sql.includes('INSERT INTO storage_reservations'))!;
    expect(reservation.values.slice(0, 4)).toEqual([expect.stringMatching(/^res_cnt_/), 'alice', expect.stringMatching(/^cnt_/), 20 * MiB]);
    expect(timeline.findIndex((entry) => entry.includes('INSERT INTO storage_reservations')))
      .toBeLessThan(timeline.findIndex((entry) => entry.startsWith('r2:create-multipart:')));
  });
});
