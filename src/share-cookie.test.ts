import { describe, expect, it } from 'vitest';
import { parseCookie, serializeSharePasswordCookie, sharePasswordCookieName } from './share-cookie';

describe('share password cookies', () => {
  it('scopes each cookie name to the share slug and parses it from a cookie header', () => {
    const name = sharePasswordCookieName('my-share');

    expect(name).toBe('share_access_my-share');
    expect(parseCookie(`${name}=signed-token; theme=dark`, name)).toBe('signed-token');
  });

  it('serializes a secure browser cookie for a 30 minute password session', () => {
    const cookie = serializeSharePasswordCookie('share_access_my-share', 'signed-token', 1800);

    expect(cookie).toBe('share_access_my-share=signed-token; Max-Age=1800; Path=/; HttpOnly; Secure; SameSite=Lax');
  });
});
