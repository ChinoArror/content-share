export const PERMISSION_KEYS = [
  'can_public_publish',
  'can_api',
  'can_internal_access',
  'can_upload',
  'can_comment',
] as const;

export type PermissionKey = typeof PERMISSION_KEYS[number];
export type PermissionSet = Record<PermissionKey, boolean>;

export interface PermissionGroupRecord {
  id: string;
  name: string;
  is_system: boolean;
  is_default: boolean;
  can_public_publish: boolean;
  can_api: boolean;
  can_internal_access: boolean;
  can_upload: boolean;
  quota_bytes: number;
  can_comment: boolean;
  created_at: string;
  updated_at: string;
}

export interface UserAccessProfile {
  username: string;
  role: string;
  groupName: string;
  permissions: PermissionSet;
  quota_bytes: number;
  used_bytes: number;
  reserved_bytes: number;
}

export type Visibility = 'public' | 'internal' | 'private';

export class PolicyError extends Error {
  readonly code: string;
  readonly status: number;
  readonly details: Record<string, number>;

  constructor(code: string, status: number, details: Record<string, number> = {}) {
    super(code);
    this.name = 'PolicyError';
    this.code = code;
    this.status = status;
    this.details = details;
  }
}

export function canEnterAdminDashboard(user: { role: string; groupName?: string }): boolean {
  return user.role === 'admin';
}

export function canUseVisibility(profile: UserAccessProfile, visibility: Visibility): boolean {
  if (visibility === 'public') return profile.permissions.can_public_publish;
  if (visibility === 'internal') return profile.permissions.can_internal_access;
  return true;
}

export function assertUploadAllowance(profile: UserAccessProfile, requestedBytes: number): void {
  if (!Number.isFinite(requestedBytes) || requestedBytes < 0) {
    throw new PolicyError('STORAGE_QUOTA_EXCEEDED', 413, { requested_bytes: requestedBytes });
  }
  if (!profile.permissions.can_upload || profile.quota_bytes <= 0) {
    throw new PolicyError('STORAGE_PERMISSION_REQUIRED', 403);
  }
  if (profile.used_bytes + profile.reserved_bytes + requestedBytes > profile.quota_bytes) {
    throw new PolicyError('STORAGE_QUOTA_EXCEEDED', 413, {
      requested_bytes: requestedBytes,
      used_bytes: profile.used_bytes,
      reserved_bytes: profile.reserved_bytes,
      quota_bytes: profile.quota_bytes,
    });
  }
}

export function middleEllipsis(value: string, head: number, tail: number): string {
  if (head < 0 || tail < 0) throw new RangeError('head and tail must be non-negative');
  if (value.length <= head + tail) return value;
  const suffix = tail === 0 ? '' : value.slice(-(tail + 1));
  return `${value.slice(0, head)}…${suffix}`;
}
