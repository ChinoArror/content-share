import { buildUploadFingerprint } from './upload-resume';
import { MAX_UPLOAD_SIZE } from './transfer-policy';

export type UploadMode = 'single' | 'multipart';
export type UploadTaskStatus = 'queued' | 'initiating' | 'uploading' | 'paused' | 'complete' | 'failed';
const HEARTBEAT_INTERVAL_MS = 60 * 1000;

export interface UploadPartPlan {
  part_number: number;
  start: number;
  end: number;
  size: number;
  url: string;
  headers: Record<string, string>;
}

export interface UploadPlan {
  client_id: string;
  session_id: string;
  attachment_id: string;
  mode: UploadMode;
  size: number;
  upload_url?: string;
  headers?: Record<string, string>;
  upload_id?: string;
  parts?: UploadPartPlan[];
  completed_parts?: CompletedUploadPart[];
  next_part_number?: number | null;
  has_more_parts?: boolean;
  window_after?: number;
}

export interface ApiRequestOptions {
  method: 'GET' | 'POST';
  path: string;
  body?: unknown;
}

export type ApiRequest = <T>(request: ApiRequestOptions) => Promise<T>;

export interface XhrLike {
  status: number;
  response: unknown;
  onload: ((event: ProgressEvent<EventTarget>) => void) | null;
  onerror: ((event: ProgressEvent<EventTarget>) => void) | null;
  ontimeout: ((event: ProgressEvent<EventTarget>) => void) | null;
  upload: {
    onprogress: ((event: ProgressEvent<EventTarget>) => void) | null;
  };
  open(method: string, url: string, async?: boolean): void;
  setRequestHeader(name: string, value: string): void;
  getResponseHeader(name: string): string | null;
  send(body: XMLHttpRequestBodyInit): void;
  abort(): void;
}

export type XhrFactory = () => XhrLike;

export interface CompletedUploadPart {
  part_number: number;
  etag: string;
  size: number;
}

export interface UploadProgress {
  loaded: number;
  total: number;
}

export interface UploadTask {
  id: string;
  clientId: string;
  name: string;
  type: string;
  size: number;
  lastModified: number;
  fingerprint?: string;
  sessionId?: string;
  attachmentId?: string;
  mode?: UploadMode;
  status: UploadTaskStatus;
  completedParts: CompletedUploadPart[];
  progress: UploadProgress;
  needsFileReselection: boolean;
  error?: string;
  errorCode?: string;
  errorDetails?: Record<string, unknown>;
}

export interface UploadInput {
  file: File;
  clientId?: string;
  metadata?: Record<string, unknown>;
}

export interface UploadRestoreResult {
  tasks: UploadTask[];
  needsFileReselection: string[];
}

export interface UploadPersistence {
  loadAll(): Promise<ReadonlyArray<Record<string, unknown>>>;
  save(record: Record<string, unknown>): Promise<void>;
  remove(id: string): Promise<void>;
}

export interface BrowserUploadQueueOptions {
  api?: ApiRequest;
  xhrFactory?: XhrFactory;
  persistence?: UploadPersistence;
  clock?: () => number;
  sleep?: (milliseconds: number) => Promise<void>;
  onProgress?: (task: UploadTask) => void;
  maxConcurrentFiles?: number;
  maxConcurrentParts?: number;
  maxRetries?: number;
  retryBaseDelayMs?: number;
}

interface TaskState extends UploadTask {
  file?: File;
  metadata?: Record<string, unknown>;
  plan?: UploadPlan;
  partialPartBytes: Map<number, number>;
  lastHeartbeatAt?: number;
}

interface InitiateResponse {
  files?: UploadPlan[];
  plans?: UploadPlan[];
}

interface UploadStatusResponse {
  status?: string;
  completed_parts?: number;
  parts?: CompletedUploadPart[];
}

export class UploadRequestError extends Error {
  constructor(
    readonly status: number,
    message: string,
    readonly code?: string,
    readonly details?: Record<string, unknown>
  ) {
    super(message);
    this.name = 'UploadRequestError';
  }
}

class MemoryUploadPersistence implements UploadPersistence {
  private readonly records = new Map<string, Record<string, unknown>>();

  async loadAll(): Promise<ReadonlyArray<Record<string, unknown>>> {
    return [...this.records.values()].map((record) => structuredClone(record));
  }

  async save(record: Record<string, unknown>): Promise<void> {
    this.records.set(String(record.id), structuredClone(record));
  }

  async remove(id: string): Promise<void> {
    this.records.delete(id);
  }
}

export class IndexedDbUploadPersistence implements UploadPersistence {
  constructor(
    private readonly databaseName = 'content-share-upload-queue',
    private readonly storeName = 'tasks'
  ) {}

  async loadAll(): Promise<ReadonlyArray<Record<string, unknown>>> {
    const database = await this.open();
    try {
      return await new Promise<ReadonlyArray<Record<string, unknown>>>((resolve, reject) => {
        const request = database.transaction(this.storeName, 'readonly').objectStore(this.storeName).getAll();
        request.onsuccess = () => resolve(request.result as Record<string, unknown>[]);
        request.onerror = () => reject(request.error ?? new Error('Unable to load upload tasks'));
      });
    } finally {
      database.close();
    }
  }

  async save(record: Record<string, unknown>): Promise<void> {
    await this.write('put', record);
  }

  async remove(id: string): Promise<void> {
    await this.write('delete', id);
  }

  private async write(operation: 'put' | 'delete', value: Record<string, unknown> | string): Promise<void> {
    const database = await this.open();
    try {
      await new Promise<void>((resolve, reject) => {
        const transaction = database.transaction(this.storeName, 'readwrite');
        const request = operation === 'put'
          ? transaction.objectStore(this.storeName).put(value as Record<string, unknown>)
          : transaction.objectStore(this.storeName).delete(value as string);
        request.onerror = () => reject(request.error ?? new Error('Unable to persist upload task'));
        transaction.oncomplete = () => resolve();
        transaction.onerror = () => reject(transaction.error ?? new Error('Unable to persist upload task'));
      });
    } finally {
      database.close();
    }
  }

  private open(): Promise<IDBDatabase> {
    return new Promise((resolve, reject) => {
      if (typeof indexedDB === 'undefined') {
        reject(new Error('IndexedDB is unavailable in this environment'));
        return;
      }
      const request = indexedDB.open(this.databaseName, 1);
      request.onupgradeneeded = () => {
        if (!request.result.objectStoreNames.contains(this.storeName)) {
          request.result.createObjectStore(this.storeName, { keyPath: 'id' });
        }
      };
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error ?? new Error('Unable to open upload task database'));
    });
  }
}

export function createFetchApiRequest(fetcher: typeof fetch = fetch): ApiRequest {
  return async <T>({ method, path, body }: ApiRequestOptions): Promise<T> => {
    const response = await fetcher(path, {
      method,
      credentials: 'include',
      headers: body === undefined ? undefined : { 'content-type': 'application/json' },
      body: body === undefined ? undefined : JSON.stringify(body)
    });
    const payload = await response.json().catch(() => undefined);
    if (!response.ok) {
      const error = isRecord(payload) ? payload : {};
      throw new UploadRequestError(
        response.status,
        typeof error.message === 'string' ? error.message : `Upload API request failed with ${response.status}`,
        typeof error.code === 'string' ? error.code : undefined,
        isRecord(error.details) ? error.details : undefined
      );
    }
    return payload as T;
  };
}

export class BrowserUploadQueue {
  private readonly tasks = new Map<string, TaskState>();
  private readonly api: ApiRequest;
  private readonly xhrFactory: XhrFactory;
  private readonly persistence: UploadPersistence;
  private readonly clock: () => number;
  private readonly sleep: (milliseconds: number) => Promise<void>;
  private readonly onProgress?: (task: UploadTask) => void;
  private readonly maxConcurrentFiles: number;
  private readonly maxConcurrentParts: number;
  private readonly maxRetries: number;
  private readonly retryBaseDelayMs: number;
  private runPromise?: Promise<void>;

  constructor(options: BrowserUploadQueueOptions = {}) {
    const mobile = isTouchOrMobileBrowser();
    this.api = options.api ?? createFetchApiRequest();
    this.xhrFactory = options.xhrFactory ?? (() => new XMLHttpRequest());
    this.persistence = options.persistence ?? (typeof indexedDB === 'undefined'
      ? new MemoryUploadPersistence()
      : new IndexedDbUploadPersistence());
    this.clock = options.clock ?? Date.now;
    this.sleep = options.sleep ?? ((milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds)));
    this.onProgress = options.onProgress;
    this.maxConcurrentFiles = positiveInteger(options.maxConcurrentFiles, mobile ? 1 : 2);
    this.maxConcurrentParts = positiveInteger(options.maxConcurrentParts, mobile ? 2 : 3);
    this.maxRetries = nonNegativeInteger(options.maxRetries, 3);
    this.retryBaseDelayMs = positiveInteger(options.retryBaseDelayMs, 500);
  }

  async enqueue(inputs: readonly UploadInput[]): Promise<UploadTask[]> {
    const oversized = inputs.find((input) => input.file.size > MAX_UPLOAD_SIZE);
    if (oversized) throw new Error(`File exceeds 5 GiB: ${oversized.file.name}`);
    const added: UploadTask[] = [];
    for (const input of inputs) {
      const id = createId(this.clock());
      const task: TaskState = {
        id,
        clientId: input.clientId ?? id,
        name: input.file.name,
        type: input.file.type,
        size: input.file.size,
        lastModified: input.file.lastModified,
        fingerprint: await fingerprintForFile(input.file),
        status: 'queued',
        completedParts: [],
        progress: { loaded: 0, total: input.file.size },
        needsFileReselection: false,
        file: input.file,
        metadata: input.metadata,
        partialPartBytes: new Map()
      };
      this.tasks.set(id, task);
      await this.persist(task);
      added.push(this.snapshot(task));
    }
    return added;
  }

  getTasks(): UploadTask[] {
    return [...this.tasks.values()].map((task) => this.snapshot(task));
  }

  async restore(): Promise<UploadRestoreResult> {
    const records = await this.persistence.loadAll();
    for (const record of records) {
      const task = deserializeTask(record);
      if (!task) continue;
      this.tasks.set(task.id, task);
      if (task.sessionId && task.status !== 'complete') {
        try {
          const statusResponse = await this.api<UploadStatusResponse | { item: UploadStatusResponse }>({
            method: 'GET',
            path: `/api/uploads/${encodeURIComponent(task.sessionId)}/status`
          });
          const status = unwrapItem(statusResponse);
          if (Array.isArray(status.parts)) {
            task.completedParts = normalizeCompletedParts(status.parts);
            this.updateProgress(task);
          }
          if (status.status === 'completed' || status.status === 'active') {
            task.status = 'complete';
            task.needsFileReselection = false;
          }
        } catch (error) {
          assignTaskError(task, error);
        }
      }
      if (task.status !== 'complete') {
        task.needsFileReselection = !task.file;
        task.status = task.sessionId || !task.file ? 'paused' : 'queued';
      }
      await this.persist(task);
    }
    const tasks = this.getTasks();
    return {
      tasks,
      needsFileReselection: tasks.filter((task) => task.needsFileReselection).map((task) => task.id)
    };
  }

  async reselectFile(taskId: string, file: File): Promise<UploadTask> {
    const task = this.requireTask(taskId);
    if (task.name !== file.name || task.size !== file.size || task.lastModified !== file.lastModified) {
      throw new Error('Selected file does not match the paused upload');
    }
    task.file = file;
    task.fingerprint = await fingerprintForFile(file);
    task.error = undefined;
    task.errorCode = undefined;
    task.errorDetails = undefined;
    task.needsFileReselection = false;
    task.status = 'paused';
    await this.persist(task);
    return this.snapshot(task);
  }

  async remove(taskId: string): Promise<void> {
    this.tasks.delete(taskId);
    await this.persistence.remove(taskId);
  }

  async run(): Promise<void> {
    if (!this.runPromise) {
      this.runPromise = this.runInternal().finally(() => {
        this.runPromise = undefined;
      });
    }
    return this.runPromise;
  }

  private async runInternal(): Promise<void> {
    await this.initiateQueuedTasks();
    const runnable = [...this.tasks.values()].filter((task) => task.file && !task.needsFileReselection && task.status !== 'complete');
    await runWithConcurrency(runnable, this.maxConcurrentFiles, async (task) => {
      try {
        await this.uploadTask(task);
      } catch (error) {
        task.status = 'failed';
        assignTaskError(task, error);
        await this.persist(task);
        this.notify(task);
      }
    });
  }

  private async initiateQueuedTasks(): Promise<void> {
    const queued = [...this.tasks.values()].filter((task) => task.file && !task.sessionId && task.status === 'queued');
    if (!queued.length) return;
    for (const task of queued) {
      task.status = 'initiating';
      if (!task.fingerprint && task.file) task.fingerprint = await fingerprintForFile(task.file);
      await this.persist(task);
      this.notify(task);
    }
    try {
      const response = await this.api<InitiateResponse | UploadPlan[]>({
        method: 'POST',
        path: '/api/uploads/initiate',
        body: {
          files: queued.map((task) => ({
            client_id: task.clientId,
            name: task.name,
            type: task.type,
            size: task.size,
            last_modified: task.lastModified,
            fingerprint: task.fingerprint,
            metadata: task.metadata
          }))
        }
      });
      const plans = extractPlans(response);
      for (const task of queued) {
        const plan = plans.find((candidate) => candidate.client_id === task.clientId);
        if (!plan || plan.size !== task.size) {
          throw new Error(`Upload plan missing for ${task.name}`);
        }
        this.assignPlan(task, plan);
        task.status = 'paused';
        await this.persist(task);
        this.notify(task);
      }
    } catch (error) {
      for (const task of queued) {
        task.status = 'failed';
        assignTaskError(task, error);
        await this.persist(task);
        this.notify(task);
      }
      throw error;
    }
  }

  private async uploadTask(task: TaskState): Promise<void> {
    if (!task.file) throw new Error('File must be selected before upload can resume');
    if (!task.plan) await this.renewPlan(task);
    task.status = 'uploading';
    task.error = undefined;
    task.errorCode = undefined;
    task.errorDetails = undefined;
    await this.persist(task);
    this.notify(task);
    if (task.mode === 'single') {
      const etag = await this.uploadWithRetry(task, task.file, undefined);
      task.progress = { loaded: task.size, total: task.size };
      await this.complete(task, etag ? [] : []);
    } else {
      await this.uploadMultipart(task);
      await this.complete(task, task.completedParts);
    }
    await this.waitForServerCompletion(task);
    task.status = 'complete';
    task.needsFileReselection = false;
    task.plan = undefined;
    await this.persist(task);
    this.notify(task);
  }

  private async uploadMultipart(task: TaskState): Promise<void> {
    if (!task.plan?.parts || !task.file) throw new Error('Multipart upload plan is incomplete');
    let window = task.plan;
    while (true) {
      const completed = new Set(task.completedParts.map((part) => part.part_number));
      const pending = (window.parts ?? []).filter((part) => !completed.has(part.part_number));
      const windowAfter = partWindowStart(window);
      await runWithConcurrency(pending, this.maxConcurrentParts, async (part) => {
        const file = task.file;
        if (!file) throw new Error('File must be selected before upload can resume');
        const body = file.slice(part.start, part.end, file.type);
        const etag = await this.uploadWithRetry(task, body, part.part_number, windowAfter);
        if (!etag) throw new Error(`Multipart upload did not return an ETag for part ${part.part_number}`);
        const completedPart = { part_number: part.part_number, etag, size: part.size };
        await this.api({
          method: 'POST',
          path: `/api/uploads/${encodeURIComponent(task.sessionId ?? '')}/part`,
          body: { attachment_id: task.attachmentId, ...completedPart }
        });
        task.completedParts = normalizeCompletedParts([...task.completedParts, completedPart]);
        task.partialPartBytes.delete(part.part_number);
        this.updateProgress(task);
        await this.persist(task);
        this.notify(task);
      });
      if (window.has_more_parts !== true) return;
      const after = partWindowEnd(window);
      window = await this.fetchPartWindow(task, after);
    }
  }

  private async uploadWithRetry(task: TaskState, body: Blob, partNumber: number | undefined, windowAfter = 0): Promise<string | null> {
    let retryCount = 0;
    let renewed = false;
    while (true) {
      const destination = this.destinationFor(task, partNumber);
      try {
        return await this.sendXhr(task, body, partNumber, destination.url, destination.headers);
      } catch (error) {
        const status = error instanceof UploadRequestError ? error.status : 0;
        if ((status === 401 || status === 403) && !renewed) {
          await this.renewPlan(task, windowAfter);
          renewed = true;
          continue;
        }
        if (!isTransientStatus(status) || retryCount >= this.maxRetries) throw error;
        const delay = this.retryBaseDelayMs * (2 ** retryCount);
        retryCount += 1;
        await this.sleep(delay);
      }
    }
  }

  private sendXhr(
    task: TaskState,
    body: Blob,
    partNumber: number | undefined,
    url: string,
    headers: Record<string, string>
  ): Promise<string | null> {
    return new Promise((resolve, reject) => {
      const xhr = this.xhrFactory();
      xhr.open('PUT', url, true);
      for (const [name, value] of Object.entries(headers)) xhr.setRequestHeader(name, value);
      xhr.upload.onprogress = (event) => {
        if (!event.lengthComputable) return;
        if (partNumber === undefined) {
          task.progress = { loaded: Math.min(event.loaded, task.size), total: task.size };
        } else {
          task.partialPartBytes.set(partNumber, Math.min(event.loaded, body.size));
          this.updateProgress(task);
        }
        void this.touchSession(task);
        this.notify(task);
      };
      xhr.onload = () => {
        if (xhr.status >= 200 && xhr.status < 300) {
          resolve(cleanEtag(xhr.getResponseHeader('etag')));
        } else {
          reject(new UploadRequestError(xhr.status, `Upload request failed with ${xhr.status}`));
        }
      };
      xhr.onerror = () => reject(new UploadRequestError(0, 'Network error while uploading'));
      xhr.ontimeout = () => reject(new UploadRequestError(0, 'Upload request timed out'));
      xhr.send(body);
    });
  }

  private async complete(task: TaskState, parts: CompletedUploadPart[]): Promise<void> {
    if (!task.sessionId) throw new Error('Upload session is missing');
    await this.api({
      method: 'POST',
      path: `/api/uploads/${encodeURIComponent(task.sessionId)}/complete`,
      body: {
        attachment_id: task.attachmentId,
        parts: parts.map((part) => ({ ...part }))
      }
    });
  }

  private async waitForServerCompletion(task: TaskState): Promise<void> {
    if (!task.sessionId) throw new Error('Upload session is missing');
    for (let attempt = 0; attempt < 60; attempt += 1) {
      const response = await this.api<UploadStatusResponse | { item: UploadStatusResponse }>({
        method: 'GET',
        path: `/api/uploads/${encodeURIComponent(task.sessionId)}/status`
      });
      const status = unwrapItem(response);
      if (status.status === 'completed' || status.status === 'active') return;
      if (status.status === 'failed' || status.status === 'cancelled' || status.status === 'expired') {
        throw new Error(`Upload validation failed: ${status.status}`);
      }
      await this.sleep(1000);
    }
    throw new Error('Upload validation timed out; the task was kept for recovery');
  }

  private async fetchPartWindow(task: TaskState, after: number): Promise<UploadPlan> {
    if (!task.sessionId) throw new Error('Upload session is missing');
    const response = await this.api<UploadPlan | { item: UploadPlan }>({
      method: 'GET',
      path: `/api/uploads/${encodeURIComponent(task.sessionId)}/parts?after=${after}&limit=8`
    });
    const plan = mergePlans(task.plan, { ...unwrapItem(response), window_after: after });
    this.assignPlan(task, plan);
    return plan;
  }

  private async renewPlan(task: TaskState, after = 0): Promise<void> {
    if (!task.sessionId) throw new Error('Upload session is missing');
    const response = await this.api<UploadPlan | { plan: UploadPlan } | { item: UploadPlan }>({
      method: 'POST',
      path: `/api/uploads/${encodeURIComponent(task.sessionId)}/renew`,
      body: { attachment_id: task.attachmentId, after, limit: 8 }
    });
    const plan = 'plan' in response ? response.plan : unwrapItem(response);
    this.assignPlan(task, mergePlans(task.plan, { ...plan, window_after: after }));
  }

  private destinationFor(task: TaskState, partNumber: number | undefined): { url: string; headers: Record<string, string> } {
    const plan = task.plan;
    if (!plan) throw new Error('Upload plan is missing');
    if (partNumber === undefined) {
      if (!plan.upload_url) throw new Error('Single upload URL is missing');
      return { url: plan.upload_url, headers: plan.headers ?? {} };
    }
    const part = plan.parts?.find((candidate) => candidate.part_number === partNumber);
    if (!part) throw new Error(`Upload URL is missing for part ${partNumber}`);
    return { url: part.url, headers: part.headers };
  }

  private assignPlan(task: TaskState, plan: UploadPlan): void {
    validatePlan(plan, task.size);
    task.sessionId = plan.session_id;
    task.attachmentId = plan.attachment_id;
    task.mode = plan.mode;
    task.plan = plan;
    if (plan.completed_parts) {
      task.completedParts = normalizeCompletedParts([...task.completedParts, ...plan.completed_parts]);
      this.updateProgress(task);
    }
  }

  private async touchSession(task: TaskState): Promise<void> {
    if (!task.sessionId) return;
    const current = this.clock();
    if (task.lastHeartbeatAt !== undefined && current - task.lastHeartbeatAt < HEARTBEAT_INTERVAL_MS) return;
    task.lastHeartbeatAt = current;
    try {
      await this.api({
        method: 'POST',
        path: `/api/uploads/${encodeURIComponent(task.sessionId)}/heartbeat`,
        body: { fingerprint: task.fingerprint }
      });
    } catch {
      // A heartbeat is advisory; the upload request remains authoritative.
    }
  }

  private updateProgress(task: TaskState): void {
    const completed = task.completedParts.reduce((total, part) => total + part.size, 0);
    const partial = [...task.partialPartBytes.values()].reduce((total, bytes) => total + bytes, 0);
    task.progress = { loaded: Math.min(task.size, completed + partial), total: task.size };
  }

  private async persist(task: TaskState): Promise<void> {
    const record: Record<string, unknown> = {
      id: task.id,
      client_id: task.clientId,
      name: task.name,
      type: task.type,
      size: task.size,
      last_modified: task.lastModified,
      fingerprint: task.fingerprint,
      session_id: task.sessionId,
      attachment_id: task.attachmentId,
      mode: task.mode,
      status: task.status,
      error: task.error,
      error_code: task.errorCode,
      error_details: task.errorDetails,
      completed_parts: task.completedParts,
      progress: task.progress,
      metadata: task.metadata,
      updated_at: this.clock()
    };
    if (task.file && task.status !== 'complete') record.file_blob = task.file;
    try {
      await this.persistence.save(record);
    } catch (error) {
      if (!('file_blob' in record)) throw error;
      delete record.file_blob;
      await this.persistence.save(record);
    }
  }

  private snapshot(task: TaskState): UploadTask {
    const { file: _file, metadata: _metadata, plan: _plan, partialPartBytes: _partial, ...snapshot } = task;
    return {
      ...snapshot,
      completedParts: snapshot.completedParts.map((part) => ({ ...part })),
      progress: { ...snapshot.progress }
    };
  }

  private notify(task: TaskState): void {
    this.onProgress?.(this.snapshot(task));
  }

  private requireTask(taskId: string): TaskState {
    const task = this.tasks.get(taskId);
    if (!task) throw new Error(`Unknown upload task: ${taskId}`);
    return task;
  }
}

function extractPlans(response: InitiateResponse | UploadPlan[]): UploadPlan[] {
  if (Array.isArray(response)) return response;
  return response.files ?? response.plans ?? [];
}

function unwrapItem<T>(response: T | { item: T }): T {
  return isRecord(response) && 'item' in response ? response.item as T : response as T;
}

function mergePlans(previous: UploadPlan | undefined, renewed: UploadPlan): UploadPlan {
  if (!previous) return renewed;
  const completedParts = normalizeCompletedParts([
    ...(previous.completed_parts ?? []),
    ...(renewed.completed_parts ?? [])
  ]);
  return {
    ...previous,
    ...renewed,
    headers: renewed.headers ?? previous.headers,
    parts: renewed.parts ?? previous.parts,
    completed_parts: completedParts.length ? completedParts : undefined
  };
}

function partWindowStart(plan: UploadPlan): number {
  if (Number.isInteger(plan.window_after) && Number(plan.window_after) >= 0) return Number(plan.window_after);
  const first = plan.parts?.reduce((minimum, part) => Math.min(minimum, part.part_number), Number.POSITIVE_INFINITY);
  return Number.isFinite(first) ? Math.max(0, Number(first) - 1) : 0;
}

function partWindowEnd(plan: UploadPlan): number {
  const last = plan.parts?.reduce((maximum, part) => Math.max(maximum, part.part_number), 0) ?? 0;
  if (last > 0) return last;
  if (typeof plan.next_part_number === 'number' && plan.next_part_number > 0) return plan.next_part_number - 1;
  throw new Error('Multipart upload window did not advance');
}

function validatePlan(plan: UploadPlan, expectedSize: number): void {
  if (!plan.session_id || !plan.attachment_id || plan.size !== expectedSize) {
    throw new Error('Upload plan does not match the selected file');
  }
  if (plan.mode === 'single' && !plan.upload_url) throw new Error('Single upload plan is missing an upload URL');
  if (plan.mode === 'multipart' && !Array.isArray(plan.parts)) throw new Error('Multipart upload plan is missing parts');
}

function deserializeTask(record: Record<string, unknown>): TaskState | null {
  if (typeof record.id !== 'string' || typeof record.client_id !== 'string' || typeof record.name !== 'string'
    || typeof record.type !== 'string' || typeof record.size !== 'number' || typeof record.last_modified !== 'number') {
    return null;
  }
  const completed = Array.isArray(record.completed_parts) ? normalizeCompletedParts(record.completed_parts) : [];
  const progress = isProgress(record.progress)
    ? { loaded: Math.min(record.progress.loaded, record.size), total: record.size }
    : { loaded: completed.reduce((total, part) => total + part.size, 0), total: record.size };
  const file = restorePersistedFile(record);
  return {
    id: record.id,
    clientId: record.client_id,
    name: record.name,
    type: record.type,
    size: record.size,
      lastModified: record.last_modified,
    sessionId: typeof record.session_id === 'string' ? record.session_id : undefined,
    attachmentId: typeof record.attachment_id === 'string' ? record.attachment_id : undefined,
    fingerprint: typeof record.fingerprint === 'string' ? record.fingerprint : undefined,
    mode: record.mode === 'single' || record.mode === 'multipart' ? record.mode : undefined,
    status: isTaskStatus(record.status) ? record.status : 'paused',
    error: typeof record.error === 'string' ? record.error : undefined,
    errorCode: typeof record.error_code === 'string' ? record.error_code : undefined,
    errorDetails: isRecord(record.error_details) ? record.error_details : undefined,
    completedParts: completed,
    progress,
    needsFileReselection: !file,
    file,
    metadata: isRecord(record.metadata) ? record.metadata : undefined,
    partialPartBytes: new Map()
  };
}

async function fingerprintForFile(file: File): Promise<string> {
  const sampleSize = 1024 * 1024;
  const head = await file.slice(0, Math.min(sampleSize, file.size)).arrayBuffer();
  const tail = await file.slice(Math.max(0, file.size - sampleSize), file.size).arrayBuffer();
  return buildUploadFingerprint({
    name: file.name,
    size: file.size,
    type: file.type,
    lastModified: file.lastModified,
    head,
    tail
  });
}

function restorePersistedFile(record: Record<string, unknown>): File | undefined {
  if (!(record.file_blob instanceof Blob) || record.file_blob.size !== record.size) return undefined;
  if (typeof File !== 'undefined') {
    return new File([record.file_blob], String(record.name), {
      type: String(record.type),
      lastModified: Number(record.last_modified)
    });
  }
  const blob = record.file_blob as File;
  Object.defineProperties(blob, {
    name: { value: String(record.name) },
    lastModified: { value: Number(record.last_modified) }
  });
  return blob;
}

function normalizeCompletedParts(parts: unknown[]): CompletedUploadPart[] {
  const byNumber = new Map<number, CompletedUploadPart>();
  for (const part of parts) {
    if (!isRecord(part) || typeof part.part_number !== 'number' || typeof part.etag !== 'string' || typeof part.size !== 'number') continue;
    byNumber.set(part.part_number, { part_number: part.part_number, etag: part.etag, size: part.size });
  }
  return [...byNumber.values()].sort((left, right) => left.part_number - right.part_number);
}

function runWithConcurrency<T>(items: readonly T[], limit: number, work: (item: T) => Promise<void>): Promise<void> {
  let next = 0;
  const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (next < items.length) {
      const item = items[next++];
      await work(item);
    }
  });
  return Promise.all(workers).then(() => undefined);
}

function isTransientStatus(status: number): boolean {
  return status === 0 || status === 408 || status === 429 || status >= 500;
}

function cleanEtag(etag: string | null): string | null {
  return etag?.replace(/^"|"$/g, '') ?? null;
}

function positiveInteger(value: number | undefined, fallback: number): number {
  return typeof value === 'number' && Number.isInteger(value) && value > 0 ? value : fallback;
}

function nonNegativeInteger(value: number | undefined, fallback: number): number {
  return typeof value === 'number' && Number.isInteger(value) && value >= 0 ? value : fallback;
}

function isTouchOrMobileBrowser(): boolean {
  return typeof navigator !== 'undefined'
    && (navigator.maxTouchPoints > 0 || /android|iphone|ipad|ipod|mobile/i.test(navigator.userAgent));
}

function createId(now: number): string {
  if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') return crypto.randomUUID();
  return `upload-${now}-${Math.random().toString(36).slice(2)}`;
}

function isTaskStatus(value: unknown): value is UploadTaskStatus {
  return value === 'queued' || value === 'initiating' || value === 'uploading' || value === 'paused' || value === 'complete' || value === 'failed';
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isProgress(value: unknown): value is UploadProgress {
  return isRecord(value) && typeof value.loaded === 'number' && typeof value.total === 'number';
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : 'Upload failed';
}

function assignTaskError(task: TaskState, error: unknown): void {
  task.error = errorMessage(error);
  task.errorCode = error instanceof UploadRequestError ? error.code : undefined;
  task.errorDetails = error instanceof UploadRequestError ? error.details : undefined;
}
