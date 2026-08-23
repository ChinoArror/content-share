import { describe, expect, it } from 'vitest';
import { buildSsoLoginUrl, currentReturnTo, safeReturnTo } from './sso-redirect';

describe('SSO return paths', () => {
  it('preserves the current same-origin pathname, query, and hash', () => {
    expect(currentReturnTo({ pathname: '/s/abc', search: '?file=1', hash: '#comments' })).toBe('/s/abc?file=1#comments');
  });

  it('normalizes valid return paths while rejecting external URLs', () => {
    expect(safeReturnTo('/s/abc?file=1#comments', 'https://content.example.test')).toBe('/s/abc?file=1#comments');
    expect(safeReturnTo('https://content.example.test/s/abc?file=1', 'https://content.example.test')).toBe('/s/abc?file=1');
    expect(safeReturnTo('https://evil.example/s/abc', 'https://content.example.test')).toBe('/');
    expect(safeReturnTo('//evil.example/s/abc', 'https://content.example.test')).toBe('/');
  });

  it('rejects return paths that carry an auth token', () => {
    expect(safeReturnTo('/s/abc?token=secret', 'https://content.example.test')).toBe('/');
  });

  it('builds the auth-center login URL with the current same-origin return path', () => {
    const loginUrl = new URL(buildSsoLoginUrl(
      'https://accounts.example.test/',
      'content-share',
      'https://content.example.test',
      { pathname: '/s/abc', search: '?file=1', hash: '#comments' },
    ));
    const callback = new URL(loginUrl.searchParams.get('redirect') || '');

    expect(loginUrl.origin).toBe('https://accounts.example.test');
    expect(loginUrl.searchParams.get('client_id')).toBe('content-share');
    expect(callback.origin).toBe('https://content.example.test');
    expect(callback.pathname).toBe('/sso-callback');
    expect(callback.searchParams.get('return_to')).toBe('/s/abc?file=1#comments');
  });
});
