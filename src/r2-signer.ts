import { AwsClient } from 'aws4fetch';

type R2SigningInput = {
  accountId: string;
  bucket: string;
  key: string;
  method: 'GET' | 'PUT' | 'HEAD' | 'DELETE';
  expiresIn: number;
  accessKeyId: string;
  secretAccessKey: string;
  headers?: HeadersInit;
  query?: Record<string, string | number>;
};

export function buildR2ObjectUrl(accountId: string, bucket: string, key: string): string {
  const encodedKey = key.split('/').map(encodeURIComponent).join('/');
  return `https://${accountId}.r2.cloudflarestorage.com/${encodeURIComponent(bucket)}/${encodedKey}`;
}

export async function presignR2Request(input: R2SigningInput): Promise<{ url: string; headers: Record<string, string> }> {
  if (!/^[A-Za-z0-9]{32}$/.test(input.accessKeyId)) {
    throw new Error('R2 Access Key ID must be exactly 32 alphanumeric characters');
  }
  if (!Number.isInteger(input.expiresIn) || input.expiresIn < 1 || input.expiresIn > 3600) {
    throw new Error('Signature TTL must be between 1 and 3600 seconds');
  }

  const url = new URL(buildR2ObjectUrl(input.accountId, input.bucket, input.key));
  url.searchParams.set('X-Amz-Expires', String(input.expiresIn));
  for (const [key, value] of Object.entries(input.query || {})) url.searchParams.set(key, String(value));

  const headers = new Headers(input.headers);
  const client = new AwsClient({
    accessKeyId: input.accessKeyId,
    secretAccessKey: input.secretAccessKey,
    service: 's3',
    region: 'auto'
  });
  const signed = await client.sign(new Request(url, { method: input.method, headers }), { aws: { signQuery: true } });

  return {
    url: signed.url,
    headers: Object.fromEntries(headers.entries())
  };
}
