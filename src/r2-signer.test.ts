import { describe, expect, it } from 'vitest';
import { buildR2ObjectUrl, presignR2Request } from './r2-signer';

describe('buildR2ObjectUrl', () => {
  it('encodes every object-key segment without changing hierarchy', () => {
    expect(buildR2ObjectUrl('abc123', 'bucket-name', 'attachments/alice/a b/文件.pdf')).toBe(
      'https://abc123.r2.cloudflarestorage.com/bucket-name/attachments/alice/a%20b/%E6%96%87%E4%BB%B6.pdf'
    );
  });
});

describe('presignR2Request', () => {
  it('rejects an R2 access key id that is not exactly 32 characters', async () => {
    await expect(presignR2Request({
      accountId: 'abc123',
      bucket: 'bucket-name',
      key: 'attachments/alice/file.mp4',
      method: 'PUT',
      expiresIn: 60,
      accessKeyId: 'x'.repeat(36),
      secretAccessKey: 'test-secret-key'
    })).rejects.toThrow('R2 Access Key ID must be exactly 32 alphanumeric characters');
  });

  it('creates a bounded SigV4 URL without exposing the secret', async () => {
    const signed = await presignR2Request({
      accountId: 'abc123',
      bucket: 'bucket-name',
      key: 'attachments/alice/file.mp4',
      method: 'GET',
      expiresIn: 60,
      accessKeyId: 'a'.repeat(32),
      secretAccessKey: 'test-secret-key'
    });

    const url = new URL(signed.url);
    expect(url.searchParams.get('X-Amz-Expires')).toBe('60');
    expect(url.searchParams.get('X-Amz-Algorithm')).toBe('AWS4-HMAC-SHA256');
    expect(signed.url).not.toContain('test-secret-key');
  });

  it('rejects signatures outside the app TTL boundary', async () => {
    await expect(presignR2Request({
      accountId: 'abc123',
      bucket: 'bucket-name',
      key: 'attachments/alice/file.mp4',
      method: 'PUT',
      expiresIn: 3601,
      accessKeyId: 'a'.repeat(32),
      secretAccessKey: 'test-secret-key'
    })).rejects.toThrow('Signature TTL must be between 1 and 3600 seconds');
  });
});
