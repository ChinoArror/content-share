import { describe, expect, it } from 'vitest';
import {
  BrowserUploadQueue,
  type ApiRequest,
  type ApiRequestOptions,
  type UploadPersistence,
  type UploadPlan,
  type XhrLike
} from './upload-client';

function makeFile(name: string, bytes: number, type = 'application/octet-stream'): File {
  const blob = new Blob([new Uint8Array(bytes)], { type }) as File;
  Object.defineProperties(blob, {
    name: { value: name },
    lastModified: { value: 1_700_000_000_000 }
  });
  return blob;
}

class MemoryPersistence implements UploadPersistence {
  private readonly records = new Map<string, Record<string, unknown>>();

  async loadAll() {
    return [...this.records.values()];
  }

  async save(record: Record<string, unknown>) {
    this.records.set(String(record.id), structuredClone(record));
  }

  async remove(id: string) {
    this.records.delete(id);
  }

  recordsForTest() {
    return [...this.records.values()];
  }
}

class FakeXhr implements XhrLike {
  status = 0;
  response: unknown = null;
  onload: (() => void) | null = null;
  onerror: (() => void) | null = null;
  ontimeout: (() => void) | null = null;
  upload: XhrLike['upload'] = { onprogress: null };
  method = '';
  url = '';
  body: XMLHttpRequestBodyInit | null = null;
  headers: Record<string, string> = {};

  constructor(private readonly result: { status?: number; etag?: string; networkError?: boolean }) {}

  open(method: string, url: string) {
    this.method = method;
    this.url = url;
  }

  setRequestHeader(name: string, value: string) {
    this.headers[name] = value;
  }

  getResponseHeader(name: string) {
    return name.toLowerCase() === 'etag' ? this.result.etag ?? null : null;
  }

  send(body: XMLHttpRequestBodyInit) {
    this.body = body;
    const total = body instanceof Blob ? body.size : 1;
    this.upload.onprogress?.({ lengthComputable: true, loaded: total, total } as ProgressEvent<EventTarget>);
    queueMicrotask(() => {
      if (this.result.networkError) {
        this.onerror?.();
        return;
      }
      this.status = this.result.status ?? 200;
      this.onload?.();
    });
  }

  abort() {}
}

function apiFrom(handler: (request: ApiRequestOptions) => unknown | Promise<unknown>): ApiRequest {
  return async <T>(request: ApiRequestOptions) => handler(request) as Promise<T>;
}

describe('BrowserUploadQueue', () => {
  it('uploads a single-file plan with byte progress and finalizes it', async () => {
    const requests: ApiRequestOptions[] = [];
    const progress: number[] = [];
    const persistence = new MemoryPersistence();
    const plan: UploadPlan = {
      client_id: 'client-a',
      session_id: 'session-a',
      attachment_id: 'attachment-a',
      mode: 'single',
      size: 4,
      upload_url: 'https://signed.example/upload-a',
      headers: { 'content-type': 'text/plain' }
    };
    const queue = new BrowserUploadQueue({
      api: apiFrom((request) => {
        requests.push(request);
        if (request.path === '/api/uploads/initiate') return { files: [plan] };
        if (request.path.endsWith('/status')) return { ok: true, item: { status: 'completed', completed_parts: 1, parts: [] } };
        return { ok: true };
      }),
      xhrFactory: () => new FakeXhr({ etag: '"single-etag"' }),
      persistence,
      onProgress: (task) => progress.push(task.progress.loaded)
    });

    await queue.enqueue([{ file: makeFile('note.txt', 4, 'text/plain'), clientId: 'client-a' }]);
    await queue.run();

    expect(requests.map((request) => `${request.method} ${request.path}`)).toEqual([
      'POST /api/uploads/initiate',
      'POST /api/uploads/session-a/heartbeat',
      'POST /api/uploads/session-a/complete',
      'GET /api/uploads/session-a/status'
    ]);
    expect(progress).toContain(4);
    expect(queue.getTasks()[0]).toMatchObject({ status: 'complete', progress: { loaded: 4, total: 4 } });
    expect(JSON.stringify(persistence.recordsForTest())).not.toContain('signed.example');
  });

  it('marks every queued task failed when upload-session initiation is rejected', async () => {
    const persistence = new MemoryPersistence();
    const progress: string[] = [];
    const queue = new BrowserUploadQueue({
      api: apiFrom(() => { throw new Error('File exceeds 100 MiB'); }),
      persistence,
      onProgress: (task) => progress.push(task.status)
    });

    await queue.enqueue([{ file: makeFile('large.zip', 4), clientId: 'client-large' }]);
    await expect(queue.run()).rejects.toThrow('File exceeds 100 MiB');

    expect(queue.getTasks()[0]).toMatchObject({ status: 'failed', error: 'File exceeds 100 MiB' });
    expect(progress).toContain('failed');
    expect(persistence.recordsForTest()[0]).toMatchObject({ status: 'failed', error: 'File exceeds 100 MiB' });
  });

  it('limits multipart part concurrency and reports each ETag before completion', async () => {
    const MiB = 1024 * 1024;
    const requests: ApiRequestOptions[] = [];
    let active = 0;
    let maxActive = 0;
    const plan: UploadPlan = {
      client_id: 'client-b',
      session_id: 'session-b',
      attachment_id: 'attachment-b',
      mode: 'multipart',
      size: 12 * MiB,
      upload_id: 'r2-upload-b',
      parts: [
        { part_number: 1, start: 0, end: 4 * MiB, size: 4 * MiB, url: 'https://signed.example/part-1', headers: {} },
        { part_number: 2, start: 4 * MiB, end: 8 * MiB, size: 4 * MiB, url: 'https://signed.example/part-2', headers: {} },
        { part_number: 3, start: 8 * MiB, end: 12 * MiB, size: 4 * MiB, url: 'https://signed.example/part-3', headers: {} }
      ]
    };
    const queue = new BrowserUploadQueue({
      api: apiFrom((request) => {
        requests.push(request);
        if (request.path === '/api/uploads/initiate') return { files: [plan] };
        if (request.path.endsWith('/status')) return { ok: true, item: { status: 'completed', completed_parts: 3, parts: [] } };
        return { ok: true };
      }),
      xhrFactory: () => {
        const xhr = new FakeXhr({ etag: `"part-${requests.length}"` });
        const originalSend = xhr.send.bind(xhr);
        xhr.send = (body) => {
          active += 1;
          maxActive = Math.max(maxActive, active);
          originalSend(body);
          queueMicrotask(() => { active -= 1; });
        };
        return xhr;
      },
      maxConcurrentParts: 2
    });

    await queue.enqueue([{ file: makeFile('video.bin', 12 * MiB), clientId: 'client-b' }]);
    await queue.run();

    expect(maxActive).toBeLessThanOrEqual(2);
    expect(requests.filter((request) => request.path.endsWith('/part'))).toHaveLength(3);
    expect(requests).toContainEqual(expect.objectContaining({ method: 'POST', path: '/api/uploads/session-b/complete' }));
    expect(requests.at(-1)).toMatchObject({ method: 'GET', path: '/api/uploads/session-b/status' });
    expect(queue.getTasks()[0].status).toBe('complete');
  });

  it('retries transient upload failures with exponential backoff', async () => {
    const sleeps: number[] = [];
    let attempt = 0;
    const queue = new BrowserUploadQueue({
      api: apiFrom((request) => request.path === '/api/uploads/initiate'
        ? { files: [{ client_id: 'client-c', session_id: 'session-c', attachment_id: 'attachment-c', mode: 'single', size: 1, upload_url: 'https://signed.example/retry', headers: {} }] }
        : request.path.endsWith('/status')
          ? { ok: true, item: { status: 'completed', completed_parts: 1, parts: [] } }
        : { ok: true }),
      xhrFactory: () => new FakeXhr({ networkError: attempt++ === 0 }),
      sleep: async (milliseconds) => { sleeps.push(milliseconds); }
    });

    await queue.enqueue([{ file: makeFile('retry.txt', 1), clientId: 'client-c' }]);
    await queue.run();

    expect(attempt).toBe(2);
    expect(sleeps).toEqual([500]);
    expect(queue.getTasks()[0].status).toBe('complete');
  });

  it('restores session state without signed URLs and asks for file reselection', async () => {
    const persistence = new MemoryPersistence();
    await persistence.save({
      id: 'task-d',
      name: 'resume.pdf',
      type: 'application/pdf',
      size: 8,
      last_modified: 1,
      client_id: 'client-d',
      session_id: 'session-d',
      attachment_id: 'attachment-d',
      mode: 'multipart',
      status: 'paused',
      completed_parts: [],
      progress: { loaded: 0, total: 8 }
    });
    const queue = new BrowserUploadQueue({
      api: apiFrom((request) => {
        expect(request).toMatchObject({ method: 'GET', path: '/api/uploads/session-d/status' });
        return { ok: true, item: { status: 'uploading', completed_parts: 1, parts: [{ part_number: 1, etag: 'etag-1', size: 4 }] } };
      }),
      xhrFactory: () => new FakeXhr({}) ,
      persistence
    });

    const restored = await queue.restore();

    expect(restored.needsFileReselection).toEqual(['task-d']);
    expect(restored.tasks[0]).toMatchObject({ id: 'task-d', status: 'paused', needsFileReselection: true, progress: { loaded: 4, total: 8 } });
    expect(JSON.stringify(persistence.recordsForTest())).not.toContain('signed.example');
  });

  it('does not finish until Queue validation reports the session completed', async () => {
    let statusChecks = 0;
    const queue = new BrowserUploadQueue({
      api: apiFrom((request) => {
        if (request.path === '/api/uploads/initiate') {
          return { files: [{ client_id: 'client-f', session_id: 'session-f', attachment_id: 'attachment-f', mode: 'single', size: 1, upload_url: 'https://signed.example/finalize', headers: {} }] };
        }
        if (request.path.endsWith('/status')) {
          statusChecks += 1;
          return { ok: true, item: { status: statusChecks === 1 ? 'uploading' : 'completed', completed_parts: statusChecks === 1 ? 0 : 1, parts: [] } };
        }
        return { ok: true };
      }),
      xhrFactory: () => new FakeXhr({ etag: 'etag-final' }),
      sleep: async () => undefined
    });

    await queue.enqueue([{ file: makeFile('final.txt', 1), clientId: 'client-f' }]);
    await queue.run();

    expect(statusChecks).toBe(2);
    expect(queue.getTasks()[0].status).toBe('complete');
  });

  it('restores a locally persisted File when IndexedDB supports structured cloning it', async () => {
    const persistence = new MemoryPersistence();
    const file = makeFile('resume.mp4', 8, 'video/mp4');
    await persistence.save({
      id: 'task-e',
      name: file.name,
      type: file.type,
      size: file.size,
      last_modified: file.lastModified,
      client_id: 'client-e',
      status: 'queued',
      completed_parts: [],
      progress: { loaded: 0, total: file.size },
      file_blob: file
    });
    const queue = new BrowserUploadQueue({ persistence, xhrFactory: () => new FakeXhr({}) });

    const restored = await queue.restore();

    expect(restored.needsFileReselection).toEqual([]);
    expect(restored.tasks[0]).toMatchObject({ id: 'task-e', needsFileReselection: false, status: 'queued' });
  });

  it('re-initiates a persisted file when refresh happened before session creation', async () => {
    const persistence = new MemoryPersistence();
    const file = makeFile('early.bin', 2);
    await persistence.save({
      id: 'task-early', name: file.name, type: file.type, size: file.size, last_modified: file.lastModified,
      client_id: 'client-early', status: 'initiating', completed_parts: [], progress: { loaded: 0, total: file.size }, file_blob: file
    });
    let initiated = 0;
    const queue = new BrowserUploadQueue({
      persistence,
      xhrFactory: () => new FakeXhr({ etag: 'early-etag' }),
      api: apiFrom((request) => {
        if (request.path === '/api/uploads/initiate') {
          initiated += 1;
          return { files: [{ client_id: 'client-early', session_id: 'session-early', attachment_id: 'attachment-early', mode: 'single', size: 2, upload_url: 'https://signed.example/early', headers: {} }] };
        }
        if (request.path.endsWith('/status')) return { item: { status: 'completed', completed_parts: 1, parts: [] } };
        return { ok: true };
      })
    });

    await queue.restore();
    await queue.run();

    expect(initiated).toBe(1);
    expect(queue.getTasks()[0].status).toBe('complete');
  });

  it('requeues finalization when every multipart part was uploaded before refresh', async () => {
    const persistence = new MemoryPersistence();
    const file = makeFile('ready.bin', 8);
    const parts = [
      { part_number: 1, etag: 'one', size: 4 },
      { part_number: 2, etag: 'two', size: 4 }
    ];
    await persistence.save({
      id: 'task-ready', name: file.name, type: file.type, size: file.size, last_modified: file.lastModified,
      client_id: 'client-ready', session_id: 'session-ready', attachment_id: 'attachment-ready', mode: 'multipart',
      status: 'uploading', completed_parts: parts, progress: { loaded: 8, total: 8 }, file_blob: file
    });
    const requests: ApiRequestOptions[] = [];
    let statusChecks = 0;
    const queue = new BrowserUploadQueue({
      persistence,
      sleep: async () => undefined,
      xhrFactory: () => new FakeXhr({}),
      api: apiFrom((request) => {
        requests.push(request);
        if (request.path.endsWith('/renew')) return { item: { session_id: 'session-ready', attachment_id: 'attachment-ready', mode: 'multipart', size: 8, parts: [] } };
        if (request.path.endsWith('/status')) {
          statusChecks += 1;
          return { item: { status: statusChecks === 1 ? 'uploading' : 'completed', completed_parts: 2, parts } };
        }
        return { ok: true };
      })
    });

    await queue.restore();
    await queue.run();

    expect(requests.some((request) => request.path.endsWith('/complete'))).toBe(true);
    expect(queue.getTasks()[0].status).toBe('complete');
  });

  it('sends a SHA-256 fingerprint and activity heartbeat for a direct upload', async () => {
    const requests: ApiRequestOptions[] = [];
    const queue = new BrowserUploadQueue({
      api: apiFrom((request) => {
        requests.push(request);
        if (request.path === '/api/uploads/initiate') return {
          files: [{ client_id: 'client-fingerprint', session_id: 'session-fingerprint', attachment_id: 'attachment-fingerprint', mode: 'single', size: 4, upload_url: 'https://signed.example/fingerprint', headers: {} }]
        };
        if (request.path.endsWith('/status')) return { ok: true, item: { status: 'completed', completed_parts: 1, parts: [] } };
        return { ok: true };
      }),
      xhrFactory: () => new FakeXhr({ etag: 'fingerprint-etag' })
    });

    await queue.enqueue([{ file: makeFile('fingerprint.txt', 4), clientId: 'client-fingerprint' }]);
    await queue.run();

    const initiate = requests.find((request) => request.path === '/api/uploads/initiate');
    expect((initiate?.body as { files: Array<{ fingerprint?: string }> }).files[0].fingerprint).toMatch(/^[a-f0-9]{64}$/);
    expect(requests.some((request) => request.path === '/api/uploads/session-fingerprint/heartbeat')).toBe(true);
  });
});
