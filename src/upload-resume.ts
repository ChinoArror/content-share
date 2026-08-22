export const UPLOAD_INACTIVITY_MS = 30 * 60 * 1000;

export type UploadFingerprintInput = {
  name: string;
  size: number;
  type: string;
  lastModified: number;
  head: ArrayBuffer | Uint8Array;
  tail: ArrayBuffer | Uint8Array;
};

export type ResumableUploadSession = {
  status: string;
  file_fingerprint?: string | null;
  last_activity_at?: string | null;
  updated_at?: string | null;
  created_at?: string | null;
};

const RESUMABLE_STATUSES = new Set(['pending', 'uploading', 'completing']);
const CLEANUP_STATUSES = new Set(['pending', 'uploading', 'completing', 'failed']);

function bytes(value: ArrayBuffer | Uint8Array): Uint8Array {
  return value instanceof Uint8Array ? value : new Uint8Array(value);
}

function joinBytes(...values: Uint8Array[]): Uint8Array {
  const total = values.reduce((sum, value) => sum + value.byteLength, 0);
  const result = new Uint8Array(total);
  let offset = 0;
  for (const value of values) {
    result.set(value, offset);
    offset += value.byteLength;
  }
  return result;
}

export async function sha256Hex(value: ArrayBuffer | Uint8Array): Promise<string> {
  const input = new Uint8Array(bytes(value).byteLength);
  input.set(bytes(value));
  const digest = await crypto.subtle.digest('SHA-256', input.buffer);
  return [...new Uint8Array(digest)].map((part) => part.toString(16).padStart(2, '0')).join('');
}

export async function buildUploadFingerprint(input: UploadFingerprintInput): Promise<string> {
  const metadata = new TextEncoder().encode(JSON.stringify([
    input.name,
    input.size,
    input.type,
    input.lastModified
  ]));
  const separator = new Uint8Array([0]);
  return sha256Hex(joinBytes(metadata, separator, bytes(input.head), separator, bytes(input.tail)));
}

function activityTimestamp(session: ResumableUploadSession): number {
  const value = session.last_activity_at || session.updated_at || session.created_at;
  return value ? Date.parse(value) : Number.NaN;
}

export function isUploadSessionReusable(
  session: ResumableUploadSession,
  fingerprint: string,
  nowMs = Date.now(),
  inactivityMs = UPLOAD_INACTIVITY_MS
): boolean {
  const activity = activityTimestamp(session);
  return RESUMABLE_STATUSES.has(session.status)
    && Boolean(fingerprint)
    && session.file_fingerprint === fingerprint
    && Number.isFinite(activity)
    && nowMs >= activity
    && nowMs - activity <= inactivityMs;
}

export function isUploadSessionStale(
  session: ResumableUploadSession,
  nowMs = Date.now(),
  inactivityMs = UPLOAD_INACTIVITY_MS
): boolean {
  const activity = activityTimestamp(session);
  return CLEANUP_STATUSES.has(session.status)
    && Number.isFinite(activity)
    && nowMs - activity > inactivityMs;
}
