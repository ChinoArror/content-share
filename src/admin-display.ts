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
