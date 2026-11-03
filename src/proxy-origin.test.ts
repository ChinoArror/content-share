import { describe, expect, it } from 'vitest';
import { signedContentOrigin } from './proxy-origin';

const secret = 'content-origin-test-only';

async function signedRequest(path = '/api/share/abc', now = Math.floor(Date.now() / 1000)): Promise<Request> {
  const key = await crypto.subtle.importKey('raw', new TextEncoder().encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  const bytes = new Uint8Array(await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(`v1\ncontent.aryuki.cn\nGET\n${path}\n${now}`)));
  const signature = Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('');
  return new Request(`https://content.aryuki.com${path}`, { headers: {
    'X-Forwarded-Host': 'content.aryuki.cn',
    'X-Forwarded-Proto': 'https',
    'X-ESA-Origin-Timestamp': String(now),
    'X-ESA-Origin-Signature': signature,
  } });
}

describe('signed content public origin', () => {
  it('accepts a fresh proxy signature for the exact public hostname and path', async () => {
    expect(await signedContentOrigin(await signedRequest('/api/share/abc?q=1'), secret)).toBe('https://content.aryuki.cn');
  });

  it('rejects missing, stale, and tampered origin proof', async () => {
    expect(await signedContentOrigin(await signedRequest(), undefined)).toBeNull();
    expect(await signedContentOrigin(await signedRequest('/api/share/abc', Math.floor(Date.now() / 1000) - 600), secret)).toBeNull();
    const request = await signedRequest();
    expect(await signedContentOrigin(new Request('https://content.aryuki.com/api/share/other', request), secret)).toBeNull();
    expect(await signedContentOrigin(new Request('https://content.aryuki.com/api/share/abc', { headers: { 'X-Forwarded-Host': 'content.aryuki.cn' } }), secret)).toBeNull();
  });
});
