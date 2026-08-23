export function middleEllipsis(value: string, maxLength = 32): string {
  const text = String(value ?? '');
  if (maxLength < 3 || text.length <= maxLength) return text;
  const headLength = Math.max(1, Math.ceil((maxLength - 1) / 2));
  const tailLength = Math.max(1, maxLength - 1 - headLength);
  return `${text.slice(0, headLength)}…${text.slice(-tailLength)}`;
}

export function compactAuditValue(value: unknown, maxLength = 32): string {
  if (value === null || value === undefined || value === '') return '-';
  return middleEllipsis(String(value), maxLength);
}

export const permissionKeys = [
  'can_public_publish',
  'can_api',
  'can_internal_access',
  'can_upload',
  'can_comment',
] as const;

export type AdminPermissionKey = typeof permissionKeys[number];

const adminFieldLabelKeys: Record<string, string> = {
  slug: 'admin.slug',
  key_prefix: 'keys.key',
  mixed_count: 'admin.mixed',
  public_count: 'visibility.public',
  internal_count: 'visibility.internal',
  private_count: 'visibility.private',
};

export function adminFieldLabelKey(key: string): string | null {
  return adminFieldLabelKeys[key] || null;
}

const adminStatusValues = new Set(['active', 'expired', 'revoked', 'processing', 'deleted']);
const adminRoleValues = new Set(['admin', 'user']);
const adminVisibilityValues = new Set(['public', 'internal', 'private']);
const adminActionValues = new Set(['view', 'preview', 'download', 'denied']);

export function adminEnumMessageKey(field: string, value: unknown): string | null {
  const normalized = String(value ?? '').trim().toLowerCase();
  if (!normalized) return null;
  if (field === 'status' && adminStatusValues.has(normalized)) return `admin.status.${normalized}`;
  if (field === 'role' && adminRoleValues.has(normalized)) return `admin.role.${normalized}`;
  if (field === 'visibility' && adminVisibilityValues.has(normalized)) return `visibility.${normalized}`;
  if (field === 'action' && adminActionValues.has(normalized)) return `admin.action.${normalized}`;
  if (field === 'type') {
    if (normalized === 'text') return 'admin.text';
    if (normalized === 'file') return 'admin.file';
    if (normalized === 'mixed') return 'admin.mixed';
  }
  return null;
}

export type AdminVisibility = 'public' | 'internal' | 'private';
const allVisibilityOptions: AdminVisibility[] = ['public', 'internal', 'private'];

export function allowedVisibilityOptions(canPublic?: boolean): AdminVisibility[] {
  return canPublic === false ? ['internal', 'private'] : allVisibilityOptions;
}

export function normalizeVisibility(value: unknown, canPublic?: boolean): AdminVisibility {
  const options = allowedVisibilityOptions(canPublic);
  return options.includes(value as AdminVisibility) ? value as AdminVisibility : options[options.length - 1];
}

export function withAllowedVisibility<T extends Record<string, unknown>>(payload: T, canPublic?: boolean): T & { visibility: AdminVisibility } {
  return { ...payload, visibility: normalizeVisibility(payload.visibility, canPublic) };
}

const GIB = 1024 ** 3;

export function quotaGiBToBytes(value: unknown): number | null {
  const text = String(value ?? '').trim();
  if (!text) return null;
  const gib = Number(text);
  if (!Number.isFinite(gib) || gib < 0) return null;
  const bytes = Math.floor(gib * GIB);
  return Number.isSafeInteger(bytes) ? bytes : null;
}

export type AdminKeyAction = 'rotate' | 'lock' | 'unlock' | 'revoke';

export function adminKeyActions(locked: boolean): AdminKeyAction[] {
  return locked ? ['rotate', 'unlock', 'revoke'] : ['rotate', 'lock', 'revoke'];
}

export function visibilitySegmentMetrics(optionCount: number, selectedIndex: number): { count: number; index: number } {
  const count = Math.max(1, Math.floor(optionCount));
  return { count, index: Math.min(Math.max(0, Math.floor(selectedIndex)), count - 1) };
}

export function auditNullLabel(key: string, language: 'zh-CN' | 'en-US' = 'zh-CN'): string {
  if (key === 'last_used_at') return language === 'en-US' ? 'Never used' : '从未使用';
  if (key === 'locked_at') return language === 'en-US' ? 'Not locked' : '未锁定';
  return language === 'en-US' ? 'Permanent' : '永久';
}

export function mergeKeyFingerprint(prefix?: string | null, suffix?: string | null): string {
  const left = String(prefix || '').trim();
  const right = String(suffix || '').trim();
  return left || right ? `${left || '-'}...${right}` : '-';
}
