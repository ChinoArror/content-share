const PUBLIC_HOST = 'content.aryuki.cn';

export async function signedContentOrigin(request: Request, secret?: string): Promise<string | null> {
  if (!secret || request.headers.get('X-Forwarded-Host') !== PUBLIC_HOST || request.headers.get('X-Forwarded-Proto') !== 'https') return null;
  const timestamp = request.headers.get('X-ESA-Origin-Timestamp');
  const signature = request.headers.get('X-ESA-Origin-Signature');
  if (!timestamp || !/^\d{10}$/.test(timestamp) || !signature || !/^[a-f0-9]{64}$/.test(signature)) return null;
  if (Math.abs(Math.floor(Date.now() / 1000) - Number(timestamp)) > 300) return null;
  const url = new URL(request.url);
  const message = `v1\n${PUBLIC_HOST}\n${request.method.toUpperCase()}\n${url.pathname}${url.search}\n${timestamp}`;
  const key = await crypto.subtle.importKey('raw', new TextEncoder().encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  const expected = new Uint8Array(await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(message)));
  const actual = new Uint8Array(signature.match(/.{2}/g)!.map((pair) => parseInt(pair, 16)));
  let difference = 0;
  for (let i = 0; i < expected.length; i++) difference |= expected[i] ^ actual[i];
  return difference === 0 ? `https://${PUBLIC_HOST}` : null;
}
