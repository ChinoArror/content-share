import { describe, expect, it } from 'vitest';
import { buildUploadFingerprint, isUploadSessionReusable, isUploadSessionStale, sha256Hex } from './upload-resume';

const NOW = Date.parse('2026-08-21T00:00:00.000Z');
const baseSession = {
  status: 'uploading',
  file_fingerprint: 'fingerprint-a',
  size: 80 * 1024 * 1024,
  last_activity_at: new Date(NOW - 29 * 60 * 1000).toISOString(),
  updated_at: new Date(NOW - 2 * 60 * 60 * 1000).toISOString(),
  created_at: new Date(NOW - 2 * 60 * 60 * 1000).toISOString()
};

describe('upload resume identity', () => {
  it('calculates the standard SHA-256 digest', async () => {
    expect(await sha256Hex(new TextEncoder().encode('abc'))).toBe(
      'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad'
    );
  });

  it('changes the fingerprint when sampled file content changes', async () => {
    const input = {
      name: 'recording.wav',
      size: 80 * 1024 * 1024,
      type: 'audio/wav',
      lastModified: 1774310400000,
      head: new TextEncoder().encode('head-a'),
      tail: new TextEncoder().encode('tail-a')
    };
    const same = await buildUploadFingerprint(input);
    const changed = await buildUploadFingerprint({ ...input, tail: new TextEncoder().encode('tail-b') });
    expect(await buildUploadFingerprint(input)).toBe(same);
    expect(changed).not.toBe(same);
  });

  it('reuses only an active matching session within the inactivity window', () => {
    expect(isUploadSessionReusable(baseSession, 'fingerprint-a', NOW)).toBe(true);
    expect(isUploadSessionReusable(baseSession, 'fingerprint-b', NOW)).toBe(false);
    expect(isUploadSessionReusable({ ...baseSession, status: 'completed' }, 'fingerprint-a', NOW)).toBe(false);
    expect(isUploadSessionReusable({ ...baseSession, last_activity_at: new Date(NOW - 30 * 60 * 1000 - 1).toISOString() }, 'fingerprint-a', NOW)).toBe(false);
  });

  it('uses last activity instead of creation time for stale cleanup', () => {
    expect(isUploadSessionStale(baseSession, NOW)).toBe(false);
    expect(isUploadSessionStale({ ...baseSession, last_activity_at: new Date(NOW - 31 * 60 * 1000).toISOString() }, NOW)).toBe(true);
    expect(isUploadSessionStale({ ...baseSession, status: 'completed', last_activity_at: new Date(NOW - 31 * 60 * 1000).toISOString() }, NOW)).toBe(false);
  });
});
