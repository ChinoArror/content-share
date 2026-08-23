import { describe, expect, it } from 'vitest';
import { classifyShareAccessError } from './share-access';

describe('share access error presentation', () => {
  it('separates login-required internal shares from permission-denied shares', () => {
    expect(classifyShareAccessError('LOGIN_REQUIRED', 'Login required')).toBe('login');
    expect(classifyShareAccessError('INTERNAL_ACCESS_PERMISSION_REQUIRED', 'Internal access permission required')).toBe('permission');
  });

  it('keeps password failures in the current-document password flow', () => {
    expect(classifyShareAccessError('PASSWORD_REQUIRED_OR_INCORRECT', 'Password required or incorrect')).toBe('password');
    expect(classifyShareAccessError(undefined, '密码错误，请重试')).toBe('password');
  });

  it('falls back to a generic access state for unknown errors', () => {
    expect(classifyShareAccessError('CONTENT_EXPIRED', 'Content expired')).toBe('generic');
  });
});
