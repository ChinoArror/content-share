import { describe, expect, it } from 'vitest';
import worker from './worker';

const path = '/api/public/pdf-embed-config';
const secret = 'test-only-content-origin-secret';

async function signedCnRequest(timestamp = Math.floor(Date.now() / 1000)): Promise<Request> {
  const key = await crypto.subtle.importKey('raw', new TextEncoder().encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  const message = `v1\ncontent.aryuki.cn\nGET\n${path}\n${timestamp}`;
  const bytes = new Uint8Array(await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(message)));
  const signature = Array.from(bytes, (byte) => byte.toString(16).padStart(2, '0')).join('');
  return new Request(`https://content.aryuki.com${path}`, { headers: {
    'X-Forwarded-Host': 'content.aryuki.cn',
    'X-Forwarded-Proto': 'https',
    'X-ESA-Origin-Timestamp': String(timestamp),
    'X-ESA-Origin-Signature': signature,
  } });
}

async function config(request: Request, cnId?: string): Promise<{ clientId: string | null; cacheControl: string | null }> {
  const response = await worker.fetch(request, {
    ADOBE_PDF_CLIENT_ID: '{com-client-id}',
    ADOBE_PDF_CLIENT_ID_CN: cnId,
    CONTENT_PROXY_ORIGIN_SECRET: secret,
  } as never, {} as never);
  expect(response.status).toBe(200);
  const body = await response.json() as { client_id: string | null };
  return { clientId: body.client_id, cacheControl: response.headers.get('cache-control') };
}

describe('Adobe PDF Embed client ID selection', () => {
  it('keeps the .com ID for a direct request', async () => {
    expect(await config(new Request(`https://content.aryuki.com${path}`), '{cn-client-id}'))
      .toEqual({ clientId: 'com-client-id', cacheControl: 'private, no-store' });
  });

  it('uses the .cn ID only for a fresh signed proxy request', async () => {
    expect(await config(await signedCnRequest(), ' {cn-client-id} '))
      .toEqual({ clientId: 'cn-client-id', cacheControl: 'private, no-store' });
  });

  it('does not let a forged or stale forwarded host select the .cn ID', async () => {
    const forged = new Request(`https://content.aryuki.com${path}`, { headers: { 'X-Forwarded-Host': 'content.aryuki.cn' } });
    expect((await config(forged, 'cn-client-id')).clientId).toBe('com-client-id');
    expect((await config(await signedCnRequest(Math.floor(Date.now() / 1000) - 600), 'cn-client-id')).clientId).toBe('com-client-id');
  });

  it('returns no ID on .cn when its own ID is absent, enabling PDF.js fallback', async () => {
    expect((await config(await signedCnRequest())).clientId).toBeNull();
  });
});
