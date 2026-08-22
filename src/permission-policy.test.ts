import { describe, expect, it } from 'vitest';
import {
  assertUploadAllowance,
  canEnterAdminDashboard,
  canUseVisibility,
  middleEllipsis,
  PolicyError,
  type UserAccessProfile,
} from './permission-policy';

function profile(overrides: Partial<UserAccessProfile> = {}): UserAccessProfile {
  return {
    username: 'alice',
    role: 'user',
    groupName: 'user',
    permissions: {
      can_public_publish: true,
      can_api: true,
      can_internal_access: true,
      can_upload: true,
      can_comment: true,
    },
    quota_bytes: 100,
    used_bytes: 0,
    reserved_bytes: 0,
    ...overrides,
  };
}

describe('permission policy', () => {
  it('does not let a business group grant dashboard access', () => {
    expect(canEnterAdminDashboard({ role: 'user', groupName: 'admin' })).toBe(false);
    expect(canEnterAdminDashboard({ role: 'admin', groupName: 'user' })).toBe(true);
  });

  it('rejects quota exhaustion with stable accounting', () => {
    expect(() => assertUploadAllowance(profile({
      permissions: { ...profile().permissions, can_upload: true },
      quota_bytes: 100,
      used_bytes: 70,
      reserved_bytes: 20,
    }), 11)).toThrowError(expect.objectContaining({ code: 'STORAGE_QUOTA_EXCEEDED' }));
  });

  it('uses middle ellipsis for long audit values', () => {
    expect(middleEllipsis('2409:8970:b56:15c4:2c32:982e:798f:9ad7', 10, 8)).toBe('2409:8970:…798f:9ad7');
  });

  it('uses the matching permission for public and internal visibility', () => {
    const restricted = profile({
      permissions: {
        can_public_publish: false,
        can_api: true,
        can_internal_access: true,
        can_upload: true,
        can_comment: false,
      },
    });
    expect(canUseVisibility(restricted, 'public')).toBe(false);
    expect(canUseVisibility(restricted, 'internal')).toBe(true);
    expect(canUseVisibility(restricted, 'private')).toBe(true);
  });

  it('rejects uploads without storage permission', () => {
    expect(() => assertUploadAllowance(profile({
      permissions: { ...profile().permissions, can_upload: false },
    }), 1)).toThrowError(new PolicyError('STORAGE_PERMISSION_REQUIRED', 403));
  });
});
