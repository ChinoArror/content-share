export type MediaTicketPayload = {
  attachmentId: string;
  expiresAt: number;
  actor?: string;
  adminPreview: boolean;
  policyVersion?: string;
};

type IssueMediaTicketInput = {
  attachmentId: string;
  actor?: string;
  adminPreview?: boolean;
  policyVersion?: string;
  nowSeconds?: number;
  expiresInSeconds?: number;
};

function base64UrlEncode(bytes: Uint8Array): string {
  let binary = '';
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replaceAll('+', '-').replaceAll('/', '_').replace(/=+$/g, '');
}

function base64UrlDecode(value: string): Uint8Array {
  const normalized = value.replaceAll('-', '+').replaceAll('_', '/');
  const padded = normalized.padEnd(Math.ceil(normalized.length / 4) * 4, '=');
  const binary = atob(padded);
  return Uint8Array.from(binary, (character) => character.charCodeAt(0));
}

async function hmac(secret: string, value: string): Promise<Uint8Array> {
  const encoder = new TextEncoder();
  const key = await crypto.subtle.importKey('raw', encoder.encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  return new Uint8Array(await crypto.subtle.sign('HMAC', key, encoder.encode(`content-share-media-v1.${value}`)));
}

export async function issueMediaTicket(secret: string, input: IssueMediaTicketInput): Promise<string> {
  if (!secret) throw new Error('Media ticket secret is missing');
  const nowSeconds = input.nowSeconds ?? Math.floor(Date.now() / 1000);
  const expiresInSeconds = Math.min(Math.max(input.expiresInSeconds ?? 600, 30), 900);
  const payload: MediaTicketPayload = {
    attachmentId: input.attachmentId,
    expiresAt: nowSeconds + expiresInSeconds,
    actor: input.actor || undefined,
    adminPreview: input.adminPreview === true,
    policyVersion: input.policyVersion || undefined
  };
  const encodedPayload = base64UrlEncode(new TextEncoder().encode(JSON.stringify(payload)));
  const signature = base64UrlEncode(await hmac(secret, encodedPayload));
  return `${encodedPayload}.${signature}`;
}

export async function verifyMediaTicket(
  secret: string,
  ticket: string,
  attachmentId: string,
  nowSeconds = Math.floor(Date.now() / 1000)
): Promise<MediaTicketPayload | null> {
  try {
    const [encodedPayload, encodedSignature, extra] = ticket.split('.');
    if (!secret || !encodedPayload || !encodedSignature || extra) return null;
    const suppliedSignature = base64UrlDecode(encodedSignature);
    const expectedSignature = await hmac(secret, encodedPayload);
    if (suppliedSignature.byteLength !== expectedSignature.byteLength) return null;
    let mismatch = 0;
    for (let index = 0; index < expectedSignature.byteLength; index += 1) mismatch |= suppliedSignature[index] ^ expectedSignature[index];
    if (mismatch !== 0) return null;
    const payload = JSON.parse(new TextDecoder().decode(base64UrlDecode(encodedPayload))) as Partial<MediaTicketPayload>;
    if (payload.attachmentId !== attachmentId || !Number.isSafeInteger(payload.expiresAt) || payload.expiresAt! < nowSeconds) return null;
    return {
      attachmentId: payload.attachmentId,
      expiresAt: payload.expiresAt!,
      actor: typeof payload.actor === 'string' ? payload.actor : undefined,
      adminPreview: payload.adminPreview === true,
      policyVersion: typeof payload.policyVersion === 'string' ? payload.policyVersion : undefined
    };
  } catch {
    return null;
  }
}
