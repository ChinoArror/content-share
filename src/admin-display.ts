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
