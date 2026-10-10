import { buildPartPlan, buildPartWindow, chooseUploadMode, finalizedObjectKey, isContentReadyForActivation, MAX_PARTS_PER_WINDOW, MAX_UPLOAD_SIZE, normalizeUploadFilename, parseByteRange, safeObjectKey, safeStagingObjectKey } from './transfer-policy';
import { presignR2Request } from './r2-signer';
import { issueMediaTicket, verifyMediaTicket } from './media-ticket';
import { parseCookie, serializeShareMediaCookie, serializeSharePasswordCookie, shareMediaCookieName, sharePasswordCookieName, SHARE_PASSWORD_TTL_SECONDS } from './share-cookie';
import { isUploadSessionReusable, isUploadSessionStale, UPLOAD_INACTIVITY_MS } from './upload-resume';
import { previewKind } from './preview-policy';
import { ensureUserGroup, loadUserAccessProfile, reserveStorage } from './worker-permissions';
import { PERMISSION_KEYS, PolicyError, type PermissionKey, type UserAccessProfile } from './permission-policy';
import { mergeUiSettings, sanitizeUiSettings } from './ui-settings';

type Env = {
  DB: D1Database;
  BUCKET: R2Bucket;
  UPLOAD_QUEUE: Queue<UploadMessage | R2EventMessage>;
  ASSETS: Fetcher;
  SSO_URL: string;
  SSO_APP_ID: string;
  MEDIA_TICKET_SECRET: string;
  PUBLIC_BASE_URL: string;
  ADMIN_CONTACT_EMAIL?: string;
  R2_ACCOUNT_ID?: string;
  R2_BUCKET_NAME?: string;
  R2_UPLOAD_ACCESS_KEY_ID?: string;
  R2_UPLOAD_SECRET_ACCESS_KEY?: string;
  R2_DOWNLOAD_ACCESS_KEY_ID?: string;
  R2_DOWNLOAD_SECRET_ACCESS_KEY?: string;
};

type User = {
  id: string;
  uuid?: string;
  user_id?: number;
  username: string;
  name?: string;
  role: 'admin' | 'user';
  avatar_url?: string;
};

type UploadMessage = {
  type: 'finalize-upload';
  contentId?: string;
  owner?: string;
  sessionId?: string;
} | {
  type: 'complete-multipart';
  sessionId: string;
};

type R2EventMessage = {
  action: 'PutObject' | 'CompleteMultipartUpload' | 'CopyObject' | string;
  bucket: string;
  object: {
    key: string;
    size?: number;
    eTag?: string;
  };
};

type DirectUploadFile = {
  client_id?: string;
  name: string;
  size: number;
  type?: string;
  last_modified?: number;
  fingerprint?: string;
  metadata?: Record<string, unknown>;
};

type UploadSessionRow = {
  id: string;
  content_id: string;
  attachment_id: string;
  owner_username: string;
  object_key: string;
  filename: string;
  content_type: string;
  size: number;
  mode: 'single' | 'multipart';
  upload_id: string | null;
  expected_parts: number;
  completed_parts: number;
  uploaded_bytes: number;
  status: string;
  etag?: string | null;
  file_fingerprint?: string | null;
  expires_at: string;
  last_activity_at?: string | null;
  created_at?: string | null;
  updated_at?: string | null;
};

type UploadPartRecord = {
  part_number: number;
  etag: string;
  size: number;
  completed_at: string;
};

const JSON_HEADERS = { 'content-type': 'application/json; charset=utf-8' };
const ALLOWED_VISIBILITY = new Set(['public', 'internal', 'private']);
const ALLOWED_FORMAT = new Set(['plain', 'markdown']);
const ALLOWED_STATUS = new Set(['active', 'expired', 'deleted', 'processing']);
const UPLOAD_SIGNATURE_TTL_SECONDS = 5 * 60;
const DOWNLOAD_SIGNATURE_TTL_SECONDS = 60;
const MEDIA_TICKET_TTL_SECONDS = 10 * 60;
const UPLOAD_SESSION_TTL_MS = 24 * 60 * 60 * 1000;
const UPLOAD_CLEANUP_CLAIM_MS = 10 * 60 * 1000;
const LEGACY_UPLOAD_LIMIT = 100 * 1024 * 1024;
const QUEUE_MAX_ATTEMPTS = 6;
const MAX_PENDING_UPLOAD_SESSIONS_PER_USER = 50;
const RESUMABLE_SESSION_STATUSES = '"pending","uploading","completing"';
const CLEANUP_SESSION_STATUSES = '"pending","uploading","completing","failed"';

function json(data: unknown, status = 200, extraHeaders?: HeadersInit): Response {
  const headers = new Headers(JSON_HEADERS);
  if (extraHeaders) new Headers(extraHeaders).forEach((value, key) => headers.set(key, value));
  return new Response(JSON.stringify(data), { status, headers });
}

function noContent(): Response {
  return new Response(null, { status: 204 });
}

function now(): string {
  return new Date().toISOString();
}

function dayStartIso(): string {
  const d = new Date();
  d.setUTCHours(0, 0, 0, 0);
  return d.toISOString();
}

function id(prefix: string): string {
  return `${prefix}_${crypto.randomUUID().replaceAll('-', '')}`;
}

function randomSlug(): string {
  const bytes = new Uint8Array(8);
  crypto.getRandomValues(bytes);
  return base64Url(bytes).slice(0, 11);
}

function base64Url(bytes: Uint8Array): string {
  let bin = '';
  for (const byte of bytes) bin += String.fromCharCode(byte);
  return btoa(bin).replaceAll('+', '-').replaceAll('/', '_').replaceAll('=', '');
}

function utf8(input: string): Uint8Array {
  return new TextEncoder().encode(input);
}

async function sha256Hex(input: string): Promise<string> {
  const bytes = utf8(input);
  const digest = await crypto.subtle.digest('SHA-256', bytes.buffer as ArrayBuffer);
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

async function hashWithSalt(value?: string | null): Promise<{ hash: string | null; salt: string | null }> {
  if (!value) return { hash: null, salt: null };
  const saltBytes = new Uint8Array(16);
  crypto.getRandomValues(saltBytes);
  const salt = base64Url(saltBytes);
  return { hash: await sha256Hex(`${salt}:${value}`), salt };
}

async function verifyHash(value: string | null, hash: string | null, salt: string | null): Promise<boolean> {
  if (!hash || !salt) return true;
  if (!value) return false;
  return (await sha256Hex(`${salt}:${value}`)) === hash;
}

async function keyHash(value: string): Promise<string> {
  return sha256Hex(`api-key:${value}`);
}

function bearer(req: Request): string | null {
  const raw = req.headers.get('authorization') || '';
  const match = raw.match(/^Bearer\s+(.+)$/i);
  return match ? match[1].trim() : null;
}

function decodeJwtPayload(token: string): Record<string, unknown> {
  const part = token.split('.')[1];
  if (!part) return {};
  const normalized = part.replaceAll('-', '+').replaceAll('_', '/');
  const padded = normalized.padEnd(Math.ceil(normalized.length / 4) * 4, '=');
  try {
    return JSON.parse(atob(padded));
  } catch {
    return {};
  }
}

function publicBase(env: Env, req: Request): string {
  return env.PUBLIC_BASE_URL || new URL(req.url).origin;
}

function normalizeSlug(input?: string | null): string {
  const raw = (input || '').trim();
  if (!raw) return randomSlug();
  const slug = raw.toLowerCase().replace(/[^a-z0-9_-]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 80);
  return slug || randomSlug();
}

function numberField(value: FormDataEntryValue | string | number | null | undefined, fallback = 0): number {
  const n = Number(value ?? fallback);
  return Number.isFinite(n) && n >= 0 ? Math.floor(n) : fallback;
}

function allowDownloadField(value: unknown, fallback = 1): number {
  if (value === undefined || value === null || value === '') return fallback;
  if (value === true || value === 1 || value === 'true' || value === '1') return 1;
  if (value === false || value === 0 || value === 'false' || value === '0') return 0;
  throw new HttpError(400, 'allow_download must be boolean', 'INVALID_DOWNLOAD_SETTING');
}

function textField(value: FormDataEntryValue | string | null | undefined): string {
  return typeof value === 'string' ? value.trim() : '';
}

function nullableText(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  return trimmed ? trimmed : null;
}

const EXTENSION_TYPES: Record<string, string> = {
  pdf: 'application/pdf', doc: 'application/msword', docx: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  xls: 'application/vnd.ms-excel', xlsx: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  ppt: 'application/vnd.ms-powerpoint', pptx: 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
  jpg: 'image/jpeg', jpeg: 'image/jpeg', png: 'image/png', gif: 'image/gif', webp: 'image/webp', avif: 'image/avif', svg: 'image/svg+xml', bmp: 'image/bmp', ico: 'image/x-icon',
  mp4: 'video/mp4', webm: 'video/webm', mov: 'video/quicktime', m4v: 'video/x-m4v', ogv: 'video/ogg',
  mp3: 'audio/mpeg', wav: 'audio/wav', m4a: 'audio/mp4', aac: 'audio/aac', flac: 'audio/flac', oga: 'audio/ogg', ogg: 'audio/ogg',
  txt: 'text/plain', md: 'text/markdown', csv: 'text/csv', json: 'application/json', xml: 'application/xml', html: 'text/html', htm: 'text/html', css: 'text/css', js: 'text/javascript', ts: 'text/plain', log: 'text/plain'
};

function contentTypeFor(filename: string, supplied?: string | null): string {
  if (supplied && supplied !== 'application/octet-stream') return supplied;
  return EXTENSION_TYPES[filename.split('.').pop()?.toLowerCase() || ''] || 'application/octet-stream';
}

function attachmentDisposition(filename: string, mode: 'inline' | 'attachment' = 'attachment'): string {
  const safeName = normalizeUploadFilename(filename);
  const asciiName = safeName.replace(/[^\x20-\x7e]/g, '_').replace(/"/g, '_');
  return `${mode}; filename="${asciiName}"; filename*=UTF-8''${encodeURIComponent(safeName)}`;
}

function normalizeEtag(value: string | null | undefined): string {
  return (value || '').trim().replace(/^"|"$/g, '');
}

function directUploadConfigured(env: Env): boolean {
  return Boolean(
    env.R2_ACCOUNT_ID && env.R2_BUCKET_NAME &&
    /^[A-Za-z0-9]{32}$/.test(env.R2_UPLOAD_ACCESS_KEY_ID || '') &&
    env.R2_UPLOAD_SECRET_ACCESS_KEY
  );
}

function directDownloadConfigured(env: Env): boolean {
  return Boolean(
    env.R2_ACCOUNT_ID && env.R2_BUCKET_NAME &&
    /^[A-Za-z0-9]{32}$/.test(env.R2_DOWNLOAD_ACCESS_KEY_ID || '') &&
    env.R2_DOWNLOAD_SECRET_ACCESS_KEY
  );
}

async function fallbackUploadFingerprint(file: Pick<DirectUploadFile, 'name' | 'size' | 'type' | 'last_modified'>): Promise<string> {
  return sha256Hex(JSON.stringify([
    file.name,
    Number(file.size),
    file.type || '',
    Number(file.last_modified || 0)
  ]));
}

function textSize(value: string | null | undefined): number {
  return utf8(value || '').byteLength;
}

function reservationIdForContent(contentId: string): string {
  return `res_${contentId}`;
}

function reservationExpiresAt(): string {
  return new Date(Date.now() + UPLOAD_INACTIVITY_MS).toISOString();
}

function uploadSessionExpiresAt(): string {
  return new Date(Date.now() + UPLOAD_SESSION_TTL_MS).toISOString();
}

function assertTransferFileSize(size: number): void {
  try {
    buildPartPlan(size);
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Invalid file size';
    if (size > MAX_UPLOAD_SIZE) {
      throw new HttpError(413, 'File exceeds the 5 GiB limit', 'FILE_TOO_LARGE', {
        file_size: size,
        max_file_bytes: MAX_UPLOAD_SIZE,
      });
    }
    throw new HttpError(400, message, 'INVALID_FILE_SIZE', { file_size: size });
  }
}

function partWindowCursor(value: unknown): number {
  const cursor = Number(value);
  return Number.isSafeInteger(cursor) && cursor >= 0 ? cursor : 0;
}

function partWindowLimit(value: unknown): number {
  const limit = Number(value);
  return Number.isSafeInteger(limit) && limit > 0
    ? Math.min(limit, MAX_PARTS_PER_WINDOW)
    : MAX_PARTS_PER_WINDOW;
}

async function touchUploadSession(env: Env, sessionId: string): Promise<void> {
  const timestamp = now();
  const results = await env.DB.batch([
    env.DB.prepare(
      `UPDATE upload_sessions SET last_activity_at=?1, updated_at=?1, expires_at=?2
       WHERE id=?3 AND status IN (${RESUMABLE_SESSION_STATUSES})
         AND NOT EXISTS (
           SELECT 1 FROM upload_cleanup_claims c
           WHERE c.content_id=upload_sessions.content_id
             AND julianday(c.expires_at) > julianday('now')
         )`
    ).bind(timestamp, uploadSessionExpiresAt(), sessionId),
    env.DB.prepare(
      `UPDATE storage_reservations SET expires_at=?2, updated_at=?1
       WHERE content_id=(SELECT content_id FROM upload_sessions WHERE id=?3)
         AND status='active' AND julianday(expires_at) > julianday('now')
         AND NOT EXISTS (
           SELECT 1 FROM upload_cleanup_claims c
           WHERE c.content_id=storage_reservations.content_id
             AND julianday(c.expires_at) > julianday('now')
         )`
    ).bind(timestamp, reservationExpiresAt(), sessionId),
  ]);
  if (Number(results[0]?.meta.changes || 0) !== 1) {
    throw new HttpError(409, 'Upload cleanup is in progress', 'UPLOAD_CLEANUP_IN_PROGRESS');
  }
}

async function findReusableUploadSessions(
  env: Env,
  owner: string,
  files: Array<{ size: number; fingerprint: string }>
): Promise<{ content: { id: string; slug: string; status: string; text_content: string | null }; sessions: UploadSessionRow[] } | null> {
  const cutoff = new Date(Date.now() - UPLOAD_INACTIVITY_MS).toISOString();
  const candidates = await Promise.all(files.map(async (file) => {
    const session = await env.DB.prepare(
      `SELECT * FROM upload_sessions WHERE owner_username=?1 AND file_fingerprint=?2 AND size=?3 AND last_activity_at>=?4 AND status IN (${RESUMABLE_SESSION_STATUSES}) ORDER BY last_activity_at DESC LIMIT 1`
    ).bind(owner, file.fingerprint, file.size, cutoff).first<UploadSessionRow>();
    return session && isUploadSessionReusable(session, file.fingerprint) ? session : null;
  }));
  if (candidates.some((session) => !session)) return null;
  const sessions = candidates as UploadSessionRow[];
  if (new Set(sessions.map((session) => session.id)).size !== sessions.length) return null;
  const contentId = sessions[0]?.content_id;
  if (!contentId || sessions.some((session) => session.content_id !== contentId)) return null;
  const count = await env.DB.prepare('SELECT COUNT(*) count FROM upload_sessions WHERE content_id=?1').bind(contentId).first<{ count: number }>();
  if (Number(count?.count || 0) !== files.length) return null;
  const content = await env.DB.prepare('SELECT id, slug, status, text_content FROM contents WHERE id=?1').bind(contentId).first<{ id: string; slug: string; status: string; text_content: string | null }>();
  if (!content || content.status !== 'processing') return null;
  return { content, sessions };
}

async function signedUploadUrl(env: Env, session: Pick<UploadSessionRow, 'object_key' | 'filename' | 'content_type'>, query?: Record<string, string | number>) {
  if (!directUploadConfigured(env)) throw new HttpError(503, 'Direct R2 upload is not configured');
  const headers = query ? undefined : {
    'content-type': session.content_type,
    'content-disposition': attachmentDisposition(session.filename),
    'cache-control': 'private, no-store'
  };
  return presignR2Request({
    accountId: env.R2_ACCOUNT_ID!,
    bucket: env.R2_BUCKET_NAME!,
    key: session.object_key,
    method: 'PUT',
    expiresIn: UPLOAD_SIGNATURE_TTL_SECONDS,
    accessKeyId: env.R2_UPLOAD_ACCESS_KEY_ID!,
    secretAccessKey: env.R2_UPLOAD_SECRET_ACCESS_KEY!,
    headers,
    query
  });
}

async function signedDownloadUrl(env: Env, objectKey: string): Promise<string | null> {
  if (!directDownloadConfigured(env)) return null;
  const signed = await presignR2Request({
    accountId: env.R2_ACCOUNT_ID!,
    bucket: env.R2_BUCKET_NAME!,
    key: objectKey,
    method: 'GET',
    expiresIn: DOWNLOAD_SIGNATURE_TTL_SECONDS,
    accessKeyId: env.R2_DOWNLOAD_ACCESS_KEY_ID!,
    secretAccessKey: env.R2_DOWNLOAD_SECRET_ACCESS_KEY!
  });
  return signed.url;
}

function isExpired(row: { status: string; expire_at?: string | null; max_views: number; view_count: number }): boolean {
  if (row.status === 'expired') return true;
  if (row.expire_at && Date.parse(row.expire_at) <= Date.now()) return true;
  if (row.max_views > 0 && row.view_count >= row.max_views) return true;
  return false;
}

function isExpiredIgnoringViews(row: { status: string; expire_at?: string | null }): boolean {
  return row.status === 'expired' || Boolean(row.expire_at && Date.parse(row.expire_at) <= Date.now());
}

function contentTicketKey(contentId: string): string {
  return `content:${contentId}`;
}

async function readJson<T>(req: Request): Promise<T> {
  try {
    return (await req.json()) as T;
  } catch {
    throw new HttpError(400, 'Invalid JSON request body');
  }
}

class HttpError extends Error {
  status: number;
  code?: string;
  details?: Record<string, unknown>;

  constructor(status: number, message: string, code?: string, details?: Record<string, unknown>) {
    super(message);
    this.status = status;
    this.code = code;
    this.details = details;
  }
}

const PERMISSION_ERRORS: Record<PermissionKey, { code: string; message: string }> = {
  can_public_publish: { code: 'PUBLIC_PUBLISH_PERMISSION_REQUIRED', message: 'Public publish permission required' },
  can_api: { code: 'API_PERMISSION_REQUIRED', message: 'API permission required' },
  can_internal_access: { code: 'INTERNAL_ACCESS_PERMISSION_REQUIRED', message: 'Internal access permission required' },
  can_upload: { code: 'STORAGE_PERMISSION_REQUIRED', message: 'Storage permission required' },
  can_comment: { code: 'COMMENT_PERMISSION_REQUIRED', message: 'Comment permission required' },
};

function requirePermission(profile: UserAccessProfile, permission: PermissionKey): void {
  if (profile.permissions[permission]) return;
  const error = PERMISSION_ERRORS[permission];
  throw new HttpError(403, error.message, error.code);
}

function requireStorageCreation(profile: UserAccessProfile): void {
  if (profile.quota_bytes <= 0) {
    throw new HttpError(403, PERMISSION_ERRORS.can_upload.message, PERMISSION_ERRORS.can_upload.code);
  }
  requirePermission(profile, 'can_upload');
}

function requireVisibility(profile: UserAccessProfile, visibility: string): void {
  if (visibility === 'public') requirePermission(profile, 'can_public_publish');
  if (visibility === 'internal') requirePermission(profile, 'can_internal_access');
}

async function requireCreationAccess(env: Env, owner: string, visibility: string): Promise<UserAccessProfile> {
  const profile = await loadUserAccessProfile(env.DB, owner);
  requireStorageCreation(profile);
  requireVisibility(profile, visibility);
  return profile;
}

async function assertInternalShareAccess(env: Env, row: any, user: User | null): Promise<void> {
  if (row.visibility !== 'internal') return;
  if (!user) throw new HttpError(401, 'Login required', 'LOGIN_REQUIRED');
  requirePermission(await loadUserAccessProfile(env.DB, user.username), 'can_internal_access');
}

async function verifySso(req: Request, env: Env, tokenOverride?: string): Promise<User> {
  const token = tokenOverride || bearer(req);
  if (!token) throw new HttpError(401, 'Missing auth-center token');
  const payload = decodeJwtPayload(token);
  const exp = typeof payload.exp === 'number' ? payload.exp : 0;
  if (exp && exp * 1000 < Date.now()) throw new HttpError(401, 'auth-center token expired');

  const verifyUrl = `${env.SSO_URL.replace(/\/$/, '')}/api/verify?app_id=${encodeURIComponent(env.SSO_APP_ID)}`;
  const verifyRes = await fetch(verifyUrl, {
    method: 'GET',
    headers: { authorization: `Bearer ${token}` },
    signal: AbortSignal.timeout(8000)
  });
  if (!verifyRes.ok) throw new HttpError(403, `auth-center verification failed: HTTP ${verifyRes.status}`);

  let verifyBody: any = {};
  try {
    verifyBody = await verifyRes.json();
  } catch {
    verifyBody = {};
  }
  const source = verifyBody.user || verifyBody || {};
  const uuid = String(source.uuid || source.sub || payload.uuid || payload.sub || '').trim();
  const candidateUsername = String(source.username || payload.username || source.name || payload.name || '').trim() ||
    (uuid ? `u_${uuid.slice(0, 12)}` : '');
  if (!candidateUsername) throw new HttpError(403, 'auth-center token does not include username');
  const username = await resolveInternalUsername(env.DB, candidateUsername, uuid);
  const roleRaw = String(source.role || payload.role || '').toLowerCase();
  const role: 'admin' | 'user' = roleRaw === 'admin' ? 'admin' : 'user';
  const avatarUrl = String(
    source.avatar_url ||
      source.avatarUrl ||
      source.avatar ||
      source.picture ||
      source.photo_url ||
      source.photo ||
      payload.avatar_url ||
      payload.avatarUrl ||
      payload.avatar ||
      payload.picture ||
      payload.photo_url ||
      payload.photo ||
      ''
  ).trim();
  const user: User = {
    id: uuid || username,
    uuid,
    user_id: Number(source.user_id || payload.user_id || 0) || undefined,
    username,
    name: String(source.name || payload.name || candidateUsername),
    role,
    avatar_url: avatarUrl
  };
  await upsertUser(env.DB, user);
  await ensureUserGroup(env.DB, user.username, user.role);
  return user;
}

async function optionalUser(req: Request, env: Env): Promise<User | null> {
  const token = bearer(req);
  if (!token) return null;
  try {
    return await verifySso(req, env, token);
  } catch {
    return null;
  }
}

function sharePassword(req: Request): string | null {
  const value = req.headers.get('x-share-password');
  return value?.trim() || null;
}

function passwordCookieKey(contentId: string): string {
  return `password:${contentId}`;
}

async function sharePasswordCookieTicket(env: Env, req: Request, row: any): Promise<Awaited<ReturnType<typeof verifyMediaTicket>>> {
  const value = parseCookie(req.headers.get('cookie'), sharePasswordCookieName(String(row.slug || '')));
  if (!value) return null;
  const ticket = await verifyMediaTicket(env.MEDIA_TICKET_SECRET, value, passwordCookieKey(String(row.id)));
  if (!ticket || ticket.adminPreview || ticket.policyVersion !== row.updated_at) return null;
  return ticket;
}

async function shareMediaCookieAccess(env: Env, req: Request, row: any): Promise<{ actor: string; adminPreview: boolean } | null> {
  const value = parseCookie(req.headers.get('cookie'), shareMediaCookieName(String(row.slug || '')));
  if (!value) return null;
  const ticket = await verifyMediaTicket(env.MEDIA_TICKET_SECRET, value, contentTicketKey(String(row.id)));
  if (!ticket?.actor || ticket.policyVersion !== row.updated_at) return null;
  if (row.status === 'processing') throw new HttpError(409, 'Upload is still processing');
  if (row.status === 'deleted' && !ticket.adminPreview) throw new HttpError(410, 'Content was deleted');
  if (isExpiredIgnoringViews(row) && !ticket.adminPreview) throw new HttpError(410, 'Content expired');
  if (row.visibility === 'internal') {
    requirePermission(await loadUserAccessProfile(env.DB, ticket.actor), 'can_internal_access');
  }
  if (row.visibility === 'private' && ticket.actor !== row.owner_username && !ticket.adminPreview) {
    throw new HttpError(403, 'Private content');
  }
  return { actor: ticket.actor, adminPreview: ticket.adminPreview };
}

async function issueShareMediaCookie(env: Env, row: any, actor: string, adminPreview: boolean): Promise<string> {
  const ticket = await issueMediaTicket(env.MEDIA_TICKET_SECRET, {
    attachmentId: contentTicketKey(row.id),
    actor,
    adminPreview,
    policyVersion: row.updated_at,
    expiresInSeconds: MEDIA_TICKET_TTL_SECONDS,
  });
  return serializeShareMediaCookie(shareMediaCookieName(row.slug), ticket, MEDIA_TICKET_TTL_SECONDS);
}

function requireAdmin(user: User): void {
  if (user.role !== 'admin') throw new HttpError(403, 'Admin permission required');
}

async function loadUiSettingsRow(db: D1Database, username: string): Promise<{ stored: unknown; updated_at: string | null }> {
  const row = await db.prepare('SELECT settings_json, updated_at FROM user_ui_settings WHERE username = ?1')
    .bind(username)
    .first<{ settings_json: string; updated_at: string }>();
  let stored: unknown = {};
  try {
    stored = row?.settings_json ? JSON.parse(row.settings_json) : {};
  } catch {
    stored = {};
  }
  return { stored, updated_at: row?.updated_at ?? null };
}

// Users are keyed by auth-center uuid; usernames may be reused by a different account.
// A known uuid keeps its existing internal username (stable across renames). A username
// already held by another uuid gets a uuid suffix so the two accounts never merge.
export async function resolveInternalUsername(db: D1Database, candidate: string, uuid: string): Promise<string> {
  if (!uuid) return candidate;
  const byUuid = await db.prepare('SELECT username, uuid FROM users WHERE uuid = ?1 LIMIT 1').bind(uuid).first<{ username: string; uuid: string | null }>();
  if (byUuid?.username) return String(byUuid.username);
  const byName = await db.prepare('SELECT uuid FROM users WHERE username = ?1 LIMIT 1').bind(candidate).first<{ uuid: string | null }>();
  if (byName?.uuid && byName.uuid !== uuid) return `${candidate}#${uuid.slice(0, 8)}`;
  return candidate;
}

async function upsertUser(db: D1Database, user: User): Promise<void> {
  const t = now();
  await db.prepare(
    'INSERT INTO users (id, uuid, username, name, role, avatar_url, created_at, updated_at, last_login_at) ' +
      'VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?7, ?7) ' +
      'ON CONFLICT(username) DO UPDATE SET uuid=excluded.uuid, name=excluded.name, role=excluded.role, avatar_url=COALESCE(NULLIF(excluded.avatar_url, ""), users.avatar_url), updated_at=excluded.updated_at, last_login_at=excluded.last_login_at'
  )
    .bind(user.id, user.uuid || null, user.username, user.name || user.username, user.role, user.avatar_url || null, t)
    .run();
  await db.prepare(
    'INSERT OR IGNORE INTO user_cli_settings (username, default_visibility, default_expire_days, default_max_views, default_format, default_endpoint, default_slug_mode, updated_at) VALUES (?1, "public", 0, 0, "markdown", "https://content.aryuki.com", "random", ?2)'
  )
    .bind(user.username, t)
    .run();
}

async function uniqueSlug(db: D1Database, preferred?: string | null): Promise<string> {
  for (let i = 0; i < 8; i++) {
    const candidate = normalizeSlug(i === 0 ? preferred : null);
    const hit = await db.prepare('SELECT id FROM contents WHERE slug = ?').bind(candidate).first();
    if (!hit) return candidate;
  }
  throw new HttpError(409, 'Could not generate a unique slug');
}

async function logAccess(env: Env, req: Request, data: { contentId: string; slug: string; username?: string | null; action: string }): Promise<void> {
  await env.DB.prepare(
    'INSERT INTO access_logs (id, content_id, slug, username, action, ip, user_agent, created_at) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8)'
  )
    .bind(
      id('log'),
      data.contentId,
      data.slug,
      data.username || null,
      data.action,
      req.headers.get('cf-connecting-ip') || null,
      req.headers.get('user-agent') || null,
      now()
    )
    .run();
}

function ipRegion(req: Request): string {
  const cf = (req as any).cf || {};
  return String(cf.region || cf.regionCode || cf.city || cf.country || '未知地区');
}

function publicUser(row: any): Record<string, unknown> {
  return {
    username: row.author_username,
    name: row.name || row.author_username,
    avatar_url: row.avatar_url || ''
  };
}

function noteTree(rows: any[]): any[] {
  const byId = new Map<string, any>();
  const roots: any[] = [];
  for (const row of rows) {
    const item = {
      id: row.id,
      parent_id: row.parent_id,
      body: row.body,
      visibility: row.visibility,
      mode: row.mode,
      ip_region: row.ip_region || '未知地区',
      created_at: row.created_at,
      updated_at: row.updated_at,
      author: publicUser(row),
      replies: [] as any[]
    };
    byId.set(item.id, item);
  }
  for (const item of byId.values()) {
    if (item.parent_id && byId.has(item.parent_id)) byId.get(item.parent_id).replies.push(item);
    else roots.push(item);
  }
  return roots;
}

async function loadShareContent(env: Env, slug: string): Promise<any> {
  const row = await env.DB.prepare('SELECT * FROM contents WHERE slug = ?').bind(slug).first<any>();
  if (!row) throw new HttpError(404, 'Content not found');
  return row;
}

async function listContentNotes(env: Env, row: any, user: User | null): Promise<any[]> {
  if (row.visibility === 'private') {
    if (user?.username !== row.owner_username) throw new HttpError(403, 'Memo is only visible to the owner');
    const { results } = await env.DB.prepare(
      'SELECT n.*, u.name, u.avatar_url FROM content_notes n LEFT JOIN users u ON u.username = n.author_username WHERE n.content_id = ?1 AND n.mode = "memo" AND n.deleted_at IS NULL ORDER BY n.created_at ASC'
    )
      .bind(row.id)
      .all<any>();
    return noteTree(results || []);
  }
  const { results } = await env.DB.prepare(
    'SELECT n.*, u.name, u.avatar_url FROM content_notes n LEFT JOIN users u ON u.username = n.author_username WHERE n.content_id = ?1 AND n.mode = "comment" AND n.deleted_at IS NULL AND (n.visibility = "public" OR n.author_username = ?2) ORDER BY n.created_at ASC'
  )
    .bind(row.id, user?.username || '')
    .all<any>();
  return noteTree(results || []);
}

function adminActionStatement(env: Env, admin: User, action: string, targetType: string, targetId: string, detail?: unknown): D1PreparedStatement {
  return env.DB.prepare(
    'INSERT INTO admin_actions (id, admin_username, action, target_type, target_id, detail, created_at) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7)'
  )
    .bind(id('adm'), admin.username, action, targetType, targetId, detail ? JSON.stringify(detail) : null, now());
}

async function adminAction(env: Env, admin: User, action: string, targetType: string, targetId: string, detail?: unknown): Promise<void> {
  await adminActionStatement(env, admin, action, targetType, targetId, detail).run();
}

async function contentWithAttachments(db: D1Database, contentId: string): Promise<any> {
  const content = await db.prepare('SELECT * FROM contents WHERE id = ?').bind(contentId).first<any>();
  if (!content) throw new HttpError(404, 'Content not found');
  const { results } = await db.prepare('SELECT id, filename, content_type, size, status, created_at FROM attachments WHERE content_id = ? ORDER BY created_at ASC').bind(contentId).all();
  return { ...content, attachments: results || [] };
}

async function shareContentWithAttachments(env: Env, contentId: string, actor?: string, adminPreview = false): Promise<any> {
  const content = await env.DB.prepare(
    'SELECT id, owner_username, title, slug, type, format, text_content, visibility, status, allow_download, password_hash, expire_at, max_views, view_count, download_count, file_size, remark, created_at, updated_at FROM contents WHERE id = ?1'
  ).bind(contentId).first<any>();
  if (!content) throw new HttpError(404, 'Content not found');
  const { results } = await env.DB.prepare(
    'SELECT id, filename, content_type, size, status, created_at FROM attachments WHERE content_id = ?1 AND status = "active" ORDER BY created_at ASC'
  ).bind(contentId).all<any>();
  const attachments = await Promise.all((results || []).map(async (attachment) => {
    const safeAttachment = {
      ...attachment,
      office_preview_allowed: content.visibility === 'public' && !content.password_hash,
    };
    if (content.password_hash) return safeAttachment;
    return {
      ...safeAttachment,
      media_ticket: await issueMediaTicket(env.MEDIA_TICKET_SECRET, {
        attachmentId: attachment.id,
        actor,
        adminPreview,
        policyVersion: content.updated_at,
        expiresInSeconds: MEDIA_TICKET_TTL_SECONDS
      })
    };
  }));
  const { password_hash: _passwordHash, ...safeContent } = content;
  return { ...safeContent, allow_download: Boolean(content.allow_download), password_required: Boolean(content.password_hash), attachments };
}

async function assertRestorableContent(env: Env, row: any): Promise<void> {
  if (!['deleted', 'expired'].includes(row.status)) throw new HttpError(409, 'Only deleted or expired content can be restored');
  const blocked = await env.DB.prepare(
    'SELECT COUNT(*) count FROM attachments a LEFT JOIN upload_sessions s ON s.attachment_id = a.id WHERE a.content_id = ?1 AND (a.status != "active" OR (s.id IS NOT NULL AND s.status != "completed"))'
  ).bind(row.id).first<{ count: number }>();
  if (Number(blocked?.count || 0) > 0) throw new HttpError(409, 'Content attachments have not passed upload validation');
}

async function assertShareAccess(env: Env, req: Request, row: any, user: User | null, password: string | null, adminPreview = false): Promise<void> {
  if (row.status === 'processing') throw new HttpError(409, 'Upload is still processing');
  if (row.status === 'deleted' && !(user?.role === 'admin' && adminPreview)) throw new HttpError(410, 'Content was deleted');
  if (isExpired(row) && !(user?.role === 'admin' && adminPreview)) throw new HttpError(410, 'Content expired');
  if (!(await verifyHash(password, row.password_hash, row.password_salt))) {
    await logAccess(env, req, { contentId: row.id, slug: row.slug, username: user?.username, action: 'denied' });
    throw new HttpError(423, 'Password required or incorrect', 'PASSWORD_REQUIRED_OR_INCORRECT');
  }
  await assertInternalShareAccess(env, row, user);
  if (row.visibility === 'private' && user?.username !== row.owner_username && !(user?.role === 'admin' && adminPreview)) {
    throw new HttpError(403, 'Private content');
  }
}

async function assertPasswordCookieAccess(env: Env, req: Request, row: any, user: User | null, adminPreview = false): Promise<boolean> {
  const ticket = await sharePasswordCookieTicket(env, req, row);
  if (!ticket) return false;
  if (row.status === 'processing') throw new HttpError(409, 'Upload is still processing');
  if (row.status === 'deleted' && !(user?.role === 'admin' && adminPreview)) throw new HttpError(410, 'Content was deleted');
  if (isExpiredIgnoringViews(row) && !(user?.role === 'admin' && adminPreview)) throw new HttpError(410, 'Content expired');
  await assertInternalShareAccess(env, row, user);
  if (row.visibility === 'private' && user?.username !== row.owner_username && !(user?.role === 'admin' && adminPreview)) {
    throw new HttpError(403, 'Private content');
  }
  return true;
}

type ShareAccess = { ticketAuthorized: boolean; adminPreview: boolean; actor?: string; passwordAuthorized?: boolean };

async function authorizeShareRequest(
  env: Env,
  req: Request,
  row: any,
  user: User | null,
  requestedAdminPreview: boolean
): Promise<ShareAccess> {
  const ticketValue = req.headers.get('x-share-ticket') || '';
  const ticket = ticketValue
    ? await verifyMediaTicket(env.MEDIA_TICKET_SECRET, ticketValue, contentTicketKey(row.id))
    : null;
  if (ticket && ticket.policyVersion === row.updated_at && !row.password_hash) {
    await assertInternalShareAccess(env, row, user);
    const adminPreview = ticket.adminPreview;
    if (row.status === 'processing') throw new HttpError(409, 'Upload is still processing');
    if (row.status === 'deleted' && !adminPreview) throw new HttpError(410, 'Content was deleted');
    if (isExpiredIgnoringViews(row) && !adminPreview) throw new HttpError(410, 'Content expired');
    if (row.visibility === 'private' && user?.username !== row.owner_username && !adminPreview) throw new HttpError(403, 'Private content');
    return { ticketAuthorized: true, adminPreview, actor: ticket.actor };
  }
  const adminPreview = requestedAdminPreview && user?.role === 'admin';
  if (row.password_hash && await assertPasswordCookieAccess(env, req, row, user, adminPreview)) {
    return { ticketAuthorized: true, adminPreview: false };
  }
  const directPassword = sharePassword(req);
  await assertShareAccess(env, req, row, user, sharePassword(req), adminPreview);
  return { ticketAuthorized: false, adminPreview, actor: user?.username, passwordAuthorized: Boolean(row.password_hash && directPassword) };
}

type ActiveStorageReservation = {
  id: string;
  bytes: number;
  expires_at: string;
};

async function reserveContentStorage(env: Env, owner: string, contentId: string, bytes: number): Promise<string | null> {
  return reserveStorage(env.DB, {
    id: reservationIdForContent(contentId),
    username: owner,
    contentId,
    bytes,
    expiresAt: reservationExpiresAt(),
  });
}

async function activeContentReservation(env: Env, owner: string, contentId: string): Promise<ActiveStorageReservation | null> {
  return env.DB.prepare(
    `SELECT id, bytes, expires_at FROM storage_reservations
     WHERE owner_username=?1 AND content_id=?2 AND status='active'
       AND julianday(expires_at) > julianday('now')
     LIMIT 1`
  ).bind(owner, contentId).first<ActiveStorageReservation>();
}

async function ensureReusableReservation(env: Env, owner: string, contentId: string, bytes: number): Promise<string> {
  const current = await activeContentReservation(env, owner, contentId);
  if (current) return current.id;
  return (await reserveContentStorage(env, owner, contentId, bytes)) || reservationIdForContent(contentId);
}

async function ensureUploadSessionReservation(env: Env, session: UploadSessionRow): Promise<string> {
  const current = await activeContentReservation(env, session.owner_username, session.content_id);
  if (current) return current.id;
  const requirement = await env.DB.prepare(
    `SELECT
       c.owner_username,
       c.text_content,
       COALESCE(SUM(s.size), 0) file_size
     FROM contents c
     JOIN upload_sessions s ON s.content_id=c.id
     WHERE c.id=?1 AND c.owner_username=?2 AND c.status='processing'
     GROUP BY c.id`
  ).bind(session.content_id, session.owner_username).first<{ owner_username: string; text_content: string | null; file_size: number }>();
  if (!requirement) throw new HttpError(410, 'Upload content is no longer available');
  return (await reserveContentStorage(
    env,
    requirement.owner_username,
    session.content_id,
    textSize(requirement.text_content) + Number(requirement.file_size || 0)
  )) || reservationIdForContent(session.content_id);
}

async function touchReusableUploadSessions(env: Env, sessions: UploadSessionRow[], reservationId: string): Promise<void> {
  const timestamp = now();
  const statements = sessions.map((session) => env.DB.prepare(
    `UPDATE upload_sessions SET last_activity_at=?1, updated_at=?1, expires_at=?2
     WHERE id=?3 AND status IN (${RESUMABLE_SESSION_STATUSES})
       AND NOT EXISTS (
         SELECT 1 FROM upload_cleanup_claims c
         WHERE c.content_id=upload_sessions.content_id
           AND julianday(c.expires_at) > julianday('now')
       )`
  ).bind(timestamp, uploadSessionExpiresAt(), session.id));
  statements.push(env.DB.prepare(
    `UPDATE storage_reservations SET expires_at=?2, updated_at=?1
     WHERE id=?3 AND status='active'
       AND NOT EXISTS (
         SELECT 1 FROM upload_cleanup_claims c
         WHERE c.content_id=storage_reservations.content_id
           AND julianday(c.expires_at) > julianday('now')
       )`
  ).bind(timestamp, reservationExpiresAt(), reservationId));
  const results = await env.DB.batch(statements);
  if (results.slice(0, sessions.length).some((result) => Number(result.meta.changes || 0) !== 1)) {
    throw new HttpError(409, 'Upload cleanup is in progress', 'UPLOAD_CLEANUP_IN_PROGRESS');
  }
}

async function claimStaleUploadCleanup(env: Env, contentId: string, cutoff: string): Promise<string | null> {
  const timestamp = now();
  const claimToken = id('ucl');
  const claimExpiresAt = new Date(Date.now() + UPLOAD_CLEANUP_CLAIM_MS).toISOString();
  const results = await env.DB.batch([
    env.DB.prepare(
      `INSERT INTO upload_cleanup_claims (content_id, claim_token, claimed_at, expires_at)
       SELECT ?1, ?2, ?3, ?4
       WHERE EXISTS (
         SELECT 1 FROM storage_reservations r
         WHERE r.content_id=?1 AND r.status='active'
           AND julianday(r.expires_at) <= julianday(?3)
       )
       AND NOT EXISTS (
         SELECT 1 FROM upload_sessions s
         WHERE s.content_id=?1
           AND s.status IN (${RESUMABLE_SESSION_STATUSES})
           AND COALESCE(s.last_activity_at, s.updated_at, s.created_at) >= ?5
       )
       ON CONFLICT(content_id) DO UPDATE SET
         claim_token=excluded.claim_token,
         claimed_at=excluded.claimed_at,
         expires_at=excluded.expires_at
       WHERE julianday(upload_cleanup_claims.expires_at) <= julianday(?3)`
    ).bind(contentId, claimToken, timestamp, claimExpiresAt, cutoff),
    env.DB.prepare(
      `UPDATE storage_reservations SET expires_at=?1, updated_at=?2
       WHERE content_id=?3 AND status='active'
         AND EXISTS (
           SELECT 1 FROM upload_cleanup_claims c
           WHERE c.content_id=?3 AND c.claim_token=?4
         )`
    ).bind(claimExpiresAt, timestamp, contentId, claimToken),
  ]);
  if (Number(results[0]?.meta.changes || 0) === 1 && Number(results[1]?.meta.changes || 0) === 1) {
    return claimToken;
  }
  if (Number(results[0]?.meta.changes || 0) === 1) {
    await env.DB.prepare('DELETE FROM upload_cleanup_claims WHERE content_id=?1 AND claim_token=?2').bind(contentId, claimToken).run();
  }
  return null;
}

async function cleanupUploadObjects(
  env: Env,
  input: {
    sessions?: UploadSessionRow[];
    multipartUploads?: R2MultipartUpload[];
    objectKeys?: Iterable<string>;
  }
): Promise<void> {
  const failures: string[] = [];
  const aborts = [
    ...(input.multipartUploads || []).map((upload) => () => upload.abort()),
    ...(input.sessions || [])
      .filter((session) => session.mode === 'multipart' && session.upload_id && !['completed', 'cancelled', 'expired'].includes(session.status))
      .map((session) => () => env.BUCKET.resumeMultipartUpload(session.object_key, session.upload_id!).abort()),
  ];
  const abortResults = await Promise.allSettled(aborts.map((abort) => abort()));
  abortResults.forEach((result, index) => {
    if (result.status === 'rejected') failures.push(`abort:${index}`);
  });

  const objectKeys = [...new Set(input.objectKeys || [])];
  const deleteResults = await Promise.allSettled(objectKeys.map((objectKey) => env.BUCKET.delete(objectKey)));
  deleteResults.forEach((result, index) => {
    if (result.status === 'rejected') failures.push(`delete:${index}`);
  });
  if (failures.length) {
    throw new Error(`R2 upload cleanup failed (${failures.join(', ')})`);
  }
}

async function rollbackUploadSetup(
  env: Env,
  contentId: string,
  multipartUploads: R2MultipartUpload[] = [],
  objectKeys: string[] = []
): Promise<void> {
  await cleanupUploadObjects(env, { multipartUploads, objectKeys });
  const statements = [
    env.DB.prepare('DELETE FROM upload_parts WHERE session_id IN (SELECT id FROM upload_sessions WHERE content_id=?1)').bind(contentId),
    env.DB.prepare('DELETE FROM upload_sessions WHERE content_id=?1').bind(contentId),
    env.DB.prepare('DELETE FROM attachments WHERE content_id=?1').bind(contentId),
    env.DB.prepare('DELETE FROM upload_cleanup_claims WHERE content_id=?1').bind(contentId),
    env.DB.prepare('DELETE FROM storage_reservations WHERE content_id=?1').bind(contentId),
    env.DB.prepare('DELETE FROM contents WHERE id=?1').bind(contentId),
  ];
  for (const statement of statements) await statement.run();
}

async function activateReservedContent(env: Env, contentId: string, finalTextSize: number, finalFileSize: number): Promise<void> {
  const timestamp = now();
  const totalSize = finalTextSize + finalFileSize;
  const results = await env.DB.batch([
    env.DB.prepare(
      `UPDATE contents SET status="active", text_size=?1, file_size=?2, updated_at=?3
       WHERE id=?4 AND status="processing"
         AND (?5=0 OR EXISTS (
           SELECT 1 FROM storage_reservations r
           WHERE r.content_id=?4 AND r.status='active' AND r.bytes=?5
             AND julianday(r.expires_at) > julianday('now')
         ))`
    ).bind(finalTextSize, finalFileSize, timestamp, contentId, totalSize),
    env.DB.prepare(
      `UPDATE storage_reservations SET status='released', released_at=?1, updated_at=?1
       WHERE content_id=?2 AND status='active'
         AND (?3=0 OR (bytes=?3 AND julianday(expires_at) > julianday('now')))`
    ).bind(timestamp, contentId, totalSize),
  ]);
  if (Number(results[0]?.meta.changes || 0) !== 1) {
    throw new Error(`Storage reservation is not active for content ${contentId}`);
  }
}

async function createTextContent(env: Env, req: Request, owner: string, input: any, source: 'web' | 'cli'): Promise<Response> {
  const t = now();
  const visibility = ALLOWED_VISIBILITY.has(input.visibility) ? input.visibility : 'public';
  await requireCreationAccess(env, owner, visibility);
  const format = ALLOWED_FORMAT.has(input.format) ? input.format : 'plain';
  const contentText = String(input.content || '');
  const finalTextSize = textSize(contentText);
  const slug = await uniqueSlug(env.DB, input.slug);
  const contentId = id('cnt');
  const password = await hashWithSalt(input.password);
  try {
    await env.DB.prepare(
      'INSERT INTO contents (id, owner_username, title, slug, type, format, text_content, visibility, status, text_size, file_size, password_hash, password_salt, expire_at, max_views, remark, created_at, updated_at) VALUES (?1, ?2, ?3, ?4, "text", ?5, ?6, ?7, "processing", 0, 0, ?8, ?9, ?10, ?11, ?12, ?13, ?13)'
    )
      .bind(
        contentId,
        owner,
        input.title?.trim() || 'Untitled text',
        slug,
        format,
        contentText,
        visibility,
        password.hash,
        password.salt,
        nullableText(input.expire_at),
        numberField(input.max_views),
        nullableText(input.remark),
        t
      )
      .run();
    await reserveContentStorage(env, owner, contentId, finalTextSize);
    await activateReservedContent(env, contentId, finalTextSize, 0);
    return json({ ok: true, url: `${publicBase(env, req)}/s/${slug}`, slug, content_id: contentId, source });
  } catch (error) {
    await rollbackUploadSetup(env, contentId);
    throw error;
  }
}

async function putAttachments(env: Env, contentId: string, owner: string, files: File[], objectKeys: string[]): Promise<number> {
  let totalSize = 0;
  for (const file of files) {
    const attachmentId = id('att');
    const objectKey = `${owner}/${contentId}/${attachmentId}-${file.name}`;
    const contentType = contentTypeFor(file.name, file.type);
    await env.BUCKET.put(objectKey, file.stream(), {
      httpMetadata: { contentType },
      customMetadata: { owner, contentId, attachmentId }
    });
    objectKeys.push(objectKey);
    totalSize += file.size;
    await env.DB.prepare(
      'INSERT INTO attachments (id, content_id, owner_username, object_key, filename, content_type, size, status, created_at) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, "active", ?8)'
    )
      .bind(attachmentId, contentId, owner, objectKey, file.name, contentType, file.size, now())
      .run();
  }
  return totalSize;
}

async function createUploadContent(env: Env, req: Request, owner: string, form: FormData, mixed: boolean, source: 'web' | 'cli'): Promise<Response> {
  const files = [...form.getAll('file'), ...form.getAll('file[]')].filter((v): v is File => v instanceof File && v.size > 0);
  if (!files.length) throw new HttpError(400, 'At least one file is required');
  if (files.length > 20) throw new HttpError(400, 'A maximum of 20 files can be uploaded at once');
  for (const file of files) assertTransferFileSize(file.size);
  const legacyLargeFile = files.find((file) => file.size > LEGACY_UPLOAD_LIMIT);
  if (legacyLargeFile) {
    throw new HttpError(413, 'Use the resumable upload API for files larger than 100 MiB', 'RESUMABLE_UPLOAD_REQUIRED', {
      file_size: legacyLargeFile.size,
      legacy_limit_bytes: LEGACY_UPLOAD_LIMIT,
      max_file_bytes: MAX_UPLOAD_SIZE,
    });
  }
  const contentText = textField(form.get('content'));
  const type = mixed || contentText ? 'mixed' : 'file';
  const visibilityRaw = textField(form.get('visibility'));
  const visibility = ALLOWED_VISIBILITY.has(visibilityRaw) ? visibilityRaw : 'public';
  await requireCreationAccess(env, owner, visibility);
  const formatRaw = textField(form.get('format'));
  const format = ALLOWED_FORMAT.has(formatRaw) ? formatRaw : 'plain';
  const slug = await uniqueSlug(env.DB, textField(form.get('slug')));
  const contentId = id('cnt');
  const password = await hashWithSalt(textField(form.get('password')));
  const t = now();
  const finalTextSize = textSize(contentText);
  const requestedBytes = finalTextSize + files.reduce((total, file) => total + file.size, 0);
  let objectKeys: string[] = [];
  try {
    await env.DB.prepare(
      'INSERT INTO contents (id, owner_username, title, slug, type, format, text_content, visibility, status, text_size, file_size, password_hash, password_salt, expire_at, max_views, remark, allow_download, created_at, updated_at) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, "processing", 0, 0, ?9, ?10, ?11, ?12, ?13, ?14, ?15, ?15)'
    )
      .bind(
        contentId,
        owner,
        textField(form.get('title')) || files[0].name,
        slug,
        type,
        format,
        contentText || null,
        visibility,
        password.hash,
        password.salt,
        nullableText(textField(form.get('expire_at'))),
        numberField(form.get('max_views')),
        nullableText(textField(form.get('remark'))),
        allowDownloadField(form.get('allow_download')),
        t
      )
      .run();
    await reserveContentStorage(env, owner, contentId, requestedBytes);
    await putAttachments(env, contentId, owner, files, objectKeys);
    await env.UPLOAD_QUEUE.send({ type: 'finalize-upload', contentId, owner });
    return json({ ok: true, queued: true, url: `${publicBase(env, req)}/s/${slug}`, slug, content_id: contentId, source });
  } catch (error) {
    await rollbackUploadSetup(env, contentId, [], objectKeys);
    throw error;
  }
}

async function directUploadPlan(env: Env, session: UploadSessionRow, after = 0, limit = MAX_PARTS_PER_WINDOW) {
  const { results } = await env.DB.prepare(
    'SELECT part_number, etag, size, completed_at FROM upload_parts WHERE session_id=?1 ORDER BY part_number ASC'
  ).bind(session.id).all<UploadPartRecord>();
  const completedParts = results || [];
  if (session.mode === 'single') {
    const signed = await signedUploadUrl(env, session);
    return {
      session_id: session.id,
      attachment_id: session.attachment_id,
      filename: session.filename,
      size: session.size,
      mode: session.mode,
      upload_url: signed.url,
      headers: signed.headers,
      completed_parts: completedParts,
      expires_at: new Date(Date.now() + UPLOAD_SIGNATURE_TTL_SECONDS * 1000).toISOString()
    };
  }

  const window = buildPartWindow(
    session.size,
    new Set(completedParts.map((part) => part.part_number)),
    partWindowCursor(after),
    partWindowLimit(limit)
  );
  const parts = await Promise.all(window.parts.map(async (part) => {
    const signed = await signedUploadUrl(env, session, { partNumber: part.partNumber, uploadId: session.upload_id || '' });
    return {
      part_number: part.partNumber,
      start: part.start,
      end: part.end,
      size: part.size,
      url: signed.url,
      headers: signed.headers
    };
  }));
  return {
    session_id: session.id,
    attachment_id: session.attachment_id,
    filename: session.filename,
    size: session.size,
    mode: session.mode,
    upload_id: session.upload_id,
    part_size: buildPartPlan(session.size)[0]?.size || session.size,
    parts,
    completed_parts: completedParts,
    next_part_number: window.nextPartNumber,
    has_more_parts: window.hasMoreParts,
    expires_at: new Date(Date.now() + UPLOAD_SIGNATURE_TTL_SECONDS * 1000).toISOString()
  };
}

async function createDirectUploadContent(env: Env, req: Request, owner: string, input: any, source: 'web' | 'cli'): Promise<Response> {
  const requestedFiles = Array.isArray(input.files) ? input.files as DirectUploadFile[] : [];
  if (!requestedFiles.length) throw new HttpError(400, 'At least one file is required');
  if (requestedFiles.length > 20) throw new HttpError(400, 'A maximum of 20 files can be uploaded at once');
  const firstFileMetadata = typeof requestedFiles[0]?.metadata === 'object' && requestedFiles[0].metadata
    ? requestedFiles[0].metadata
    : {};
  const settings = { ...firstFileMetadata, ...input };
  const visibility = ALLOWED_VISIBILITY.has(settings.visibility) ? settings.visibility : 'public';
  await requireCreationAccess(env, owner, visibility);
  if (!directUploadConfigured(env)) throw new HttpError(503, 'Direct R2 upload is not configured');

  const files = await Promise.all(requestedFiles.map(async (file) => {
    const name = normalizeUploadFilename(String(file.name || ''));
    const size = Number(file.size);
    assertTransferFileSize(size);
    const suppliedFingerprint = typeof file.fingerprint === 'string' && /^[a-f0-9]{64}$/i.test(file.fingerprint)
      ? file.fingerprint.toLowerCase()
      : await fallbackUploadFingerprint({ ...file, name, size });
    return {
      clientId: typeof file.client_id === 'string' ? file.client_id.slice(0, 100) : '',
      name,
      size,
      contentType: contentTypeFor(name, typeof file.type === 'string' ? file.type : null),
      fingerprint: suppliedFingerprint
    };
  }));
  const contentText = typeof settings.content === 'string' ? settings.content.trim() : '';
  const requestedFileBytes = files.reduce((total, file) => total + file.size, 0);
  const reusable = await findReusableUploadSessions(env, owner, files);
  if (reusable) {
    await env.DB.prepare('UPDATE contents SET allow_download=?1 WHERE id=?2 AND status="processing"')
      .bind(allowDownloadField(settings.allow_download), reusable.content.id).run();
    const reservationId = await ensureReusableReservation(
      env,
      owner,
      reusable.content.id,
      requestedFileBytes + textSize(reusable.content.text_content)
    );
    await touchReusableUploadSessions(env, reusable.sessions, reservationId);
    const plans = await Promise.all(reusable.sessions.map(async (session, index) => ({
      ...(await directUploadPlan(env, session, 0, MAX_PARTS_PER_WINDOW)),
      client_id: files[index].clientId
    })));
    return json({
      ok: true,
      direct: true,
      resumed: true,
      content_id: reusable.content.id,
      slug: reusable.content.slug,
      url: `${publicBase(env, req)}/s/${reusable.content.slug}`,
      files: plans
    }, 200);
  }
  const pending = await env.DB.prepare(
    'SELECT COUNT(*) count FROM upload_sessions WHERE owner_username=?1 AND expires_at > ?2 AND status IN ("pending","uploading","completing","failed")'
  ).bind(owner, now()).first<{ count: number }>();
  if (Number(pending?.count || 0) + files.length > MAX_PENDING_UPLOAD_SESSIONS_PER_USER) {
    throw new HttpError(429, 'Too many unfinished upload sessions');
  }
  const format = ALLOWED_FORMAT.has(settings.format) ? settings.format : 'plain';
  const slug = await uniqueSlug(env.DB, settings.slug);
  const contentId = id('cnt');
  const password = await hashWithSalt(settings.password);
  const createdAt = now();
  const expiresAt = uploadSessionExpiresAt();
  const sessions: UploadSessionRow[] = [];
  const multipartUploads: R2MultipartUpload[] = [];
  const objectKeys: string[] = [];

  try {
    await env.DB.prepare(
      'INSERT INTO contents (id, owner_username, title, slug, type, format, text_content, visibility, status, text_size, file_size, password_hash, password_salt, expire_at, max_views, remark, allow_download, created_at, updated_at) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, "processing", 0, 0, ?9, ?10, ?11, ?12, ?13, ?14, ?15, ?15)'
    ).bind(
      contentId,
      owner,
      typeof settings.title === 'string' && settings.title.trim() ? settings.title.trim() : files[0].name,
      slug,
      contentText ? 'mixed' : 'file',
      format,
      contentText || null,
      visibility,
      password.hash,
      password.salt,
      nullableText(settings.expire_at),
      numberField(settings.max_views),
      nullableText(settings.remark),
      allowDownloadField(settings.allow_download),
      createdAt
    ).run();
    await reserveContentStorage(env, owner, contentId, requestedFileBytes + textSize(contentText));

    for (const file of files) {
      const attachmentId = id('att');
      const sessionId = id('upl');
      const mode = chooseUploadMode(file.size);
      const objectKey = mode === 'single'
        ? safeStagingObjectKey(owner, contentId, attachmentId)
        : safeObjectKey(owner, contentId, attachmentId);
      objectKeys.push(objectKey);
      let uploadId: string | null = null;
      if (mode === 'multipart') {
        const upload = await env.BUCKET.createMultipartUpload(objectKey, {
          httpMetadata: {
            contentType: file.contentType,
            contentDisposition: attachmentDisposition(file.name),
            cacheControl: 'private, no-store'
          },
          customMetadata: { owner, contentId, attachmentId, sessionId }
        });
        uploadId = upload.uploadId;
        multipartUploads.push(upload);
      }
      sessions.push({
        id: sessionId,
        content_id: contentId,
        attachment_id: attachmentId,
        owner_username: owner,
        object_key: objectKey,
        filename: file.name,
        content_type: file.contentType,
        size: file.size,
        mode,
        upload_id: uploadId,
        expected_parts: mode === 'single' ? 1 : buildPartPlan(file.size).length,
        completed_parts: 0,
        uploaded_bytes: 0,
        status: 'pending',
        file_fingerprint: file.fingerprint,
        expires_at: expiresAt,
        last_activity_at: createdAt,
        created_at: createdAt,
        updated_at: createdAt
      });
    }

    const statements: D1PreparedStatement[] = [];
    for (const session of sessions) {
      statements.push(
        env.DB.prepare(
          'INSERT INTO attachments (id, content_id, owner_username, object_key, filename, content_type, size, status, created_at) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, "pending", ?8)'
        ).bind(session.attachment_id, contentId, owner, session.object_key, session.filename, session.content_type, session.size, createdAt),
        env.DB.prepare(
          'INSERT INTO upload_sessions (id, content_id, attachment_id, owner_username, object_key, filename, content_type, size, mode, upload_id, expected_parts, status, source, file_fingerprint, expires_at, created_at, updated_at, last_activity_at) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, "pending", ?12, ?13, ?14, ?15, ?15, ?15)'
        ).bind(session.id, contentId, session.attachment_id, owner, session.object_key, session.filename, session.content_type, session.size, session.mode, session.upload_id, session.expected_parts, source, session.file_fingerprint, expiresAt, createdAt)
      );
    }
    await env.DB.batch(statements);
    const plans = await Promise.all(sessions.map(async (session, index) => ({
      ...(await directUploadPlan(env, session, 0, MAX_PARTS_PER_WINDOW)),
      client_id: files[index].clientId
    })));
    return json({
      ok: true,
      direct: true,
      content_id: contentId,
      slug,
      url: `${publicBase(env, req)}/s/${slug}`,
      files: plans
    }, 201);
  } catch (error) {
    await rollbackUploadSetup(env, contentId, multipartUploads, objectKeys);
    throw error;
  }
}

async function ownedUploadSession(env: Env, sessionId: string, owner: string): Promise<UploadSessionRow> {
  const session = await env.DB.prepare('SELECT * FROM upload_sessions WHERE id = ?1 AND owner_username = ?2').bind(sessionId, owner).first<UploadSessionRow>();
  if (!session) throw new HttpError(404, 'Upload session not found');
  if (Date.parse(session.expires_at) <= Date.now() && !['completed', 'cancelled'].includes(session.status)) {
    await env.DB.prepare('UPDATE upload_sessions SET status="expired", updated_at=?1, last_activity_at=?1 WHERE id=?2').bind(now(), session.id).run();
    throw new HttpError(410, 'Upload session expired');
  }
  return session;
}

async function refreshContentUploadState(env: Env, contentId: string): Promise<void> {
  const state = await env.DB.prepare(
     `SELECT
       c.status,
       c.owner_username,
       c.text_content,
       COUNT(a.id) expected,
       COALESCE(SUM(a.status="active"), 0) completed,
       COALESCE(SUM(a.status="failed"), 0) failed,
       COALESCE(SUM(CASE WHEN a.status="active" THEN a.size ELSE 0 END), 0) total_size
     FROM contents c
     LEFT JOIN attachments a ON a.content_id=c.id
     WHERE c.id=?1
     GROUP BY c.id`
  ).bind(contentId).first<any>();
  if (!state || (state.status && state.status !== 'processing')) return;
  const expected = Number(state.expected || 0);
  const completed = Number(state.completed || 0);
  const failed = Number(state.failed || 0);
  if (isContentReadyForActivation(expected, completed, failed)) {
    const finalTextSize = textSize(state.text_content);
    const finalFileSize = Number(state.total_size || 0);
    await ensureReusableReservation(env, String(state.owner_username), contentId, finalTextSize + finalFileSize);
    await activateReservedContent(env, contentId, finalTextSize, finalFileSize);
  }
}

async function rejectUploadedObject(env: Env, session: UploadSessionRow): Promise<void> {
  await cleanupUploadObjects(env, { objectKeys: [session.object_key] });
  const t = now();
  await env.DB.batch([
    env.DB.prepare('UPDATE upload_sessions SET status="failed", updated_at=?1, last_activity_at=?1 WHERE id=?2').bind(t, session.id),
    env.DB.prepare('UPDATE attachments SET status="failed" WHERE id=?1').bind(session.attachment_id),
    env.DB.prepare('UPDATE contents SET status="expired", forced_expired_at=?1, updated_at=?1 WHERE id=?2').bind(t, session.content_id),
    env.DB.prepare("UPDATE storage_reservations SET status='expired', released_at=?1, updated_at=?1 WHERE content_id=?2 AND status='active'").bind(t, session.content_id)
  ]);
}

async function finalizeUploadedSession(env: Env, sessionId: string): Promise<void> {
  const session = await env.DB.prepare('SELECT * FROM upload_sessions WHERE id=?1').bind(sessionId).first<UploadSessionRow>();
  if (!session) return;
  if (['cancelled', 'expired'].includes(session.status)) return;
  if (session.status === 'completed') {
    if (session.mode === 'single') await cleanupUploadObjects(env, { objectKeys: [session.object_key] });
    await refreshContentUploadState(env, session.content_id);
    return;
  }
  let object = await env.BUCKET.head(session.object_key);
  if (!object) throw new Error(`Uploaded object is not available for session ${sessionId}`);
  let objectKey = session.object_key;
  let objectEtag = normalizeEtag(object.httpEtag);
  if (object.size !== session.size || (session.status === 'completed' && normalizeEtag(session.etag) !== objectEtag)) {
    await rejectUploadedObject(env, session);
    throw new Error(`Uploaded object integrity mismatch for session ${sessionId}`);
  }
  if (session.mode === 'single') {
    const stagingObject = await env.BUCKET.get(session.object_key);
    if (!stagingObject) throw new Error(`Uploaded object is not available for session ${sessionId}`);
    objectKey = finalizedObjectKey(session.object_key);
    object = await env.BUCKET.put(objectKey, stagingObject.body, {
      httpMetadata: {
        contentType: session.content_type,
        contentDisposition: attachmentDisposition(session.filename),
        cacheControl: 'private, no-store'
      },
      customMetadata: {
        owner: session.owner_username,
        contentId: session.content_id,
        attachmentId: session.attachment_id,
        sessionId: session.id
      }
    });
    objectEtag = normalizeEtag(object.httpEtag);
  }
  const t = now();
  await env.DB.batch([
    env.DB.prepare('UPDATE upload_sessions SET status="completed", completed_parts=expected_parts, uploaded_bytes=size, etag=?1, completed_at=?2, updated_at=?2, last_activity_at=?2 WHERE id=?3')
      .bind(objectEtag, t, session.id),
    env.DB.prepare('UPDATE attachments SET status="active", object_key=?1, size=?2, content_type=?3, etag=?4, completed_at=?5 WHERE id=?6')
      .bind(objectKey, object.size, session.content_type, objectEtag, t, session.attachment_id)
  ]);
  if (session.mode === 'single') await cleanupUploadObjects(env, { objectKeys: [session.object_key] });
  await refreshContentUploadState(env, session.content_id);
}

async function completeMultipartSession(env: Env, sessionId: string): Promise<void> {
  const session = await env.DB.prepare('SELECT * FROM upload_sessions WHERE id=?1').bind(sessionId).first<UploadSessionRow>();
  if (!session || session.mode !== 'multipart' || !session.upload_id || session.status === 'completed') return;
  const existing = await env.BUCKET.head(session.object_key);
  if (!existing) {
    const { results } = await env.DB.prepare('SELECT part_number, etag FROM upload_parts WHERE session_id=?1 ORDER BY part_number ASC').bind(session.id).all<{ part_number: number; etag: string }>();
    const parts = results || [];
    if (parts.length !== session.expected_parts) throw new Error(`Multipart upload ${session.id} is incomplete`);
    await env.DB.prepare('UPDATE upload_sessions SET status="completing", updated_at=?1, last_activity_at=?1 WHERE id=?2').bind(now(), session.id).run();
    const upload = env.BUCKET.resumeMultipartUpload(session.object_key, session.upload_id);
    await upload.complete(parts.map((part) => ({ partNumber: part.part_number, etag: normalizeEtag(part.etag) })));
  }
  await finalizeUploadedSession(env, session.id);
}

async function markQueueMessageFailed(env: Env, body: UploadMessage | R2EventMessage, error: unknown): Promise<void> {
  let contentId = 'contentId' in body ? body.contentId : undefined;
  let sessionId = 'sessionId' in body ? body.sessionId : undefined;
  if (!sessionId && 'object' in body && body.object?.key) {
    sessionId = (await env.DB.prepare('SELECT id FROM upload_sessions WHERE object_key=?1').bind(body.object.key).first<{ id: string }>())?.id;
  }
  const session = sessionId
    ? await env.DB.prepare('SELECT * FROM upload_sessions WHERE id=?1').bind(sessionId).first<UploadSessionRow>()
    : null;
  contentId ||= session?.content_id;
  if (!contentId) return;
  const content = await env.DB.prepare('SELECT status FROM contents WHERE id=?1').bind(contentId).first<{ status: string }>();
  if (!content || content.status !== 'processing') return;
  const sessions = (await env.DB.prepare('SELECT * FROM upload_sessions WHERE content_id=?1').bind(contentId).all<UploadSessionRow>()).results || [];
  const attachments = (await env.DB.prepare('SELECT object_key FROM attachments WHERE content_id=?1').bind(contentId).all<{ object_key: string }>()).results || [];
  const t = now();
  const message = error instanceof Error ? error.message.slice(0, 500) : 'Queue processing failed';
  const objectKeys = new Set([
    ...sessions.map((item) => item.object_key),
    ...attachments.map((item) => item.object_key),
  ]);
  await cleanupUploadObjects(env, { sessions, objectKeys });
  await env.DB.batch([
    env.DB.prepare('DELETE FROM upload_parts WHERE session_id IN (SELECT id FROM upload_sessions WHERE content_id=?1)').bind(contentId),
    env.DB.prepare('UPDATE upload_sessions SET status="failed", updated_at=?1, last_activity_at=?1 WHERE content_id=?2 AND status NOT IN ("cancelled","expired")').bind(t, contentId),
    env.DB.prepare('UPDATE attachments SET status="failed" WHERE content_id=?1').bind(contentId),
    env.DB.prepare('UPDATE contents SET status="expired", text_content=NULL, forced_expired_at=?1, updated_at=?1 WHERE id=?2 AND status="processing"').bind(t, contentId),
    env.DB.prepare('INSERT INTO admin_actions (id, admin_username, action, target_type, target_id, detail, created_at) VALUES (?1, "system", "upload_queue_failed", ?2, ?3, ?4, ?5)')
      .bind(id('adm'), session ? 'upload_session' : 'content', session?.id || contentId, JSON.stringify({ message }), t),
    env.DB.prepare("UPDATE storage_reservations SET status='expired', released_at=?1, updated_at=?1 WHERE content_id=?2 AND status='active'").bind(t, contentId)
  ]);
}

async function apiKeyAuth(env: Env, req: Request): Promise<{ id: string; owner: string }> {
  const key = bearer(req);
  if (!key) throw new HttpError(401, 'Missing API Key', 'API_KEY_REQUIRED');
  const hash = await keyHash(key);
  const row = await env.DB.prepare('SELECT * FROM api_keys WHERE key_hash = ?').bind(hash).first<any>();
  if (!row) throw new HttpError(401, 'Invalid API Key', 'INVALID_API_KEY');
  if (row.status === 'revoked') throw new HttpError(401, 'API Key revoked', 'API_KEY_REVOKED');
  if (row.status === 'expired' || (row.expire_at && Date.parse(row.expire_at) <= Date.now())) {
    await env.DB.prepare('UPDATE api_keys SET status = "expired" WHERE id = ?').bind(row.id).run();
    throw new HttpError(401, 'API Key expired', 'API_KEY_EXPIRED');
  }
  if (row.locked_at) {
    throw new HttpError(403, 'API Key locked', 'API_KEY_LOCKED', { reason: row.lock_reason || null });
  }
  const profile = await loadUserAccessProfile(env.DB, row.owner_username);
  if (!profile.permissions.can_api) {
    const t = now();
    await env.DB.prepare(
      'UPDATE api_keys SET locked_at=?1, lock_reason="api_permission_removed", locked_by="system" WHERE id=?2 AND locked_at IS NULL AND status="active"'
    ).bind(t, row.id).run();
    requirePermission(profile, 'can_api');
  }
  const t = now();
  await env.DB.prepare('UPDATE api_keys SET last_used_at = ?1, usage_count = usage_count + 1 WHERE id = ?2').bind(t, row.id).run();
  await env.DB.prepare(
    'INSERT INTO api_key_usage_logs (id, api_key_id, owner_username, endpoint, ip, user_agent, ok, message, created_at) VALUES (?1, ?2, ?3, ?4, ?5, ?6, 1, "ok", ?7)'
  )
    .bind(id('akul'), row.id, row.owner_username, new URL(req.url).pathname, req.headers.get('cf-connecting-ip') || null, req.headers.get('user-agent') || null, t)
    .run();
  return { id: row.id, owner: row.owner_username };
}

async function newApiKey(env: Env, owner: string, input: any) {
  const rawBytes = new Uint8Array(32);
  crypto.getRandomValues(rawBytes);
  const raw = `csk_${base64Url(rawBytes)}`;
  const apiKeyId = id('key');
  const item = {
    id: apiKeyId,
    remark: input.remark || '',
    key_prefix: raw.slice(0, 10),
    key_suffix: raw.slice(-4),
    status: 'active',
    expire_at: input.expire_at || null,
    locked_at: null,
    lock_reason: null,
    locked_by: null,
  };
  const statement = env.DB.prepare(
    'INSERT INTO api_keys (id, owner_username, remark, key_hash, key_prefix, key_suffix, status, expire_at, created_at) VALUES (?1, ?2, ?3, ?4, ?5, ?6, "active", ?7, ?8)'
  )
    .bind(apiKeyId, owner, nullableText(input.remark), await keyHash(raw), raw.slice(0, 10), raw.slice(-4), nullableText(input.expire_at), now());
  return { raw, item, statement };
}

async function createApiKey(env: Env, user: User, input: any): Promise<Response> {
  const created = await newApiKey(env, user.username, input);
  await created.statement.run();
  return json({ ok: true, key: created.raw, item: created.item });
}

async function permanentDelete(env: Env, contentId: string): Promise<void> {
  const { results } = await env.DB.prepare('SELECT object_key FROM attachments WHERE content_id = ?').bind(contentId).all<{ object_key: string }>();
  const sessions = (await env.DB.prepare('SELECT * FROM upload_sessions WHERE content_id=?1').bind(contentId).all<UploadSessionRow>()).results || [];
  await cleanupUploadObjects(env, {
    sessions,
    objectKeys: [
      ...sessions.map((session) => session.object_key),
      ...(results || []).map((row) => row.object_key),
    ],
  });
  await env.DB.prepare('DELETE FROM upload_parts WHERE session_id IN (SELECT id FROM upload_sessions WHERE content_id=?1)').bind(contentId).run();
  await env.DB.prepare('DELETE FROM upload_sessions WHERE content_id=?1').bind(contentId).run();
  await env.DB.prepare('DELETE FROM attachments WHERE content_id = ?').bind(contentId).run();
  await env.DB.prepare('DELETE FROM content_notes WHERE content_id = ?').bind(contentId).run();
  await env.DB.prepare('DELETE FROM access_logs WHERE content_id = ?').bind(contentId).run();
  await env.DB.prepare('DELETE FROM upload_cleanup_claims WHERE content_id = ?').bind(contentId).run();
  await env.DB.prepare('DELETE FROM storage_reservations WHERE content_id = ?').bind(contentId).run();
  await env.DB.prepare('DELETE FROM contents WHERE id = ?').bind(contentId).run();
}

async function cleanupStaleUploadSessions(env: Env): Promise<number> {
  const cutoff = new Date(Date.now() - UPLOAD_INACTIVITY_MS).toISOString();
  const { results } = await env.DB.prepare(
    `SELECT * FROM upload_sessions WHERE status IN (${CLEANUP_SESSION_STATUSES}) AND COALESCE(last_activity_at, updated_at, created_at) < ?1 ORDER BY last_activity_at ASC LIMIT 100`
  ).bind(cutoff).all<UploadSessionRow>();
  let cleaned = 0;
  const staleContentIds = [...new Set((results || [])
    .filter((session) => isUploadSessionStale(session))
    .map((session) => session.content_id))];
  for (const contentId of staleContentIds) {
    const sessions = (await env.DB.prepare(
      'SELECT * FROM upload_sessions WHERE content_id=?1'
    ).bind(contentId).all<UploadSessionRow>()).results || [];
    const hasRecentSibling = sessions.some((session) =>
      ['pending', 'uploading', 'completing'].includes(session.status) && !isUploadSessionStale(session)
    );
    if (hasRecentSibling) continue;
    const claimToken = await claimStaleUploadCleanup(env, contentId, cutoff);
    if (!claimToken) continue;
    const attachments = (await env.DB.prepare(
      'SELECT object_key FROM attachments WHERE content_id=?1'
    ).bind(contentId).all<{ object_key: string }>()).results || [];
    const objectKeys = new Set([
      ...sessions.map((session) => session.object_key),
      ...attachments.map((attachment) => attachment.object_key),
    ]);
    try {
      await cleanupUploadObjects(env, { sessions, objectKeys });
    } catch (error) {
      console.error(JSON.stringify({
        event: 'stale_upload_cleanup_failed',
        content_id: contentId,
        message: error instanceof Error ? error.message : 'R2 cleanup failed',
      }));
      continue;
    }
    const timestamp = now();
    const cleanup = await env.DB.batch([
      env.DB.prepare(
        'DELETE FROM upload_parts WHERE session_id IN (SELECT id FROM upload_sessions WHERE content_id=?1) AND EXISTS (SELECT 1 FROM upload_cleanup_claims WHERE content_id=?1 AND claim_token=?2)'
      ).bind(contentId, claimToken),
      env.DB.prepare(
        'UPDATE upload_sessions SET status="expired", updated_at=?1, last_activity_at=?1 WHERE content_id=?2 AND status NOT IN ("cancelled","expired") AND EXISTS (SELECT 1 FROM upload_cleanup_claims WHERE content_id=?2 AND claim_token=?3)'
      ).bind(timestamp, contentId, claimToken),
      env.DB.prepare(
        'UPDATE attachments SET status="failed" WHERE content_id=?1 AND EXISTS (SELECT 1 FROM upload_cleanup_claims WHERE content_id=?1 AND claim_token=?2)'
      ).bind(contentId, claimToken),
      env.DB.prepare(
        'UPDATE contents SET status="expired", text_content=NULL, forced_expired_at=?1, updated_at=?1 WHERE id=?2 AND status="processing" AND EXISTS (SELECT 1 FROM upload_cleanup_claims WHERE content_id=?2 AND claim_token=?3)'
      ).bind(timestamp, contentId, claimToken),
      env.DB.prepare(
        "UPDATE storage_reservations SET status='expired', released_at=?1, updated_at=?1 WHERE content_id=?2 AND status='active' AND EXISTS (SELECT 1 FROM upload_cleanup_claims WHERE content_id=?2 AND claim_token=?3)"
      ).bind(timestamp, contentId, claimToken),
      env.DB.prepare('DELETE FROM upload_cleanup_claims WHERE content_id=?1 AND claim_token=?2').bind(contentId, claimToken),
    ]);
    if (Number(cleanup[4]?.meta.changes || 0) === 1 && Number(cleanup[5]?.meta.changes || 0) === 1) cleaned += 1;
  }
  return cleaned;
}

async function systemSetting(db: D1Database, key: string): Promise<any | null> {
  const row = await db.prepare('SELECT value FROM system_settings WHERE key = ?').bind(key).first<{ value: string }>();
  if (!row) return null;
  try {
    return JSON.parse(row.value);
  } catch {
    return null;
  }
}

async function setSystemSetting(db: D1Database, key: string, value: unknown, user?: User): Promise<void> {
  await db.prepare(
    'INSERT INTO system_settings (key, value, updated_at, updated_by) VALUES (?1, ?2, ?3, ?4) ' +
      'ON CONFLICT(key) DO UPDATE SET value=excluded.value, updated_at=excluded.updated_at, updated_by=excluded.updated_by'
  )
    .bind(key, JSON.stringify(value), now(), user?.username || null)
    .run();
}

type PermissionGroupRow = {
  id: string;
  name: string;
  is_system: number;
  is_default: number;
  quota_bytes: number;
} & Record<PermissionKey, number>;

function permissionGroupInput(body: any, current?: PermissionGroupRow): Omit<PermissionGroupRow, 'id' | 'is_system'> {
  const name = body.name === undefined ? current?.name || '' : String(body.name).trim();
  if (!name || name.length > 64) throw new HttpError(400, 'Permission group name must be 1 to 64 characters', 'INVALID_PERMISSION_GROUP');
  for (const key of PERMISSION_KEYS) {
    if (body[key] !== undefined && typeof body[key] !== 'boolean') {
      throw new HttpError(400, `${key} must be a boolean`, 'INVALID_PERMISSION_GROUP');
    }
  }
  if (body.is_default !== undefined && typeof body.is_default !== 'boolean') {
    throw new HttpError(400, 'is_default must be a boolean', 'INVALID_PERMISSION_GROUP');
  }
  const quota = body.quota_bytes === undefined ? Number(current?.quota_bytes || 0) : Number(body.quota_bytes);
  if (!Number.isSafeInteger(quota) || quota < 0) {
    throw new HttpError(400, 'quota_bytes must be a non-negative safe integer', 'INVALID_PERMISSION_GROUP');
  }
  return {
    name,
    is_default: body.is_default === undefined ? Number(current?.is_default || 0) : Number(body.is_default),
    can_public_publish: body.can_public_publish === undefined ? Number(current?.can_public_publish || 0) : Number(body.can_public_publish),
    can_api: body.can_api === undefined ? Number(current?.can_api || 0) : Number(body.can_api),
    can_internal_access: body.can_internal_access === undefined ? Number(current?.can_internal_access || 0) : Number(body.can_internal_access),
    can_upload: body.can_upload === undefined ? Number(current?.can_upload || 0) : Number(body.can_upload),
    quota_bytes: quota,
    can_comment: body.can_comment === undefined ? Number(current?.can_comment || 0) : Number(body.can_comment),
  };
}

function publicPermissionGroup(row: PermissionGroupRow | (Omit<PermissionGroupRow, 'id' | 'is_system'> & { id: string; is_system: number })) {
  return {
    ...row,
    is_system: Boolean(row.is_system),
    is_default: Boolean(row.is_default),
    ...Object.fromEntries(PERMISSION_KEYS.map((key) => [key, Boolean(row[key])])),
  };
}

function lockUserApiKeysStatement(env: Env, username: string, actor: string, reason: string, timestamp: string): D1PreparedStatement {
  return env.DB.prepare(
    'UPDATE api_keys SET locked_at=?1, lock_reason=?2, locked_by=?3 WHERE owner_username=?4 AND status="active" AND locked_at IS NULL'
  ).bind(timestamp, reason, actor, username);
}

function lockGroupApiKeysStatement(env: Env, groupId: string, actor: string, reason: string, timestamp: string): D1PreparedStatement {
  return env.DB.prepare(
    'UPDATE api_keys SET locked_at=?1, lock_reason=?2, locked_by=?3 WHERE status="active" AND locked_at IS NULL AND owner_username IN (SELECT username FROM users WHERE permission_group_id=?4)'
  ).bind(timestamp, reason, actor, groupId);
}

async function handleApi(req: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
  const url = new URL(req.url);
  const path = url.pathname;
  const method = req.method.toUpperCase();

  if (path === '/api/sso-callback' && method === 'POST') {
    const body = await readJson<{ token: string }>(req);
    const user = await verifySso(req, env, body.token);
    return json({ ok: true, user, token: body.token });
  }

  if (path === '/api/public/settings' && method === 'GET') {
    return json({ ok: true, item: { landing_background: await systemSetting(env.DB, 'landing_background') } });
  }

  if (path === '/api/public/admin-contact' && method === 'GET') {
    await verifySso(req, env);
    const email = String(env.ADMIN_CONTACT_EMAIL || '').trim();
    if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) {
      throw new HttpError(404, 'Administrator contact is not configured', 'ADMIN_CONTACT_UNAVAILABLE');
    }
    const subject = encodeURIComponent('ShareWorker access request');
    const body = encodeURIComponent('Please help me access a ShareWorker share.');
    return json({ ok: true, href: `mailto:${email}?subject=${subject}&body=${body}` });
  }

  if (path === '/api/me' && method === 'GET') {
    const user = await verifySso(req, env);
    const profile = await loadUserAccessProfile(env.DB, user.username);
    return json({
      ok: true,
      user,
      group: profile.groupName,
      permissions: profile.permissions,
      storage: {
        used_bytes: profile.used_bytes,
        reserved_bytes: profile.reserved_bytes,
        quota_bytes: profile.quota_bytes,
        available_bytes: Math.max(0, profile.quota_bytes - profile.used_bytes - profile.reserved_bytes),
      },
    });
  }

  if (path === '/api/me/ui-settings' && method === 'GET') {
    const user = await verifySso(req, env);
    const row = await loadUiSettingsRow(env.DB, user.username);
    return json({ ok: true, item: sanitizeUiSettings(row.stored), updated_at: row.updated_at });
  }

  if (path === '/api/me/ui-settings' && method === 'PUT') {
    const user = await verifySso(req, env);
    const body = await readJson<unknown>(req);
    if (typeof body !== 'object' || body === null || Array.isArray(body)) throw new HttpError(400, 'UI settings body must be an object');
    if (JSON.stringify(body).length > 4096) throw new HttpError(400, 'UI settings body is too large');
    const row = await loadUiSettingsRow(env.DB, user.username);
    const item = mergeUiSettings(row.stored, body);
    const t = new Date().toISOString();
    await env.DB.prepare(
      'INSERT INTO user_ui_settings (username, settings_json, updated_at) VALUES (?1, ?2, ?3) ON CONFLICT(username) DO UPDATE SET settings_json = excluded.settings_json, updated_at = excluded.updated_at'
    )
      .bind(user.username, JSON.stringify(item), t)
      .run();
    return json({ ok: true, item, updated_at: t });
  }

  if (path === '/api/contents' && method === 'GET') {
    const user = await verifySso(req, env);
    const status = url.searchParams.get('status');
    const type = url.searchParams.get('type');
    const q = `%${url.searchParams.get('q') || ''}%`;
    const clauses = ['owner_username = ?1', '(title LIKE ?2 OR slug LIKE ?2 OR remark LIKE ?2)'];
    const binds: any[] = [user.username, q];
    if (status && ALLOWED_STATUS.has(status)) {
      clauses.push(`status = ?${binds.length + 1}`);
      binds.push(status);
    }
    if (type && ['text', 'file', 'mixed'].includes(type)) {
      clauses.push(`type = ?${binds.length + 1}`);
      binds.push(type);
    }
    const sql = `SELECT * FROM contents WHERE ${clauses.join(' AND ')} ORDER BY created_at DESC LIMIT 200`;
    const { results } = await env.DB.prepare(sql).bind(...binds).all();
    return json({ ok: true, items: results || [] });
  }

  if (path === '/api/contents/text' && method === 'POST') {
    const user = await verifySso(req, env);
    return createTextContent(env, req, user.username, await readJson(req), 'web');
  }

  if (path === '/api/contents/upload' && method === 'POST') {
    const user = await verifySso(req, env);
    const form = await req.formData();
    return createUploadContent(env, req, user.username, form, textField(form.get('content')) !== '', 'web');
  }

  if ((path === '/api/uploads/initiate' || path === '/api/cli/uploads/initiate') && method === 'POST') {
    const cli = path.startsWith('/api/cli/');
    const owner = cli ? (await apiKeyAuth(env, req)).owner : (await verifySso(req, env)).username;
    return createDirectUploadContent(env, req, owner, await readJson(req), cli ? 'cli' : 'web');
  }

  const uploadMatch = path.match(/^\/api\/(cli\/)?uploads\/([^/]+)(?:\/(status|parts|part|complete|renew|heartbeat))?$/);
  if (uploadMatch) {
    const owner = uploadMatch[1] ? (await apiKeyAuth(env, req)).owner : (await verifySso(req, env)).username;
    const session = await ownedUploadSession(env, uploadMatch[2], owner);
    const action = uploadMatch[3] || '';
    const uploadBase = uploadMatch[1] ? '/api/cli/uploads' : '/api/uploads';

    if ((action === '' || action === 'status') && method === 'GET') {
      const { results } = await env.DB.prepare('SELECT part_number, etag, size, completed_at FROM upload_parts WHERE session_id=?1 ORDER BY part_number ASC').bind(session.id).all();
      const contentState = await env.DB.prepare('SELECT status FROM contents WHERE id=?1 AND owner_username=?2').bind(session.content_id, owner).first<{ status: string }>();
      return json({
        ok: true,
        item: {
          session_id: session.id,
          attachment_id: session.attachment_id,
          content_id: session.content_id,
          filename: session.filename,
          size: session.size,
          mode: session.mode,
          status: session.status,
          session_status: session.status,
          content_status: contentState?.status ?? null,
          content_active: contentState?.status === 'active',
          expected_parts: session.expected_parts,
          completed_parts: session.completed_parts,
          uploaded_bytes: session.uploaded_bytes,
          file_fingerprint: session.file_fingerprint,
          last_activity_at: session.last_activity_at,
          expires_at: session.expires_at,
          parts: results || []
        }
      });
    }

    if (action === 'parts' && method === 'GET') {
      if (session.mode !== 'multipart') throw new HttpError(400, 'Part plans are only valid for multipart uploads');
      if (['completed', 'cancelled', 'failed', 'expired'].includes(session.status)) throw new HttpError(409, `Upload session is ${session.status}`);
      await ensureUploadSessionReservation(env, session);
      await touchUploadSession(env, session.id);
      return json({
        ok: true,
        item: await directUploadPlan(
          env,
          session,
          partWindowCursor(url.searchParams.get('after')),
          partWindowLimit(url.searchParams.get('limit'))
        ),
      });
    }

    if (action === 'heartbeat' && method === 'POST') {
      if (['completed', 'cancelled', 'failed', 'expired'].includes(session.status)) {
        return json({ ok: true, status: session.status, accepted: false });
      }
      const body = await readJson<{ fingerprint?: string }>(req);
      if (body.fingerprint && session.file_fingerprint && body.fingerprint !== session.file_fingerprint) {
        throw new HttpError(409, 'Upload fingerprint does not match this session');
      }
      await touchUploadSession(env, session.id);
      return json({ ok: true, status: session.status, accepted: true });
    }

    if (action === 'part' && method === 'POST') {
      if (session.mode !== 'multipart') throw new HttpError(400, 'Part reports are only valid for multipart uploads');
      if (['completed', 'cancelled', 'failed', 'expired'].includes(session.status)) throw new HttpError(409, `Upload session is ${session.status}`);
      await ensureUploadSessionReservation(env, session);
      const body = await readJson<{ part_number: number; etag: string }>(req);
      const partNumber = Number(body.part_number);
      const etag = normalizeEtag(body.etag);
      const plan = buildPartPlan(session.size)[partNumber - 1];
      if (!plan || !etag) throw new HttpError(400, 'Invalid multipart part report');
      const t = now();
      await env.DB.prepare(
        'INSERT INTO upload_parts (session_id, part_number, etag, size, completed_at) VALUES (?1, ?2, ?3, ?4, ?5) ON CONFLICT(session_id, part_number) DO UPDATE SET etag=excluded.etag, size=excluded.size, completed_at=excluded.completed_at'
      ).bind(session.id, partNumber, etag, plan.size, t).run();
      const state = await env.DB.prepare('SELECT COUNT(*) completed_parts, SUM(size) uploaded_bytes FROM upload_parts WHERE session_id=?1').bind(session.id).first<any>();
      const completedParts = Number(state?.completed_parts || 0);
      await env.DB.batch([
        env.DB.prepare('UPDATE upload_sessions SET status="uploading", completed_parts=?1, uploaded_bytes=?2, updated_at=?3, last_activity_at=?3 WHERE id=?4')
          .bind(completedParts, Number(state?.uploaded_bytes || 0), t, session.id),
        env.DB.prepare(
          "UPDATE storage_reservations SET expires_at=?1, updated_at=?2 WHERE content_id=?3 AND status='active' AND julianday(expires_at) > julianday('now')"
        ).bind(reservationExpiresAt(), t, session.content_id),
      ]);
      if (completedParts === session.expected_parts) await env.UPLOAD_QUEUE.send({ type: 'complete-multipart', sessionId: session.id });
      return json({ ok: true, completed_parts: completedParts, expected_parts: session.expected_parts });
    }

    if (action === 'complete' && method === 'POST') {
      const contentState = await env.DB.prepare('SELECT status FROM contents WHERE id=?1 AND owner_username=?2').bind(session.content_id, owner).first<{ status: string }>();
      if (session.status === 'completed') {
        return json({
          ok: true,
          queued: contentState?.status !== 'active',
          session_status: session.status,
          content_status: contentState?.status ?? null,
          content_active: contentState?.status === 'active',
          status_url: `${uploadBase}/${session.id}/status`,
        });
      }
      await ensureUploadSessionReservation(env, session);
      await touchUploadSession(env, session.id);
      if (session.mode === 'multipart') {
        await env.UPLOAD_QUEUE.send({ type: 'complete-multipart', sessionId: session.id });
      } else {
        const object = await env.BUCKET.head(session.object_key);
        if (!object) throw new HttpError(409, 'Uploaded object is not available yet');
        if (object.size !== session.size) {
          await rejectUploadedObject(env, session);
          throw new HttpError(422, 'Uploaded object size does not match the declared file');
        }
        await env.UPLOAD_QUEUE.send({ type: 'finalize-upload', sessionId: session.id });
      }
      return json({
        ok: true,
        queued: true,
        session_status: session.status,
        content_status: contentState?.status ?? null,
        content_active: contentState?.status === 'active',
        status_url: `${uploadBase}/${session.id}/status`,
      });
    }

    if (action === 'renew' && method === 'POST') {
      if (['completed', 'cancelled', 'failed', 'expired'].includes(session.status)) throw new HttpError(409, `Upload session is ${session.status}`);
      await ensureUploadSessionReservation(env, session);
      await touchUploadSession(env, session.id);
      const body = await readJson<{ after?: number; limit?: number }>(req);
      return json({
        ok: true,
        item: await directUploadPlan(env, session, partWindowCursor(body.after), partWindowLimit(body.limit)),
      });
    }

    if (!action && method === 'DELETE') {
      await cleanupUploadObjects(env, { sessions: [session], objectKeys: [session.object_key] });
      const t = now();
      await env.DB.batch([
        env.DB.prepare('UPDATE upload_sessions SET status="cancelled", updated_at=?1, last_activity_at=?1 WHERE id=?2').bind(t, session.id),
        env.DB.prepare('UPDATE attachments SET status="cancelled" WHERE id=?1').bind(session.attachment_id)
      ]);
      return json({ ok: true });
    }
  }

  const contentMatch = path.match(/^\/api\/contents\/([^/]+)(?:\/([^/]+))?$/);
  if (contentMatch) {
    const user = await verifySso(req, env);
    const contentId = contentMatch[1];
    const action = contentMatch[2] || '';
    const row = await env.DB.prepare('SELECT * FROM contents WHERE id = ?').bind(contentId).first<any>();
    if (!row) throw new HttpError(404, 'Content not found');
    if (row.owner_username !== user.username && user.role !== 'admin') throw new HttpError(403, 'Forbidden');
    if (!action && method === 'GET') return json({ ok: true, item: await contentWithAttachments(env.DB, contentId) });
    if (!action && method === 'PATCH') {
      const body = await readJson<any>(req);
      const visibility = ALLOWED_VISIBILITY.has(body.visibility) ? body.visibility : row.visibility;
      requireVisibility(await loadUserAccessProfile(env.DB, user.username), visibility);
      const password = typeof body.password === 'string' && body.password ? await hashWithSalt(body.password) : { hash: row.password_hash, salt: row.password_salt };
      await env.DB.prepare(
        'UPDATE contents SET title=?1, remark=?2, visibility=?3, expire_at=?4, max_views=?5, format=?6, text_content=?7, password_hash=?8, password_salt=?9, allow_download=?10, updated_at=?11 WHERE id=?12'
      )
        .bind(
          body.title?.trim() || row.title,
          nullableText(body.remark) ?? row.remark,
          visibility,
          body.expire_at === undefined ? row.expire_at : nullableText(body.expire_at),
          body.max_views === undefined ? row.max_views : numberField(body.max_views),
          ALLOWED_FORMAT.has(body.format) ? body.format : row.format,
          body.text_content === undefined ? row.text_content : String(body.text_content),
          password.hash,
          password.salt,
          allowDownloadField(body.allow_download, Number(row.allow_download ?? 1)),
          now(),
          contentId
        )
        .run();
      return json({ ok: true });
    }
    if (action === 'delete' && method === 'POST') {
      await env.DB.prepare('UPDATE contents SET status="deleted", deleted_at=?1, updated_at=?1 WHERE id=?2').bind(now(), contentId).run();
      return json({ ok: true });
    }
    if (action === 'expire' && method === 'POST') {
      await env.DB.prepare('UPDATE contents SET status="expired", forced_expired_at=?1, updated_at=?1 WHERE id=?2').bind(now(), contentId).run();
      return json({ ok: true });
    }
    if (action === 'restore' && method === 'POST') {
      await assertRestorableContent(env, row);
      await env.DB.prepare('UPDATE contents SET status="active", deleted_at=NULL, forced_expired_at=NULL, updated_at=?1 WHERE id=?2').bind(now(), contentId).run();
      return json({ ok: true });
    }
    if (action === 'permanent' && method === 'DELETE') {
      if (user.role !== 'admin') throw new HttpError(403, 'Admin permission required');
      await permanentDelete(env, contentId);
      await adminAction(env, user, 'permanent_delete', 'content', contentId);
      return json({ ok: true });
    }
  }

  const noteItemMatch = path.match(/^\/api\/share\/([^/]+)\/notes\/([^/]+)$/);
  if (noteItemMatch && method === 'DELETE') {
    const slug = decodeURIComponent(noteItemMatch[1]);
    const noteId = decodeURIComponent(noteItemMatch[2]);
    const row = await loadShareContent(env, slug);
    const user = await verifySso(req, env);
    await authorizeShareRequest(env, req, row, user, url.searchParams.get('admin_preview') === '1');
    if (user.username !== row.owner_username) throw new HttpError(403, 'Only the publisher can delete comments');
    requirePermission(await loadUserAccessProfile(env.DB, user.username), 'can_comment');
    const note = await env.DB.prepare('SELECT id FROM content_notes WHERE id = ?1 AND content_id = ?2 AND deleted_at IS NULL').bind(noteId, row.id).first<any>();
    if (!note) throw new HttpError(404, 'Comment not found');
    const t = now();
    await env.DB.prepare('UPDATE content_notes SET deleted_at = ?1, updated_at = ?1 WHERE id = ?2 OR parent_id = ?2').bind(t, noteId).run();
    return json({ ok: true, mode: row.visibility === 'private' ? 'memo' : 'comment', items: await listContentNotes(env, row, user) });
  }

  const notesMatch = path.match(/^\/api\/share\/([^/]+)\/notes$/);
  if (notesMatch && method === 'GET') {
    const slug = decodeURIComponent(notesMatch[1]);
    const row = await loadShareContent(env, slug);
    const user = await optionalUser(req, env);
    await authorizeShareRequest(env, req, row, user, url.searchParams.get('admin_preview') === '1');
    return json({ ok: true, mode: row.visibility === 'private' ? 'memo' : 'comment', items: await listContentNotes(env, row, user) });
  }

  if (notesMatch && method === 'POST') {
    const slug = decodeURIComponent(notesMatch[1]);
    const row = await loadShareContent(env, slug);
    const user = await verifySso(req, env);
    await authorizeShareRequest(env, req, row, user, url.searchParams.get('admin_preview') === '1');
    const body = await readJson<any>(req);
    const text = typeof body.body === 'string' ? body.body.trim() : '';
    if (!text) throw new HttpError(400, 'Comment body is required');
    if (text.length > 2000) throw new HttpError(400, 'Comment body is too long');
    const mode = row.visibility === 'private' ? 'memo' : 'comment';
    if (mode === 'memo' && user.username !== row.owner_username) throw new HttpError(403, 'Memo is only writable by the owner');
    requirePermission(await loadUserAccessProfile(env.DB, user.username), 'can_comment');
    const visibility = mode === 'memo' ? 'private' : body.visibility === 'private' ? 'private' : 'public';
    const parentId = mode === 'comment' && typeof body.parent_id === 'string' && body.parent_id.trim() ? body.parent_id.trim() : null;
    if (parentId) {
      const parent = await env.DB.prepare('SELECT id, content_id FROM content_notes WHERE id = ? AND deleted_at IS NULL').bind(parentId).first<any>();
      if (!parent || parent.content_id !== row.id) throw new HttpError(400, 'Invalid parent comment');
    }
    const t = now();
    await env.DB.prepare(
      'INSERT INTO content_notes (id, content_id, parent_id, author_username, body, visibility, mode, ip, ip_region, user_agent, created_at, updated_at) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?11)'
    )
      .bind(
        id('note'),
        row.id,
        parentId,
        user.username,
        text,
        visibility,
        mode,
        req.headers.get('cf-connecting-ip') || null,
        ipRegion(req),
        req.headers.get('user-agent') || null,
        t
      )
      .run();
    return json({ ok: true, items: await listContentNotes(env, row, user) });
  }

  if (path.startsWith('/api/share/') && method === 'GET') {
    const slug = decodeURIComponent(path.slice('/api/share/'.length));
    const row = await env.DB.prepare('SELECT * FROM contents WHERE slug = ?').bind(slug).first<any>();
    if (!row) throw new HttpError(404, 'Content not found');
    const user = await optionalUser(req, env);
    const access = await authorizeShareRequest(env, req, row, user, url.searchParams.get('admin_preview') === '1');
    if (!access.adminPreview && !access.ticketAuthorized) {
      const consumed = await env.DB.prepare('UPDATE contents SET view_count = view_count + 1 WHERE id = ?1 AND (max_views = 0 OR view_count < max_views)').bind(row.id).run();
      if (!consumed.meta.changes) throw new HttpError(410, 'Content expired');
      await logAccess(env, req, { contentId: row.id, slug, username: user?.username, action: 'view' });
    } else if (access.adminPreview) {
      await logAccess(env, req, { contentId: row.id, slug, username: user?.username, action: 'preview' });
    }
    const item = await shareContentWithAttachments(env, row.id, access.actor, access.adminPreview);
    if (!row.password_hash) {
      item.share_ticket = access.ticketAuthorized
        ? req.headers.get('x-share-ticket')
        : await issueMediaTicket(env.MEDIA_TICKET_SECRET, {
            attachmentId: contentTicketKey(row.id),
            actor: user?.username,
            adminPreview: access.adminPreview,
            policyVersion: row.updated_at,
            expiresInSeconds: MEDIA_TICKET_TTL_SECONDS
          });
    }
    const response = json({ ok: true, item });
    if (row.password_hash && access.passwordAuthorized) {
      const passwordTicket = await issueMediaTicket(env.MEDIA_TICKET_SECRET, {
        attachmentId: passwordCookieKey(row.id),
        policyVersion: row.updated_at,
        expiresInSeconds: SHARE_PASSWORD_TTL_SECONDS,
      });
      response.headers.append('set-cookie', serializeSharePasswordCookie(sharePasswordCookieName(row.slug), passwordTicket));
    }
    if (row.visibility !== 'public' && user) {
      response.headers.append('set-cookie', await issueShareMediaCookie(env, row, user.username, access.adminPreview));
    }
    return response;
  }

  const infoMatch = path.match(/^\/api\/attachments\/([^/]+)\/preview-info$/);
  if (infoMatch && method === 'GET') {
    const att = await env.DB.prepare('SELECT * FROM attachments WHERE id = ?').bind(infoMatch[1]).first<any>();
    if (!att) throw new HttpError(404, 'Attachment not found');
    const row = await env.DB.prepare('SELECT * FROM contents WHERE id = ?').bind(att.content_id).first<any>();
    if (!row) throw new HttpError(404, 'Content not found');
    const user = await optionalUser(req, env);
    let adminPreview = url.searchParams.get('admin_preview') === '1' && user?.role === 'admin';
    if (att.status !== 'active') throw new HttpError(409, 'Attachment has not passed upload validation');
    const mediaCookie = row.visibility !== 'public' ? await shareMediaCookieAccess(env, req, row) : null;
    const suppliedTicket = url.searchParams.get('media');
    const verifiedTicket = suppliedTicket ? await verifyMediaTicket(env.MEDIA_TICKET_SECRET, suppliedTicket, att.id) : null;
    const existingTicket = !row.password_hash && verifiedTicket?.policyVersion === row.updated_at ? verifiedTicket : null;
    if (mediaCookie) {
      adminPreview = mediaCookie.adminPreview;
    } else if (existingTicket) {
      await assertInternalShareAccess(env, row, user);
      adminPreview = existingTicket.adminPreview;
      if (row.status === 'processing') throw new HttpError(409, 'Upload is still processing');
      if (row.status === 'deleted' && !adminPreview) throw new HttpError(410, 'Content was deleted');
      if (isExpiredIgnoringViews(row) && !adminPreview) throw new HttpError(410, 'Content expired');
    } else {
      await authorizeShareRequest(env, req, row, user, adminPreview);
      if (row.password_hash) {
        throw new HttpError(409, 'Password-protected attachments must be reloaded from the password page', 'PASSWORD_ATTACHMENT_RELOAD_REQUIRED');
      }
    }
    const ticket = existingTicket ? suppliedTicket! : await issueMediaTicket(env.MEDIA_TICKET_SECRET, {
      attachmentId: att.id,
      actor: mediaCookie?.actor || user?.username,
      adminPreview,
      policyVersion: row.updated_at,
      expiresInSeconds: MEDIA_TICKET_TTL_SECONDS
    });
    const qs = new URLSearchParams({ media: ticket });
    const suffix = qs.toString() ? `?${qs}` : '';
    const previewPath = `/api/attachments/${att.id}/preview${suffix}`;
    const downloadPath = `/api/attachments/${att.id}/download${suffix}`;
    const absolutePreviewUrl = `${publicBase(env, req)}${previewPath}`;
    const kind = previewKind(att.filename, att.content_type);
    const response = json({
      ok: true,
      item: {
        id: att.id,
        filename: att.filename,
        content_type: att.content_type || 'application/octet-stream',
        size: att.size,
        kind,
        allow_download: Boolean(row.allow_download),
        preview_url: previewPath,
        download_url: downloadPath,
        office_embed_url: kind === 'office' && row.visibility === 'public' && !row.password_hash ? `https://view.officeapps.live.com/op/embed.aspx?src=${encodeURIComponent(absolutePreviewUrl)}` : null
      }
    });
    if (row.visibility !== 'public' && user) {
      response.headers.append('set-cookie', await issueShareMediaCookie(env, row, user.username, adminPreview));
    }
    return response;
  }

  const dlMatch = path.match(/^\/api\/attachments\/([^/]+)\/(download|preview)$/);
  if (dlMatch && (method === 'GET' || method === 'HEAD')) {
    const att = await env.DB.prepare('SELECT * FROM attachments WHERE id = ?').bind(dlMatch[1]).first<any>();
    if (!att) throw new HttpError(404, 'Attachment not found');
    const row = await env.DB.prepare('SELECT * FROM contents WHERE id = ?').bind(att.content_id).first<any>();
    if (!row) throw new HttpError(404, 'Content not found');
    const mode = dlMatch[2];
    if (mode === 'download' && !Boolean(row.allow_download)) {
      throw new HttpError(403, 'Download is disabled for this share', 'DOWNLOAD_DISABLED');
    }
    const session = await env.DB.prepare('SELECT * FROM upload_sessions WHERE attachment_id = ?1').bind(att.id).first<UploadSessionRow>();
    if (att.status !== 'active' || (session && session.status !== 'completed')) throw new HttpError(409, 'Attachment has not passed upload validation');
    const ticketValue = url.searchParams.get('media') || '';
    const verifiedTicket = ticketValue ? await verifyMediaTicket(env.MEDIA_TICKET_SECRET, ticketValue, att.id) : null;
    const ticket = verifiedTicket?.policyVersion === row.updated_at ? verifiedTicket : null;
    let user: User | null = null;
    let adminPreview = false;
    let actor: string | undefined;
    const mediaCookie = row.visibility !== 'public' ? await shareMediaCookieAccess(env, req, row) : null;
    if (mediaCookie) {
      adminPreview = mediaCookie.adminPreview;
      actor = mediaCookie.actor;
    } else if (ticket && !row.password_hash) {
      if (row.visibility === 'internal') user = await optionalUser(req, env);
      await assertInternalShareAccess(env, row, user);
      adminPreview = ticket.adminPreview;
      actor = ticket.actor;
      if (row.status === 'processing') throw new HttpError(409, 'Upload is still processing');
      if (row.status === 'deleted' && !adminPreview) throw new HttpError(410, 'Content was deleted');
      if (isExpiredIgnoringViews(row) && !adminPreview) throw new HttpError(410, 'Content expired');
    } else {
      user = await optionalUser(req, env);
      adminPreview = url.searchParams.get('admin_preview') === '1' && user?.role === 'admin';
      const access = await authorizeShareRequest(env, req, row, user, adminPreview);
      adminPreview = access.adminPreview;
      actor = access.actor;
    }
    if (mode === 'download' && method === 'GET') {
      let directUrl: string | null = null;
      if (att.completed_at) {
        const object = await env.BUCKET.head(att.object_key);
        const validObject = object && object.size === Number(att.size) && (!normalizeEtag(att.etag) || normalizeEtag(object.httpEtag) === normalizeEtag(att.etag));
        if (!validObject) {
          if (session) await rejectUploadedObject(env, session);
          else await cleanupUploadObjects(env, { objectKeys: [att.object_key] });
          throw new HttpError(409, 'Attachment integrity validation failed');
        }
        directUrl = await signedDownloadUrl(env, att.object_key);
      }
      if (directUrl) {
        ctx.waitUntil(Promise.all([
          env.DB.prepare('UPDATE contents SET download_count = download_count + 1 WHERE id = ?').bind(row.id).run(),
          logAccess(env, req, { contentId: row.id, slug: row.slug, username: actor, action: 'download' })
        ]).then(() => undefined));
        return new Response(null, {
          status: 302,
          headers: {
            location: directUrl,
            'cache-control': 'private, no-store',
            'referrer-policy': 'no-referrer'
          }
        });
      }
    }

    const rangeHeader = req.headers.get('range');
    const range = rangeHeader ? parseByteRange(rangeHeader, Number(att.size)) : undefined;
    if (rangeHeader && !range) {
      return new Response(null, {
        status: 416,
        headers: {
          'content-range': `bytes */${att.size}`,
          'accept-ranges': 'bytes',
          'cache-control': 'private, no-store'
        }
      });
    }
    const currentEtag = normalizeEtag(att.etag);
    const requestedEtag = normalizeEtag(req.headers.get('if-none-match'));
    if (currentEtag && requestedEtag === currentEtag) {
      return new Response(null, { status: 304, headers: { etag: `"${currentEtag}"`, 'cache-control': 'private, no-cache' } });
    }
    const obj = method === 'HEAD'
      ? await env.BUCKET.head(att.object_key)
      : await env.BUCKET.get(att.object_key, range ? { range } : undefined);
    if (!obj) throw new HttpError(404, 'R2 object not found');
    if (mode === 'download' && method === 'GET') {
      ctx.waitUntil(Promise.all([
        env.DB.prepare('UPDATE contents SET download_count = download_count + 1 WHERE id = ?').bind(row.id).run(),
        logAccess(env, req, { contentId: row.id, slug: row.slug, username: actor, action: 'download' })
      ]).then(() => undefined));
    }
    const kind = previewKind(att.filename, att.content_type);
    const previewIsSafe = ['image', 'video', 'audio', 'pdf', 'html', 'text'].includes(kind);
    const disposition = mode === 'preview' && previewIsSafe ? 'inline' : 'attachment';
    const rangeEnd = range ? range.offset + range.length - 1 : Number(att.size) - 1;
    const headers = new Headers();
    obj.writeHttpMetadata(headers);
    headers.set('content-type', mode === 'preview' && kind === 'text' ? 'text/plain; charset=utf-8' : contentTypeFor(att.filename, att.content_type));
    headers.set('content-length', String(range?.length || obj.size));
    headers.set('content-disposition', attachmentDisposition(att.filename, disposition));
    headers.set('etag', obj.httpEtag);
    headers.set('cache-control', 'private, no-cache');
    headers.set('accept-ranges', 'bytes');
    headers.set('x-content-type-options', 'nosniff');
    if (mode === 'preview') {
      headers.set(
        'content-security-policy',
        kind === 'html'
          ? "sandbox allow-scripts; default-src 'none'; img-src data: blob: https:; style-src 'unsafe-inline' https:; font-src data: blob: https:; media-src data: blob: https:; script-src 'unsafe-inline' https:; connect-src 'none'; frame-src 'none'; base-uri 'none'; form-action 'none'"
          : "sandbox; default-src 'none'"
      );
    }
    if (range) headers.set('content-range', `bytes ${range.offset}-${rangeEnd}/${obj.size}`);
    const responseBody = method !== 'HEAD' && 'body' in obj ? obj.body as ReadableStream : null;
    return new Response(responseBody, {
      status: range ? 206 : 200,
      headers
    });
  }

  if (path === '/api/api-keys' && method === 'GET') {
    const user = await verifySso(req, env);
    requirePermission(await loadUserAccessProfile(env.DB, user.username), 'can_api');
    const { results } = await env.DB.prepare(
      'SELECT id, remark, key_prefix, key_suffix, status, expire_at, last_used_at, usage_count, created_at, locked_at, lock_reason, locked_by FROM api_keys WHERE owner_username = ? ORDER BY created_at DESC'
    )
      .bind(user.username)
      .all();
    return json({ ok: true, items: results || [] });
  }
  if (path === '/api/api-keys' && method === 'POST') {
    const user = await verifySso(req, env);
    requirePermission(await loadUserAccessProfile(env.DB, user.username), 'can_api');
    return createApiKey(env, user, await readJson(req));
  }
  const keyMatch = path.match(/^\/api\/api-keys\/([^/]+)\/(rotate|revoke)$/);
  if (keyMatch && method === 'POST') {
    const user = await verifySso(req, env);
    requirePermission(await loadUserAccessProfile(env.DB, user.username), 'can_api');
    const row = await env.DB.prepare('SELECT * FROM api_keys WHERE id = ? AND owner_username = ?').bind(keyMatch[1], user.username).first<any>();
    if (!row) throw new HttpError(404, 'API Key not found');
    if (row.locked_at && keyMatch[2] === 'rotate') throw new HttpError(403, 'API Key locked', 'API_KEY_LOCKED');
    await env.DB.prepare('UPDATE api_keys SET status="revoked", revoked_at=?1 WHERE id=?2').bind(now(), row.id).run();
    if (keyMatch[2] === 'rotate') return createApiKey(env, user, { remark: `${row.remark || 'rotated key'} (rotated)`, expire_at: row.expire_at });
    return json({ ok: true });
  }

  if (path === '/api/settings/cli' && method === 'GET') {
    const user = await verifySso(req, env);
    requirePermission(await loadUserAccessProfile(env.DB, user.username), 'can_api');
    const item = await env.DB.prepare('SELECT * FROM user_cli_settings WHERE username = ?').bind(user.username).first();
    return json({ ok: true, item });
  }
  if (path === '/api/settings/cli' && method === 'PATCH') {
    const user = await verifySso(req, env);
    const body = await readJson<any>(req);
    const profile = await loadUserAccessProfile(env.DB, user.username);
    requirePermission(profile, 'can_api');
    if ((ALLOWED_VISIBILITY.has(body.default_visibility) ? body.default_visibility : 'public') === 'public') {
      requirePermission(profile, 'can_public_publish');
    }
    await env.DB.prepare(
      'INSERT INTO user_cli_settings (username, default_visibility, default_expire_days, default_max_views, default_format, default_endpoint, default_slug_mode, updated_at) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8) ' +
        'ON CONFLICT(username) DO UPDATE SET default_visibility=excluded.default_visibility, default_expire_days=excluded.default_expire_days, default_max_views=excluded.default_max_views, default_format=excluded.default_format, default_endpoint=excluded.default_endpoint, default_slug_mode=excluded.default_slug_mode, updated_at=excluded.updated_at'
    )
      .bind(
        user.username,
        ALLOWED_VISIBILITY.has(body.default_visibility) ? body.default_visibility : 'public',
        numberField(body.default_expire_days),
        numberField(body.default_max_views),
        ALLOWED_FORMAT.has(body.default_format) ? body.default_format : 'markdown',
        publicBase(env, req),
        body.default_slug_mode === 'custom' ? 'custom' : 'random',
        now()
      )
      .run();
    return json({ ok: true });
  }

  if (path === '/api/cli/upload-text' && method === 'POST') {
    const key = await apiKeyAuth(env, req);
    return createTextContent(env, req, key.owner, await readJson(req), 'cli');
  }
  if (path === '/api/cli/upload-file' && method === 'POST') {
    const key = await apiKeyAuth(env, req);
    return createUploadContent(env, req, key.owner, await req.formData(), false, 'cli');
  }
  if (path === '/api/cli/upload-mixed' && method === 'POST') {
    const key = await apiKeyAuth(env, req);
    return createUploadContent(env, req, key.owner, await req.formData(), true, 'cli');
  }

  if (path === '/api/admin/dashboard' && method === 'GET') {
    const admin = await verifySso(req, env);
    requireAdmin(admin);
    const today = dayStartIso();
    const summary = await env.DB.prepare(
      'SELECT COUNT(*) total, SUM(type="text") text_count, SUM(type="file") file_count, SUM(type="mixed") mixed_count, SUM(file_size) r2_bytes, SUM(status="expired") expired_count, SUM(status="deleted") deleted_count FROM contents'
    ).first<any>();
    const access = await env.DB.prepare(
      'SELECT SUM(action="view") today_views, SUM(action="download") today_downloads FROM access_logs WHERE created_at >= ?'
    )
      .bind(today)
      .first<any>();
    const topUsers = (await env.DB.prepare('SELECT owner_username username, COUNT(*) count FROM contents GROUP BY owner_username ORDER BY count DESC LIMIT 8').all()).results || [];
    const typeDist = (await env.DB.prepare('SELECT type label, COUNT(*) value FROM contents GROUP BY type').all()).results || [];
    const statusDist = (await env.DB.prepare('SELECT status label, COUNT(*) value FROM contents GROUP BY status').all()).results || [];
    const trend = (await env.DB.prepare("SELECT substr(created_at, 1, 10) day, COUNT(*) value FROM contents WHERE created_at >= datetime('now','-7 day') GROUP BY day ORDER BY day ASC").all()).results || [];
    return json({ ok: true, summary: { ...summary, ...access }, topUsers, typeDist, statusDist, trend });
  }

  if (path === '/api/admin/permission-groups' && method === 'GET') {
    const admin = await verifySso(req, env);
    requireAdmin(admin);
    const { results } = await env.DB.prepare('SELECT * FROM permission_groups ORDER BY is_system DESC, name ASC').all<PermissionGroupRow>();
    return json({ ok: true, items: (results || []).map(publicPermissionGroup) });
  }

  if (path === '/api/admin/permission-groups' && method === 'POST') {
    const admin = await verifySso(req, env);
    requireAdmin(admin);
    const body = await readJson<any>(req);
    const next = permissionGroupInput(body);
    const existing = await env.DB.prepare('SELECT id FROM permission_groups WHERE name=?1').bind(next.name).first<{ id: string }>();
    if (existing) throw new HttpError(409, 'Permission group name already exists', 'PERMISSION_GROUP_NAME_EXISTS');
    const groupId = id('grp');
    const t = now();
    const statements: D1PreparedStatement[] = [];
    if (next.is_default) statements.push(env.DB.prepare('UPDATE permission_groups SET is_default=0, updated_at=?1 WHERE is_default=1').bind(t));
    statements.push(
      env.DB.prepare(
        'INSERT INTO permission_groups (id, name, is_system, is_default, can_public_publish, can_api, can_internal_access, can_upload, quota_bytes, can_comment, created_at, updated_at) VALUES (?1, ?2, 0, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?10)'
      ).bind(groupId, next.name, next.is_default, next.can_public_publish, next.can_api, next.can_internal_access, next.can_upload, next.quota_bytes, next.can_comment, t),
      adminActionStatement(env, admin, 'create_permission_group', 'permission_group', groupId, next),
    );
    await env.DB.batch(statements);
    return json({ ok: true, item: publicPermissionGroup({ id: groupId, is_system: 0, ...next }) }, 201);
  }

  const adminPermissionGroupMatch = path.match(/^\/api\/admin\/permission-groups\/([^/]+)$/);
  if (adminPermissionGroupMatch) {
    const admin = await verifySso(req, env);
    requireAdmin(admin);
    const groupId = decodeURIComponent(adminPermissionGroupMatch[1]);
    const current = await env.DB.prepare('SELECT * FROM permission_groups WHERE id=?1').bind(groupId).first<PermissionGroupRow>();
    if (!current) throw new HttpError(404, 'Permission group not found', 'PERMISSION_GROUP_NOT_FOUND');

    if (method === 'PATCH') {
      const body = await readJson<any>(req);
      if (current.is_system && body.name !== undefined && String(body.name).trim() !== current.name) {
        throw new HttpError(409, 'System permission group names cannot be changed', 'SYSTEM_PERMISSION_GROUP_IMMUTABLE');
      }
      const next = permissionGroupInput(body, current);
      if (next.name !== current.name) {
        const duplicate = await env.DB.prepare('SELECT id FROM permission_groups WHERE name=?1 AND id<>?2').bind(next.name, groupId).first<{ id: string }>();
        if (duplicate) throw new HttpError(409, 'Permission group name already exists', 'PERMISSION_GROUP_NAME_EXISTS');
      }
      if (current.is_default && body.is_default === false) {
        throw new HttpError(409, 'A default permission group is required', 'DEFAULT_PERMISSION_GROUP_REQUIRED');
      }
      const t = now();
      const statements: D1PreparedStatement[] = [];
      if (next.is_default && !current.is_default) {
        statements.push(env.DB.prepare('UPDATE permission_groups SET is_default=0, updated_at=?1 WHERE is_default=1 AND id<>?2').bind(t, groupId));
      }
      statements.push(env.DB.prepare(
        'UPDATE permission_groups SET name=?1, is_default=?2, can_public_publish=?3, can_api=?4, can_internal_access=?5, can_upload=?6, quota_bytes=?7, can_comment=?8, updated_at=?9 WHERE id=?10'
      ).bind(next.name, next.is_default, next.can_public_publish, next.can_api, next.can_internal_access, next.can_upload, next.quota_bytes, next.can_comment, t, groupId));
      if (current.can_api && !next.can_api) {
        statements.push(lockGroupApiKeysStatement(env, groupId, admin.username, 'permission_group_api_removed', t));
      }
      statements.push(adminActionStatement(env, admin, 'update_permission_group', 'permission_group', groupId, next));
      await env.DB.batch(statements);
      return json({ ok: true, item: publicPermissionGroup({ id: groupId, is_system: current.is_system, ...next }) });
    }

    if (method === 'DELETE') {
      if (current.is_system) throw new HttpError(409, 'System permission groups cannot be deleted', 'SYSTEM_PERMISSION_GROUP_IMMUTABLE');
      const body = await readJson<any>(req);
      const replacementId = typeof body.replacement_group_id === 'string' ? body.replacement_group_id.trim() : '';
      if (!replacementId || replacementId === groupId) {
        throw new HttpError(400, 'A different replacement_group_id is required', 'REPLACEMENT_PERMISSION_GROUP_REQUIRED');
      }
      const replacement = await env.DB.prepare('SELECT * FROM permission_groups WHERE id=?1').bind(replacementId).first<PermissionGroupRow>();
      if (!replacement) throw new HttpError(404, 'Replacement permission group not found', 'PERMISSION_GROUP_NOT_FOUND');
      const t = now();
      const statements: D1PreparedStatement[] = [];
      if (!replacement.can_api) statements.push(lockGroupApiKeysStatement(env, groupId, admin.username, 'permission_group_reassigned_without_api', t));
      statements.push(env.DB.prepare('UPDATE users SET permission_group_id=?1, updated_at=?2 WHERE permission_group_id=?3').bind(replacementId, t, groupId));
      if (current.is_default) {
        statements.push(
          env.DB.prepare('UPDATE permission_groups SET is_default=0, updated_at=?1 WHERE id=?2').bind(t, groupId),
          env.DB.prepare('UPDATE permission_groups SET is_default=1, updated_at=?1 WHERE id=?2').bind(t, replacementId),
        );
      }
      statements.push(
        env.DB.prepare('DELETE FROM permission_groups WHERE id=?1').bind(groupId),
        adminActionStatement(env, admin, 'delete_permission_group', 'permission_group', groupId, { replacement_group_id: replacementId }),
      );
      await env.DB.batch(statements);
      return json({ ok: true, replacement_group_id: replacementId });
    }
  }

  const adminUserGroupMatch = path.match(/^\/api\/admin\/users\/([^/]+)\/group$/);
  if (adminUserGroupMatch && method === 'PATCH') {
    const admin = await verifySso(req, env);
    requireAdmin(admin);
    const username = decodeURIComponent(adminUserGroupMatch[1]);
    const body = await readJson<any>(req);
    const groupId = typeof body.group_id === 'string' ? body.group_id.trim() : '';
    if (!groupId) throw new HttpError(400, 'group_id is required', 'PERMISSION_GROUP_REQUIRED');
    const targetUser = await env.DB.prepare('SELECT username FROM users WHERE username=?1').bind(username).first<{ username: string }>();
    if (!targetUser) throw new HttpError(404, 'User not found', 'USER_NOT_FOUND');
    const group = await env.DB.prepare('SELECT * FROM permission_groups WHERE id=?1').bind(groupId).first<PermissionGroupRow>();
    if (!group) throw new HttpError(404, 'Permission group not found', 'PERMISSION_GROUP_NOT_FOUND');
    const t = now();
    const statements: D1PreparedStatement[] = [
      env.DB.prepare('UPDATE users SET permission_group_id=?1, updated_at=?2 WHERE username=?3').bind(groupId, t, username),
    ];
    if (!group.can_api) statements.push(lockUserApiKeysStatement(env, username, admin.username, 'user_reassigned_without_api', t));
    statements.push(adminActionStatement(env, admin, 'assign_user_permission_group', 'user', username, { group_id: groupId }));
    await env.DB.batch(statements);
    return json({ ok: true, username, group: publicPermissionGroup(group) });
  }

  const adminApiKeyActionMatch = path.match(/^\/api\/admin\/api-keys\/([^/]+)\/(rotate|lock|unlock|revoke)$/);
  if (adminApiKeyActionMatch && method === 'POST') {
    const admin = await verifySso(req, env);
    requireAdmin(admin);
    const keyId = decodeURIComponent(adminApiKeyActionMatch[1]);
    const action = adminApiKeyActionMatch[2];
    const row = await env.DB.prepare('SELECT * FROM api_keys WHERE id=?1').bind(keyId).first<any>();
    if (!row) throw new HttpError(404, 'API Key not found', 'API_KEY_NOT_FOUND');
    const t = now();
    if (row.status === 'revoked') throw new HttpError(409, 'API Key is revoked', 'API_KEY_REVOKED');
    if (row.status === 'expired' || (row.expire_at && Date.parse(row.expire_at) <= Date.now())) {
      throw new HttpError(409, 'API Key expired', 'API_KEY_EXPIRED');
    }
    if (action === 'unlock') {
      requirePermission(await loadUserAccessProfile(env.DB, row.owner_username), 'can_api');
      await env.DB.batch([
        env.DB.prepare('UPDATE api_keys SET locked_at=NULL, lock_reason=NULL, locked_by=NULL WHERE id=?1 AND status="active"').bind(keyId),
        adminActionStatement(env, admin, 'unlock_api_key', 'api_key', keyId, { owner_username: row.owner_username }),
      ]);
      return json({ ok: true });
    }
    if (action === 'rotate') {
      requirePermission(await loadUserAccessProfile(env.DB, row.owner_username), 'can_api');
      const created = await newApiKey(env, row.owner_username, { remark: row.remark, expire_at: row.expire_at });
      await env.DB.batch([
        env.DB.prepare('UPDATE api_keys SET status="revoked", revoked_at=?1 WHERE id=?2').bind(t, keyId),
        created.statement,
        adminActionStatement(env, admin, 'rotate_api_key', 'api_key', keyId, { owner_username: row.owner_username, replacement_key_id: created.item.id }),
      ]);
      return json({ ok: true, key: created.raw, item: created.item });
    }
    if (action === 'lock') {
      await env.DB.batch([
        env.DB.prepare('UPDATE api_keys SET locked_at=COALESCE(locked_at, ?1), lock_reason=COALESCE(lock_reason, "admin_lock"), locked_by=COALESCE(locked_by, ?2) WHERE id=?3 AND status="active"').bind(t, admin.username, keyId),
        adminActionStatement(env, admin, 'lock_api_key', 'api_key', keyId, { owner_username: row.owner_username }),
      ]);
      return json({ ok: true });
    }
    await env.DB.batch([
      env.DB.prepare('UPDATE api_keys SET status="revoked", revoked_at=?1 WHERE id=?2').bind(t, keyId),
      adminActionStatement(env, admin, 'revoke_api_key', 'api_key', keyId, { owner_username: row.owner_username }),
    ]);
    return json({ ok: true });
  }

  if (path === '/api/admin/contents' && method === 'GET') {
    const admin = await verifySso(req, env);
    requireAdmin(admin);
    const { results } = await env.DB.prepare('SELECT * FROM contents ORDER BY created_at DESC LIMIT 500').all();
    return json({ ok: true, items: results || [] });
  }

  const adminUploadRetryMatch = path.match(/^\/api\/admin\/uploads\/([^/]+)\/retry$/);
  if (adminUploadRetryMatch && method === 'POST') {
    const admin = await verifySso(req, env);
    requireAdmin(admin);
    const session = await env.DB.prepare('SELECT * FROM upload_sessions WHERE id=?1').bind(adminUploadRetryMatch[1]).first<UploadSessionRow>();
    if (!session) throw new HttpError(404, 'Upload session not found');
    if (session.status === 'completed') return json({ ok: true, status: 'completed' });
    if (session.mode === 'multipart') {
      const state = await env.DB.prepare('SELECT COUNT(*) count FROM upload_parts WHERE session_id=?1').bind(session.id).first<{ count: number }>();
      if (Number(state?.count || 0) !== session.expected_parts) throw new HttpError(409, 'Multipart upload is incomplete');
      await env.UPLOAD_QUEUE.send({ type: 'complete-multipart', sessionId: session.id });
    } else {
      if (!(await env.BUCKET.head(session.object_key))) throw new HttpError(409, 'Uploaded object is no longer available');
      await env.UPLOAD_QUEUE.send({ type: 'finalize-upload', sessionId: session.id });
    }
    const t = now();
    await env.DB.batch([
      env.DB.prepare('UPDATE upload_sessions SET status="completing", updated_at=?1, last_activity_at=?1 WHERE id=?2').bind(t, session.id),
      env.DB.prepare('UPDATE attachments SET status="pending" WHERE id=?1').bind(session.attachment_id),
      env.DB.prepare('UPDATE contents SET status="processing", forced_expired_at=NULL, updated_at=?1 WHERE id=?2').bind(t, session.content_id)
    ]);
    await adminAction(env, admin, 'retry_upload_queue', 'upload_session', session.id);
    return json({ ok: true, queued: true });
  }

  const adminContentMatch = path.match(/^\/api\/admin\/contents\/([^/]+)(?:\/([^/]+))?$/);
  if (adminContentMatch) {
    const admin = await verifySso(req, env);
    requireAdmin(admin);
    const contentId = adminContentMatch[1];
    const action = adminContentMatch[2] || '';
    if (!action && method === 'GET') return json({ ok: true, item: await contentWithAttachments(env.DB, contentId) });
    if (!action && method === 'PATCH') {
      const body = await readJson<any>(req);
      const row = await env.DB.prepare('SELECT visibility, allow_download FROM contents WHERE id=?1').bind(contentId).first<{ visibility: string; allow_download: number }>();
      if (!row) throw new HttpError(404, 'Content not found');
      const visibility = ALLOWED_VISIBILITY.has(body.visibility) ? body.visibility : row.visibility;
      requireVisibility(await loadUserAccessProfile(env.DB, admin.username), visibility);
      await env.DB.prepare('UPDATE contents SET visibility=COALESCE(?1, visibility), expire_at=?2, max_views=COALESCE(?3, max_views), allow_download=?4, updated_at=?5 WHERE id=?6')
        .bind(visibility, body.expire_at === undefined ? null : nullableText(body.expire_at), body.max_views === undefined ? null : numberField(body.max_views), allowDownloadField(body.allow_download, Number(row.allow_download ?? 1)), now(), contentId)
        .run();
      await adminAction(env, admin, 'update_content', 'content', contentId, body);
      return json({ ok: true });
    }
    if (action === 'delete' && method === 'POST') {
      await env.DB.prepare('UPDATE contents SET status="deleted", deleted_at=?1, updated_at=?1 WHERE id=?2').bind(now(), contentId).run();
      await adminAction(env, admin, 'soft_delete', 'content', contentId);
      return json({ ok: true });
    }
    if (action === 'expire' && method === 'POST') {
      await env.DB.prepare('UPDATE contents SET status="expired", forced_expired_at=?1, updated_at=?1 WHERE id=?2').bind(now(), contentId).run();
      await adminAction(env, admin, 'expire', 'content', contentId);
      return json({ ok: true });
    }
    if (action === 'restore' && method === 'POST') {
      const row = await env.DB.prepare('SELECT * FROM contents WHERE id=?1').bind(contentId).first<any>();
      if (!row) throw new HttpError(404, 'Content not found');
      await assertRestorableContent(env, row);
      await env.DB.prepare('UPDATE contents SET status="active", deleted_at=NULL, forced_expired_at=NULL, updated_at=?1 WHERE id=?2').bind(now(), contentId).run();
      await adminAction(env, admin, 'restore', 'content', contentId);
      return json({ ok: true });
    }
    if (action === 'permanent' && method === 'DELETE') {
      await permanentDelete(env, contentId);
      await adminAction(env, admin, 'permanent_delete', 'content', contentId);
      return json({ ok: true });
    }
  }

  if (path === '/api/admin/users' && method === 'GET') {
    const admin = await verifySso(req, env);
    requireAdmin(admin);
    const { results } = await env.DB.prepare(
      `WITH content_stats AS (
        SELECT owner_username,
          COUNT(id) total_count,
          SUM(type="text") text_count,
          SUM(type="file") file_count,
          SUM(type="mixed") mixed_count,
          SUM(visibility="public") public_count,
          SUM(visibility="internal") internal_count,
          SUM(visibility="private") private_count,
          SUM(status="expired") expired_count,
          SUM(status="deleted") deleted_count,
          COALESCE(SUM(file_size), 0) total_file_size,
          COALESCE(SUM(COALESCE(file_size, 0) + COALESCE(text_size, 0)), 0) used_bytes,
          COALESCE(SUM(view_count), 0) total_views,
          MAX(created_at) last_publish_at
        FROM contents
        GROUP BY owner_username
      )
      SELECT u.username, u.role, u.permission_group_id,
        p.name permission_group_name,
        p.can_public_publish, p.can_api, p.can_internal_access, p.can_upload, p.can_comment, p.quota_bytes,
        COALESCE(s.total_count, 0) total_count,
        COALESCE(s.text_count, 0) text_count,
        COALESCE(s.file_count, 0) file_count,
        COALESCE(s.mixed_count, 0) mixed_count,
        COALESCE(s.public_count, 0) public_count,
        COALESCE(s.internal_count, 0) internal_count,
        COALESCE(s.private_count, 0) private_count,
        COALESCE(s.expired_count, 0) expired_count,
        COALESCE(s.deleted_count, 0) deleted_count,
        COALESCE(s.total_file_size, 0) total_file_size,
        COALESCE(s.used_bytes, 0) used_bytes,
        COALESCE((
          SELECT SUM(r.bytes) FROM storage_reservations r
          WHERE r.owner_username=u.username AND r.status="active" AND julianday(r.expires_at) > julianday("now")
        ), 0) reserved_bytes,
        COALESCE(s.total_views, 0) total_views,
        s.last_publish_at
      FROM users u
      JOIN permission_groups p ON p.id=u.permission_group_id
      LEFT JOIN content_stats s ON s.owner_username=u.username
      ORDER BY total_count DESC`
    ).all();
    return json({ ok: true, items: results || [] });
  }
  if (path === '/api/admin/access-logs' && method === 'GET') {
    const admin = await verifySso(req, env);
    requireAdmin(admin);
    const { results } = await env.DB.prepare('SELECT * FROM access_logs ORDER BY created_at DESC LIMIT 300').all();
    return json({ ok: true, items: results || [] });
  }
  if (path === '/api/admin/api-keys' && method === 'GET') {
    const admin = await verifySso(req, env);
    requireAdmin(admin);
    const { results } = await env.DB.prepare('SELECT id, owner_username, remark, key_prefix, key_suffix, status, expire_at, last_used_at, usage_count, created_at, locked_at, lock_reason, locked_by FROM api_keys ORDER BY created_at DESC LIMIT 300').all();
    return json({ ok: true, items: results || [] });
  }
  if (path === '/api/admin/settings' && method === 'GET') {
    const admin = await verifySso(req, env);
    requireAdmin(admin);
    return json({
      ok: true,
      item: {
        worker: 'content-share',
        domain: publicBase(env, req),
        storage: 'Cloudflare R2 only',
        database: 'Cloudflare D1',
        queue: 'content-share-upload-queue',
        sso_app_id: env.SSO_APP_ID
      }
    });
  }

  if (path === '/api/admin/background' && method === 'GET') {
    const admin = await verifySso(req, env);
    requireAdmin(admin);
    return json({ ok: true, item: await systemSetting(env.DB, 'landing_background') });
  }

  if (path === '/api/admin/background' && method === 'POST') {
    const admin = await verifySso(req, env);
    requireAdmin(admin);
    const form = await req.formData();
    const file = form.get('file');
    const opacity = Math.min(1, Math.max(0, Number(form.get('opacity') || 0.32)));
    if (!(file instanceof File) || !file.size) throw new HttpError(400, 'Background image file is required');
    if (!file.type.startsWith('image/')) throw new HttpError(400, 'Background must be an image');
    const old = await systemSetting(env.DB, 'landing_background');
    if (old?.object_key) await env.BUCKET.delete(old.object_key);
    const ext = file.name.includes('.') ? file.name.split('.').pop() : 'img';
    const objectKey = `background/${Date.now()}-${crypto.randomUUID()}.${ext}`;
    await env.BUCKET.put(objectKey, file.stream(), {
      httpMetadata: { contentType: file.type },
      customMetadata: { uploadedBy: admin.username, purpose: 'landing-background' }
    });
    const value = {
      object_key: objectKey,
      filename: file.name,
      content_type: file.type,
      size: file.size,
      opacity,
      url: `/api/background/${encodeURIComponent(objectKey.split('/').slice(1).join('/'))}`
    };
    await setSystemSetting(env.DB, 'landing_background', value, admin);
    await adminAction(env, admin, 'update_background', 'system_settings', 'landing_background', value);
    return json({ ok: true, item: value });
  }

  if (path === '/api/admin/background' && method === 'PATCH') {
    const admin = await verifySso(req, env);
    requireAdmin(admin);
    const body = await readJson<any>(req);
    const current = (await systemSetting(env.DB, 'landing_background')) || {};
    const opacity = Math.min(1, Math.max(0, Number(body.opacity ?? current.opacity ?? 0.32)));
    const value = { ...current, opacity };
    await setSystemSetting(env.DB, 'landing_background', value, admin);
    await adminAction(env, admin, 'update_background_opacity', 'system_settings', 'landing_background', value);
    return json({ ok: true, item: value });
  }

  if (path === '/api/admin/background' && method === 'DELETE') {
    const admin = await verifySso(req, env);
    requireAdmin(admin);
    const current = await systemSetting(env.DB, 'landing_background');
    if (current?.object_key) await env.BUCKET.delete(current.object_key);
    await env.DB.prepare('DELETE FROM system_settings WHERE key = ?').bind('landing_background').run();
    await adminAction(env, admin, 'clear_background', 'system_settings', 'landing_background', current);
    return json({ ok: true });
  }

  return json({ ok: false, message: 'API route not found' }, 404);
}

export default {
  async fetch(req: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    const url = new URL(req.url);
    try {
      if (url.pathname.startsWith('/api/background/')) {
        const key = `background/${decodeURIComponent(url.pathname.slice('/api/background/'.length))}`;
        const object = await env.BUCKET.get(key);
        if (!object) return json({ ok: false, message: 'Background not found' }, 404);
        return new Response(object.body, {
          headers: {
            'content-type': object.httpMetadata?.contentType || 'application/octet-stream',
            'cache-control': 'public, max-age=300'
          }
        });
      }
      if (url.pathname.startsWith('/api/')) return await handleApi(req, env, ctx);
      return env.ASSETS.fetch(req);
    } catch (err) {
      if (err instanceof HttpError) {
        return json({
          ok: false,
          message: err.message,
          ...(err.code ? { code: err.code } : {}),
          ...(err.details ? { details: err.details } : {}),
        }, err.status);
      }
      if (err instanceof PolicyError) {
        return json({ ok: false, message: err.message, code: err.code, ...(Object.keys(err.details).length ? { details: err.details } : {}) }, err.status);
      }
      const message = err instanceof Error ? err.message : 'Internal error';
      return json({ ok: false, message }, 500);
    }
  },

  async queue(batch: MessageBatch<UploadMessage | R2EventMessage>, env: Env): Promise<void> {
    for (const msg of batch.messages) {
      try {
        const body = msg.body;
        if ('type' in body && body.type === 'complete-multipart') {
          await completeMultipartSession(env, body.sessionId);
        } else if ('type' in body && body.type === 'finalize-upload') {
          if (body.sessionId) {
            await finalizeUploadedSession(env, body.sessionId);
          } else if (body.contentId) {
            await refreshContentUploadState(env, body.contentId);
          }
        } else if ('object' in body && body.object?.key) {
          const session = await env.DB.prepare('SELECT id FROM upload_sessions WHERE object_key=?1').bind(body.object.key).first<{ id: string }>();
          if (session) await finalizeUploadedSession(env, session.id);
        }
        msg.ack();
      } catch (error) {
        console.error(JSON.stringify({
          event: 'upload_queue_error',
          attempts: msg.attempts,
          message: error instanceof Error ? error.message : 'Unknown queue error'
        }));
        if (msg.attempts >= QUEUE_MAX_ATTEMPTS) {
          try {
            await markQueueMessageFailed(env, msg.body, error);
          } catch (cleanupError) {
            console.error(JSON.stringify({
              event: 'upload_queue_cleanup_failed',
              attempts: msg.attempts,
              message: cleanupError instanceof Error ? cleanupError.message : 'R2 cleanup failed',
            }));
          }
        }
        msg.retry();
      }
    }
  },

  async scheduled(_controller: ScheduledController, env: Env, ctx: ExecutionContext): Promise<void> {
    ctx.waitUntil(cleanupStaleUploadSessions(env).then((cleaned) => {
      if (cleaned > 0) console.log(JSON.stringify({ event: 'stale_upload_cleanup', cleaned }));
    }));
  }
};
