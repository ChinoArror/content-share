import { buildPartPlan, chooseUploadMode, finalizedObjectKey, isContentReadyForActivation, MAX_UPLOAD_SIZE, normalizeUploadFilename, parseByteRange, safeObjectKey, safeStagingObjectKey } from './transfer-policy';
import { presignR2Request } from './r2-signer';
import { issueMediaTicket, verifyMediaTicket } from './media-ticket';
import { isUploadSessionReusable, isUploadSessionStale, UPLOAD_INACTIVITY_MS } from './upload-resume';
import { previewKind } from './preview-policy';

type Env = {
  DB: D1Database;
  BUCKET: R2Bucket;
  UPLOAD_QUEUE: Queue<UploadMessage | R2EventMessage>;
  ASSETS: Fetcher;
  SSO_URL: string;
  SSO_APP_ID: string;
  MEDIA_TICKET_SECRET: string;
  PUBLIC_BASE_URL: string;
  ADMIN_USERNAMES: string;
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
const QUEUE_MAX_ATTEMPTS = 6;
const MAX_PENDING_UPLOAD_BYTES_PER_USER = 500 * 1024 * 1024;
const MAX_PENDING_UPLOAD_SESSIONS_PER_USER = 50;
const RESUMABLE_SESSION_STATUSES = '"pending","uploading","completing"';
const CLEANUP_SESSION_STATUSES = '"pending","uploading","completing","failed"';

function json(data: unknown, status = 200): Response {
  return new Response(JSON.stringify(data), { status, headers: JSON_HEADERS });
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

async function touchUploadSession(env: Env, sessionId: string): Promise<void> {
  const timestamp = now();
  const expiresAt = new Date(Date.now() + UPLOAD_SESSION_TTL_MS).toISOString();
  await env.DB.prepare(
    `UPDATE upload_sessions SET last_activity_at=?1, updated_at=?1, expires_at=?2 WHERE id=?3 AND status IN (${RESUMABLE_SESSION_STATUSES})`
  ).bind(timestamp, expiresAt, sessionId).run();
}

async function findReusableUploadSessions(
  env: Env,
  owner: string,
  files: Array<{ size: number; fingerprint: string }>
): Promise<{ content: { id: string; slug: string; status: string }; sessions: UploadSessionRow[] } | null> {
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
  const content = await env.DB.prepare('SELECT id, slug, status FROM contents WHERE id=?1').bind(contentId).first<{ id: string; slug: string; status: string }>();
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

  constructor(status: number, message: string) {
    super(message);
    this.status = status;
  }
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
  const username = String(source.username || payload.username || '').trim();
  if (!username) throw new HttpError(403, 'auth-center token does not include username');
  const adminNames = (env.ADMIN_USERNAMES || '').split(',').map((v) => v.trim()).filter(Boolean);
  const roleRaw = String(source.role || payload.role || '').toLowerCase();
  const role: 'admin' | 'user' = roleRaw === 'admin' || adminNames.includes(username) ? 'admin' : 'user';
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
    id: String(source.uuid || payload.uuid || username),
    uuid: String(source.uuid || payload.uuid || ''),
    user_id: Number(source.user_id || payload.user_id || 0) || undefined,
    username,
    name: String(source.name || payload.name || username),
    role,
    avatar_url: avatarUrl
  };
  await upsertUser(env.DB, user);
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

function requireAdmin(user: User): void {
  if (user.role !== 'admin') throw new HttpError(403, 'Admin permission required');
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

async function adminAction(env: Env, admin: User, action: string, targetType: string, targetId: string, detail?: unknown): Promise<void> {
  await env.DB.prepare(
    'INSERT INTO admin_actions (id, admin_username, action, target_type, target_id, detail, created_at) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7)'
  )
    .bind(id('adm'), admin.username, action, targetType, targetId, detail ? JSON.stringify(detail) : null, now())
    .run();
}

async function contentWithAttachments(db: D1Database, contentId: string): Promise<any> {
  const content = await db.prepare('SELECT * FROM contents WHERE id = ?').bind(contentId).first<any>();
  if (!content) throw new HttpError(404, 'Content not found');
  const { results } = await db.prepare('SELECT id, filename, content_type, size, status, created_at FROM attachments WHERE content_id = ? ORDER BY created_at ASC').bind(contentId).all();
  return { ...content, attachments: results || [] };
}

async function shareContentWithAttachments(env: Env, contentId: string, actor?: string, adminPreview = false): Promise<any> {
  const content = await env.DB.prepare(
    'SELECT id, owner_username, title, slug, type, format, text_content, visibility, status, password_hash, expire_at, max_views, view_count, download_count, file_size, remark, created_at, updated_at FROM contents WHERE id = ?1'
  ).bind(contentId).first<any>();
  if (!content) throw new HttpError(404, 'Content not found');
  const { results } = await env.DB.prepare(
    'SELECT id, filename, content_type, size, status, created_at FROM attachments WHERE content_id = ?1 AND status = "active" ORDER BY created_at ASC'
  ).bind(contentId).all<any>();
  const attachments = await Promise.all((results || []).map(async (attachment) => ({
    ...attachment,
    office_preview_allowed: content.visibility === 'public' && !content.password_hash,
    media_ticket: await issueMediaTicket(env.MEDIA_TICKET_SECRET, {
      attachmentId: attachment.id,
      actor,
      adminPreview,
      policyVersion: content.updated_at,
      expiresInSeconds: MEDIA_TICKET_TTL_SECONDS
    })
  })));
  const { password_hash: _passwordHash, ...safeContent } = content;
  return { ...safeContent, attachments };
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
    throw new HttpError(423, 'Password required or incorrect');
  }
  if (row.visibility === 'internal' && !user) throw new HttpError(401, 'Login required');
  if (row.visibility === 'private' && user?.username !== row.owner_username && !(user?.role === 'admin' && adminPreview)) {
    throw new HttpError(403, 'Private content');
  }
}

async function authorizeShareRequest(
  env: Env,
  req: Request,
  row: any,
  user: User | null,
  requestedAdminPreview: boolean
): Promise<{ ticketAuthorized: boolean; adminPreview: boolean; actor?: string }> {
  const ticketValue = req.headers.get('x-share-ticket') || '';
  const ticket = ticketValue
    ? await verifyMediaTicket(env.MEDIA_TICKET_SECRET, ticketValue, contentTicketKey(row.id))
    : null;
  if (ticket && ticket.policyVersion === row.updated_at) {
    const adminPreview = ticket.adminPreview;
    if (row.status === 'processing') throw new HttpError(409, 'Upload is still processing');
    if (row.status === 'deleted' && !adminPreview) throw new HttpError(410, 'Content was deleted');
    if (isExpiredIgnoringViews(row) && !adminPreview) throw new HttpError(410, 'Content expired');
    return { ticketAuthorized: true, adminPreview, actor: ticket.actor };
  }
  const adminPreview = requestedAdminPreview && user?.role === 'admin';
  await assertShareAccess(env, req, row, user, sharePassword(req), adminPreview);
  return { ticketAuthorized: false, adminPreview, actor: user?.username };
}

async function createTextContent(env: Env, req: Request, owner: string, input: any, source: 'web' | 'cli'): Promise<Response> {
  const t = now();
  const visibility = ALLOWED_VISIBILITY.has(input.visibility) ? input.visibility : 'public';
  const format = ALLOWED_FORMAT.has(input.format) ? input.format : 'plain';
  const slug = await uniqueSlug(env.DB, input.slug);
  const contentId = id('cnt');
  const password = await hashWithSalt(input.password);
  await env.DB.prepare(
    'INSERT INTO contents (id, owner_username, title, slug, type, format, text_content, visibility, status, password_hash, password_salt, expire_at, max_views, remark, created_at, updated_at) VALUES (?1, ?2, ?3, ?4, "text", ?5, ?6, ?7, "active", ?8, ?9, ?10, ?11, ?12, ?13, ?13)'
  )
    .bind(
      contentId,
      owner,
      input.title?.trim() || 'Untitled text',
      slug,
      format,
      String(input.content || ''),
      visibility,
      password.hash,
      password.salt,
      nullableText(input.expire_at),
      numberField(input.max_views),
      nullableText(input.remark),
      t
    )
    .run();
  return json({ ok: true, url: `${publicBase(env, req)}/s/${slug}`, slug, content_id: contentId, source });
}

async function putAttachments(env: Env, contentId: string, owner: string, files: File[]): Promise<number> {
  let totalSize = 0;
  for (const file of files) {
    const attachmentId = id('att');
    const objectKey = `${owner}/${contentId}/${attachmentId}-${file.name}`;
    const contentType = contentTypeFor(file.name, file.type);
    await env.BUCKET.put(objectKey, file.stream(), {
      httpMetadata: { contentType },
      customMetadata: { owner, contentId, attachmentId }
    });
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
  if (files.some((file) => file.size > MAX_UPLOAD_SIZE)) throw new HttpError(413, 'A file exceeds the 100 MiB limit');
  const contentText = textField(form.get('content'));
  const type = mixed || contentText ? 'mixed' : 'file';
  const visibilityRaw = textField(form.get('visibility'));
  const visibility = ALLOWED_VISIBILITY.has(visibilityRaw) ? visibilityRaw : 'public';
  const formatRaw = textField(form.get('format'));
  const format = ALLOWED_FORMAT.has(formatRaw) ? formatRaw : 'plain';
  const slug = await uniqueSlug(env.DB, textField(form.get('slug')));
  const contentId = id('cnt');
  const password = await hashWithSalt(textField(form.get('password')));
  const t = now();
  await env.DB.prepare(
    'INSERT INTO contents (id, owner_username, title, slug, type, format, text_content, visibility, status, password_hash, password_salt, expire_at, max_views, remark, created_at, updated_at) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, "processing", ?9, ?10, ?11, ?12, ?13, ?14, ?14)'
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
      t
    )
    .run();
  const totalSize = await putAttachments(env, contentId, owner, files);
  await env.DB.prepare('UPDATE contents SET file_size = ?1, updated_at = ?2 WHERE id = ?3').bind(totalSize, now(), contentId).run();
  await env.UPLOAD_QUEUE.send({ type: 'finalize-upload', contentId, owner });
  return json({ ok: true, queued: true, url: `${publicBase(env, req)}/s/${slug}`, slug, content_id: contentId, source });
}

async function directUploadPlan(env: Env, session: UploadSessionRow) {
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

  const parts = await Promise.all(buildPartPlan(session.size).map(async (part) => {
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
    part_size: parts[0]?.size || session.size,
    parts,
    completed_parts: completedParts,
    expires_at: new Date(Date.now() + UPLOAD_SIGNATURE_TTL_SECONDS * 1000).toISOString()
  };
}

async function createDirectUploadContent(env: Env, req: Request, owner: string, input: any, source: 'web' | 'cli'): Promise<Response> {
  if (!directUploadConfigured(env)) throw new HttpError(503, 'Direct R2 upload is not configured');
  const requestedFiles = Array.isArray(input.files) ? input.files as DirectUploadFile[] : [];
  if (!requestedFiles.length) throw new HttpError(400, 'At least one file is required');
  if (requestedFiles.length > 20) throw new HttpError(400, 'A maximum of 20 files can be uploaded at once');
  const firstFileMetadata = typeof requestedFiles[0]?.metadata === 'object' && requestedFiles[0].metadata
    ? requestedFiles[0].metadata
    : {};
  const settings = { ...firstFileMetadata, ...input };

  const files = await Promise.all(requestedFiles.map(async (file) => {
    const name = normalizeUploadFilename(String(file.name || ''));
    const size = Number(file.size);
    buildPartPlan(size);
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
  const reusable = await findReusableUploadSessions(env, owner, files);
  if (reusable) {
    const timestamp = now();
    const expiresAt = new Date(Date.now() + UPLOAD_SESSION_TTL_MS).toISOString();
    await env.DB.batch(reusable.sessions.map((session) => env.DB.prepare(
      'UPDATE upload_sessions SET last_activity_at=?1, updated_at=?1, expires_at=?2 WHERE id=?3'
    ).bind(timestamp, expiresAt, session.id)));
    const plans = await Promise.all(reusable.sessions.map(async (session, index) => ({
      ...(await directUploadPlan(env, session)),
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
  const requestedBytes = files.reduce((total, file) => total + file.size, 0);
  const pending = await env.DB.prepare(
    'SELECT COUNT(*) count, COALESCE(SUM(size), 0) bytes FROM upload_sessions WHERE owner_username=?1 AND expires_at > ?2 AND status IN ("pending","uploading","completing","failed")'
  ).bind(owner, now()).first<{ count: number; bytes: number }>();
  if (Number(pending?.count || 0) + files.length > MAX_PENDING_UPLOAD_SESSIONS_PER_USER) {
    throw new HttpError(429, 'Too many unfinished upload sessions');
  }
  if (Number(pending?.bytes || 0) + requestedBytes > MAX_PENDING_UPLOAD_BYTES_PER_USER) {
    throw new HttpError(429, 'Unfinished uploads exceed the 500 MiB per-user limit');
  }
  const contentText = typeof settings.content === 'string' ? settings.content.trim() : '';
  const visibility = ALLOWED_VISIBILITY.has(settings.visibility) ? settings.visibility : 'public';
  const format = ALLOWED_FORMAT.has(settings.format) ? settings.format : 'plain';
  const slug = await uniqueSlug(env.DB, settings.slug);
  const contentId = id('cnt');
  const password = await hashWithSalt(settings.password);
  const createdAt = now();
  const expiresAt = new Date(Date.now() + UPLOAD_SESSION_TTL_MS).toISOString();
  const sessions: UploadSessionRow[] = [];
  const multipartUploads: R2MultipartUpload[] = [];

  try {
    for (const file of files) {
      const attachmentId = id('att');
      const sessionId = id('upl');
      const mode = chooseUploadMode(file.size);
      const objectKey = mode === 'single'
        ? safeStagingObjectKey(owner, contentId, attachmentId)
        : safeObjectKey(owner, contentId, attachmentId);
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

    const statements: D1PreparedStatement[] = [
      env.DB.prepare(
        'INSERT INTO contents (id, owner_username, title, slug, type, format, text_content, visibility, status, password_hash, password_salt, expire_at, max_views, remark, created_at, updated_at) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, "processing", ?9, ?10, ?11, ?12, ?13, ?14, ?14)'
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
        createdAt
      )
    ];
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
      ...(await directUploadPlan(env, session)),
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
    await Promise.allSettled(multipartUploads.map((upload) => upload.abort()));
    await env.DB.prepare('DELETE FROM contents WHERE id = ?1').bind(contentId).run().catch(() => undefined);
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
    'SELECT COUNT(*) expected, SUM(status="completed") completed, SUM(status="failed") failed, SUM(CASE WHEN status="completed" THEN size ELSE 0 END) total_size FROM upload_sessions WHERE content_id=?1'
  ).bind(contentId).first<any>();
  if (!state) return;
  const expected = Number(state.expected || 0);
  const completed = Number(state.completed || 0);
  const failed = Number(state.failed || 0);
  if (isContentReadyForActivation(expected, completed, failed)) {
    await env.DB.prepare('UPDATE contents SET status="active", file_size=?1, updated_at=?2 WHERE id=?3 AND status="processing"')
      .bind(Number(state.total_size || 0), now(), contentId)
      .run();
  }
}

async function rejectUploadedObject(env: Env, session: UploadSessionRow): Promise<void> {
  await env.BUCKET.delete(session.object_key).catch(() => undefined);
  const t = now();
  await env.DB.batch([
    env.DB.prepare('UPDATE upload_sessions SET status="failed", updated_at=?1, last_activity_at=?1 WHERE id=?2').bind(t, session.id),
    env.DB.prepare('UPDATE attachments SET status="failed" WHERE id=?1').bind(session.attachment_id),
    env.DB.prepare('UPDATE contents SET status="expired", forced_expired_at=?1, updated_at=?1 WHERE id=?2').bind(t, session.content_id)
  ]);
}

async function finalizeUploadedSession(env: Env, sessionId: string): Promise<void> {
  const session = await env.DB.prepare('SELECT * FROM upload_sessions WHERE id=?1').bind(sessionId).first<UploadSessionRow>();
  if (!session) return;
  if (['cancelled', 'expired'].includes(session.status)) return;
  if (session.status === 'completed' && session.mode === 'single') {
    await env.BUCKET.delete(session.object_key).catch(() => undefined);
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
  if (session.status === 'completed') return;
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
  if (session.mode === 'single') await env.BUCKET.delete(session.object_key).catch(() => undefined);
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
  let sessionId = 'sessionId' in body ? body.sessionId : undefined;
  if (!sessionId && 'object' in body && body.object?.key) {
    sessionId = (await env.DB.prepare('SELECT id FROM upload_sessions WHERE object_key=?1').bind(body.object.key).first<{ id: string }>())?.id;
  }
  if (!sessionId) return;
  const session = await env.DB.prepare('SELECT * FROM upload_sessions WHERE id=?1').bind(sessionId).first<UploadSessionRow>();
  if (!session || session.status === 'completed') return;
  const t = now();
  const message = error instanceof Error ? error.message.slice(0, 500) : 'Queue processing failed';
  await env.DB.batch([
    env.DB.prepare('UPDATE upload_sessions SET status="failed", updated_at=?1, last_activity_at=?1 WHERE id=?2').bind(t, session.id),
    env.DB.prepare('UPDATE attachments SET status="failed" WHERE id=?1').bind(session.attachment_id),
    env.DB.prepare('UPDATE contents SET status="expired", forced_expired_at=?1, updated_at=?1 WHERE id=?2').bind(t, session.content_id),
    env.DB.prepare('INSERT INTO admin_actions (id, admin_username, action, target_type, target_id, detail, created_at) VALUES (?1, "system", "upload_queue_failed", "upload_session", ?2, ?3, ?4)')
      .bind(id('adm'), session.id, JSON.stringify({ message }), t)
  ]);
}

async function apiKeyAuth(env: Env, req: Request): Promise<{ id: string; owner: string }> {
  const key = bearer(req);
  if (!key) throw new HttpError(401, 'Missing API Key');
  const hash = await keyHash(key);
  const row = await env.DB.prepare('SELECT * FROM api_keys WHERE key_hash = ?').bind(hash).first<any>();
  if (!row || row.status === 'revoked') throw new HttpError(401, 'Invalid API Key');
  if (row.expire_at && Date.parse(row.expire_at) <= Date.now()) {
    await env.DB.prepare('UPDATE api_keys SET status = "expired" WHERE id = ?').bind(row.id).run();
    throw new HttpError(401, 'API Key expired');
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

async function createApiKey(env: Env, user: User, input: any): Promise<Response> {
  const rawBytes = new Uint8Array(32);
  crypto.getRandomValues(rawBytes);
  const raw = `csk_${base64Url(rawBytes)}`;
  const apiKeyId = id('key');
  await env.DB.prepare(
    'INSERT INTO api_keys (id, owner_username, remark, key_hash, key_prefix, key_suffix, status, expire_at, created_at) VALUES (?1, ?2, ?3, ?4, ?5, ?6, "active", ?7, ?8)'
  )
    .bind(apiKeyId, user.username, nullableText(input.remark), await keyHash(raw), raw.slice(0, 10), raw.slice(-4), nullableText(input.expire_at), now())
    .run();
  return json({ ok: true, key: raw, item: { id: apiKeyId, remark: input.remark || '', key_prefix: raw.slice(0, 10), key_suffix: raw.slice(-4), status: 'active', expire_at: input.expire_at || null } });
}

async function permanentDelete(env: Env, contentId: string): Promise<void> {
  const { results } = await env.DB.prepare('SELECT object_key FROM attachments WHERE content_id = ?').bind(contentId).all<{ object_key: string }>();
  const sessions = (await env.DB.prepare('SELECT object_key, upload_id, mode, status FROM upload_sessions WHERE content_id=?1').bind(contentId).all<any>()).results || [];
  await Promise.allSettled(sessions
    .filter((session) => session.mode === 'multipart' && session.upload_id && !['completed', 'cancelled', 'expired'].includes(session.status))
    .map((session) => env.BUCKET.resumeMultipartUpload(session.object_key, session.upload_id).abort()));
  for (const row of results || []) await env.BUCKET.delete(row.object_key);
  await env.DB.prepare('DELETE FROM upload_parts WHERE session_id IN (SELECT id FROM upload_sessions WHERE content_id=?1)').bind(contentId).run();
  await env.DB.prepare('DELETE FROM upload_sessions WHERE content_id=?1').bind(contentId).run();
  await env.DB.prepare('DELETE FROM attachments WHERE content_id = ?').bind(contentId).run();
  await env.DB.prepare('DELETE FROM content_notes WHERE content_id = ?').bind(contentId).run();
  await env.DB.prepare('DELETE FROM access_logs WHERE content_id = ?').bind(contentId).run();
  await env.DB.prepare('DELETE FROM contents WHERE id = ?').bind(contentId).run();
}

async function cleanupStaleUploadSessions(env: Env): Promise<number> {
  const cutoff = new Date(Date.now() - UPLOAD_INACTIVITY_MS).toISOString();
  const { results } = await env.DB.prepare(
    `SELECT * FROM upload_sessions WHERE status IN (${CLEANUP_SESSION_STATUSES}) AND COALESCE(last_activity_at, updated_at, created_at) < ?1 ORDER BY last_activity_at ASC LIMIT 100`
  ).bind(cutoff).all<UploadSessionRow>();
  let cleaned = 0;
  for (const session of results || []) {
    if (!isUploadSessionStale(session)) continue;
    if (session.mode === 'multipart' && session.upload_id) {
      await env.BUCKET.resumeMultipartUpload(session.object_key, session.upload_id).abort().catch(() => undefined);
    }
    await env.BUCKET.delete(session.object_key).catch(() => undefined);
    const timestamp = now();
    await env.DB.batch([
      env.DB.prepare('DELETE FROM upload_parts WHERE session_id=?1').bind(session.id),
      env.DB.prepare('UPDATE upload_sessions SET status="expired", updated_at=?1, last_activity_at=?1 WHERE id=?2 AND status IN (' + CLEANUP_SESSION_STATUSES + ')').bind(timestamp, session.id),
      env.DB.prepare('UPDATE attachments SET status="failed" WHERE id=?1 AND status != "active"').bind(session.attachment_id)
    ]);
    const state = await env.DB.prepare(
      'SELECT COUNT(*) total, SUM(status="completed") completed, SUM(status IN ("pending","uploading","completing")) incomplete FROM upload_sessions WHERE content_id=?1'
    ).bind(session.content_id).first<{ total: number; completed: number; incomplete: number }>();
    if (Number(state?.incomplete || 0) === 0) {
      if (Number(state?.completed || 0) === Number(state?.total || 0)) {
        await refreshContentUploadState(env, session.content_id);
      } else {
        await env.DB.prepare('UPDATE contents SET status="expired", forced_expired_at=?1, updated_at=?1 WHERE id=?2 AND status="processing"').bind(timestamp, session.content_id).run();
      }
    }
    cleaned += 1;
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

  if (path === '/api/me' && method === 'GET') {
    const user = await verifySso(req, env);
    return json({ ok: true, user });
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

  const uploadMatch = path.match(/^\/api\/(cli\/)?uploads\/([^/]+)(?:\/(status|part|complete|renew|heartbeat))?$/);
  if (uploadMatch) {
    const owner = uploadMatch[1] ? (await apiKeyAuth(env, req)).owner : (await verifySso(req, env)).username;
    const session = await ownedUploadSession(env, uploadMatch[2], owner);
    const action = uploadMatch[3] || '';
    const uploadBase = uploadMatch[1] ? '/api/cli/uploads' : '/api/uploads';

    if ((action === '' || action === 'status') && method === 'GET') {
      const { results } = await env.DB.prepare('SELECT part_number, etag, size, completed_at FROM upload_parts WHERE session_id=?1 ORDER BY part_number ASC').bind(session.id).all();
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
      await env.DB.prepare('UPDATE upload_sessions SET status="uploading", completed_parts=?1, uploaded_bytes=?2, updated_at=?3, last_activity_at=?3 WHERE id=?4')
        .bind(completedParts, Number(state?.uploaded_bytes || 0), t, session.id)
        .run();
      if (completedParts === session.expected_parts) await env.UPLOAD_QUEUE.send({ type: 'complete-multipart', sessionId: session.id });
      return json({ ok: true, completed_parts: completedParts, expected_parts: session.expected_parts });
    }

    if (action === 'complete' && method === 'POST') {
      if (session.status === 'completed') {
        return json({ ok: true, queued: false, status_url: `${uploadBase}/${session.id}/status` });
      }
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
      return json({ ok: true, queued: true, status_url: `${uploadBase}/${session.id}/status` });
    }

    if (action === 'renew' && method === 'POST') {
      if (['completed', 'cancelled', 'failed', 'expired'].includes(session.status)) throw new HttpError(409, `Upload session is ${session.status}`);
      await touchUploadSession(env, session.id);
      const body = await readJson<{ part_numbers?: number[] }>(req);
      if (session.mode === 'single') return json({ ok: true, item: await directUploadPlan(env, session) });
      const completed = new Set(((await env.DB.prepare('SELECT part_number FROM upload_parts WHERE session_id=?1').bind(session.id).all<{ part_number: number }>()).results || []).map((part) => part.part_number));
      const requested = new Set(Array.isArray(body.part_numbers) ? body.part_numbers.map(Number) : []);
      const plan = await directUploadPlan(env, session);
      const parts = (plan.parts || []).filter((part: any) => !completed.has(part.part_number) && (!requested.size || requested.has(part.part_number)));
      return json({ ok: true, item: { ...plan, parts } });
    }

    if (!action && method === 'DELETE') {
      if (session.mode === 'multipart' && session.upload_id) {
        await env.BUCKET.resumeMultipartUpload(session.object_key, session.upload_id).abort().catch(() => undefined);
      }
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
      const password = typeof body.password === 'string' && body.password ? await hashWithSalt(body.password) : { hash: row.password_hash, salt: row.password_salt };
      await env.DB.prepare(
        'UPDATE contents SET title=?1, remark=?2, visibility=?3, expire_at=?4, max_views=?5, format=?6, text_content=?7, password_hash=?8, password_salt=?9, updated_at=?10 WHERE id=?11'
      )
        .bind(
          body.title?.trim() || row.title,
          nullableText(body.remark) ?? row.remark,
          ALLOWED_VISIBILITY.has(body.visibility) ? body.visibility : row.visibility,
          body.expire_at === undefined ? row.expire_at : nullableText(body.expire_at),
          body.max_views === undefined ? row.max_views : numberField(body.max_views),
          ALLOWED_FORMAT.has(body.format) ? body.format : row.format,
          body.text_content === undefined ? row.text_content : String(body.text_content),
          password.hash,
          password.salt,
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
    item.share_ticket = access.ticketAuthorized
      ? req.headers.get('x-share-ticket')
      : await issueMediaTicket(env.MEDIA_TICKET_SECRET, {
          attachmentId: contentTicketKey(row.id),
          actor: user?.username,
          adminPreview: access.adminPreview,
          policyVersion: row.updated_at,
          expiresInSeconds: MEDIA_TICKET_TTL_SECONDS
        });
    return json({ ok: true, item });
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
    const suppliedTicket = url.searchParams.get('media');
    const verifiedTicket = suppliedTicket ? await verifyMediaTicket(env.MEDIA_TICKET_SECRET, suppliedTicket, att.id) : null;
    const existingTicket = verifiedTicket?.policyVersion === row.updated_at ? verifiedTicket : null;
    if (existingTicket) {
      adminPreview = existingTicket.adminPreview;
      if (row.status === 'processing') throw new HttpError(409, 'Upload is still processing');
      if (row.status === 'deleted' && !adminPreview) throw new HttpError(410, 'Content was deleted');
      if (isExpiredIgnoringViews(row) && !adminPreview) throw new HttpError(410, 'Content expired');
    } else {
      await assertShareAccess(env, req, row, user, sharePassword(req), adminPreview);
    }
    const ticket = existingTicket ? suppliedTicket! : await issueMediaTicket(env.MEDIA_TICKET_SECRET, {
      attachmentId: att.id,
      actor: user?.username,
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
    return json({
      ok: true,
      item: {
        id: att.id,
        filename: att.filename,
        content_type: att.content_type || 'application/octet-stream',
        size: att.size,
        kind,
        preview_url: previewPath,
        download_url: downloadPath,
        office_embed_url: kind === 'office' && row.visibility === 'public' && !row.password_hash ? `https://view.officeapps.live.com/op/embed.aspx?src=${encodeURIComponent(absolutePreviewUrl)}` : null
      }
    });
  }

  const dlMatch = path.match(/^\/api\/attachments\/([^/]+)\/(download|preview)$/);
  if (dlMatch && (method === 'GET' || method === 'HEAD')) {
    const att = await env.DB.prepare('SELECT * FROM attachments WHERE id = ?').bind(dlMatch[1]).first<any>();
    if (!att) throw new HttpError(404, 'Attachment not found');
    const row = await env.DB.prepare('SELECT * FROM contents WHERE id = ?').bind(att.content_id).first<any>();
    if (!row) throw new HttpError(404, 'Content not found');
    const session = await env.DB.prepare('SELECT * FROM upload_sessions WHERE attachment_id = ?1').bind(att.id).first<UploadSessionRow>();
    if (att.status !== 'active' || (session && session.status !== 'completed')) throw new HttpError(409, 'Attachment has not passed upload validation');
    const ticketValue = url.searchParams.get('media') || '';
    const verifiedTicket = ticketValue ? await verifyMediaTicket(env.MEDIA_TICKET_SECRET, ticketValue, att.id) : null;
    const ticket = verifiedTicket?.policyVersion === row.updated_at ? verifiedTicket : null;
    let user: User | null = null;
    let adminPreview = false;
    let actor: string | undefined;
    if (ticket) {
      adminPreview = ticket.adminPreview;
      actor = ticket.actor;
      if (row.status === 'processing') throw new HttpError(409, 'Upload is still processing');
      if (row.status === 'deleted' && !adminPreview) throw new HttpError(410, 'Content was deleted');
      if (isExpiredIgnoringViews(row) && !adminPreview) throw new HttpError(410, 'Content expired');
    } else {
      user = await optionalUser(req, env);
      adminPreview = url.searchParams.get('admin_preview') === '1' && user?.role === 'admin';
      await assertShareAccess(env, req, row, user, sharePassword(req), adminPreview);
      actor = user?.username;
    }
    const mode = dlMatch[2];
    if (mode === 'download' && method === 'GET') {
      let directUrl: string | null = null;
      if (att.completed_at) {
        const object = await env.BUCKET.head(att.object_key);
        const validObject = object && object.size === Number(att.size) && (!normalizeEtag(att.etag) || normalizeEtag(object.httpEtag) === normalizeEtag(att.etag));
        if (!validObject) {
          await env.BUCKET.delete(att.object_key).catch(() => undefined);
          if (session) await rejectUploadedObject(env, session);
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
    const { results } = await env.DB.prepare(
      'SELECT id, remark, key_prefix, key_suffix, status, expire_at, last_used_at, usage_count, created_at FROM api_keys WHERE owner_username = ? ORDER BY created_at DESC'
    )
      .bind(user.username)
      .all();
    return json({ ok: true, items: results || [] });
  }
  if (path === '/api/api-keys' && method === 'POST') {
    return createApiKey(env, await verifySso(req, env), await readJson(req));
  }
  const keyMatch = path.match(/^\/api\/api-keys\/([^/]+)\/(rotate|revoke)$/);
  if (keyMatch && method === 'POST') {
    const user = await verifySso(req, env);
    const row = await env.DB.prepare('SELECT * FROM api_keys WHERE id = ? AND owner_username = ?').bind(keyMatch[1], user.username).first<any>();
    if (!row) throw new HttpError(404, 'API Key not found');
    await env.DB.prepare('UPDATE api_keys SET status="revoked", revoked_at=?1 WHERE id=?2').bind(now(), row.id).run();
    if (keyMatch[2] === 'rotate') return createApiKey(env, user, { remark: `${row.remark || 'rotated key'} (rotated)`, expire_at: row.expire_at });
    return json({ ok: true });
  }

  if (path === '/api/settings/cli' && method === 'GET') {
    const user = await verifySso(req, env);
    const item = await env.DB.prepare('SELECT * FROM user_cli_settings WHERE username = ?').bind(user.username).first();
    return json({ ok: true, item });
  }
  if (path === '/api/settings/cli' && method === 'PATCH') {
    const user = await verifySso(req, env);
    const body = await readJson<any>(req);
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
      await env.DB.prepare('UPDATE contents SET visibility=COALESCE(?1, visibility), expire_at=?2, max_views=COALESCE(?3, max_views), updated_at=?4 WHERE id=?5')
        .bind(ALLOWED_VISIBILITY.has(body.visibility) ? body.visibility : null, body.expire_at === undefined ? null : nullableText(body.expire_at), body.max_views === undefined ? null : numberField(body.max_views), now(), contentId)
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
      'SELECT u.username, u.role, COUNT(c.id) total_count, SUM(c.type="text") text_count, SUM(c.type="file") file_count, SUM(c.type="mixed") mixed_count, SUM(c.visibility="public") public_count, SUM(c.visibility="internal") internal_count, SUM(c.visibility="private") private_count, SUM(c.status="expired") expired_count, SUM(c.status="deleted") deleted_count, COALESCE(SUM(c.file_size),0) total_file_size, COALESCE(SUM(c.view_count),0) total_views, MAX(c.created_at) last_publish_at FROM users u LEFT JOIN contents c ON c.owner_username = u.username GROUP BY u.username, u.role ORDER BY total_count DESC'
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
    const { results } = await env.DB.prepare('SELECT id, owner_username, remark, key_prefix, key_suffix, status, expire_at, last_used_at, usage_count, created_at FROM api_keys ORDER BY created_at DESC LIMIT 300').all();
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
      if (err instanceof HttpError) return json({ ok: false, message: err.message }, err.status);
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
            await env.DB.prepare('UPDATE contents SET status="active", updated_at=?1 WHERE id=?2 AND status="processing"')
              .bind(now(), body.contentId)
              .run();
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
        if (msg.attempts >= QUEUE_MAX_ATTEMPTS) await markQueueMessageFailed(env, msg.body, error);
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
