import { describe, expect, it } from 'vitest';
import {
  buildPartPlan,
  chooseUploadMode,
  finalizedObjectKey,
  isContentReadyForActivation,
  normalizeUploadFilename,
  parseByteRange,
  safeObjectKey,
  safeStagingObjectKey
} from './transfer-policy';

const MiB = 1024 * 1024;

describe('chooseUploadMode', () => {
  it('uses a single upload through 16 MiB', () => {
    expect(chooseUploadMode(16 * MiB)).toBe('single');
  });

  it('uses multipart above 16 MiB', () => {
    expect(chooseUploadMode(16 * MiB + 1)).toBe('multipart');
  });
});

describe('buildPartPlan', () => {
  it('creates uniform 8 MiB parts and a smaller final part', () => {
    expect(buildPartPlan(20 * MiB)).toEqual([
      { partNumber: 1, start: 0, end: 8 * MiB, size: 8 * MiB },
      { partNumber: 2, start: 8 * MiB, end: 16 * MiB, size: 8 * MiB },
      { partNumber: 3, start: 16 * MiB, end: 20 * MiB, size: 4 * MiB }
    ]);
  });

  it('rejects empty and oversized files', () => {
    expect(() => buildPartPlan(0)).toThrow('File size must be positive');
    expect(() => buildPartPlan(101 * MiB)).toThrow('File exceeds 100 MiB');
  });
});

describe('parseByteRange', () => {
  it('parses open, closed, and suffix ranges', () => {
    expect(parseByteRange('bytes=10-19', 100)).toEqual({ offset: 10, length: 10 });
    expect(parseByteRange('bytes=90-', 100)).toEqual({ offset: 90, length: 10 });
    expect(parseByteRange('bytes=-12', 100)).toEqual({ offset: 88, length: 12 });
  });

  it('rejects invalid or multiple ranges', () => {
    expect(parseByteRange('bytes=100-110', 100)).toBeNull();
    expect(parseByteRange('bytes=0-1,4-5', 100)).toBeNull();
    expect(parseByteRange('items=0-1', 100)).toBeNull();
  });
});

describe('object key safety', () => {
  it('normalizes display names without allowing path control', () => {
    expect(normalizeUploadFilename('../a\r\n\\b.mp4')).toBe('.._a__b.mp4');
    const key = safeObjectKey('alice/../../admin', 'cnt/1', 'att/2');
    expect(key).toMatch(/^attachments\/[a-z0-9_-]+\/[a-z0-9_-]+\/[a-z0-9_-]+$/);
    expect(key).not.toContain('..');
    expect(finalizedObjectKey(key)).toBe(`${key}/final`);
    const stagingKey = safeStagingObjectKey('alice/../../admin', 'cnt/1', 'att/2');
    expect(stagingKey).toMatch(/^upload-staging\/[a-z0-9_-]+\/[a-z0-9_-]+\/[a-z0-9_-]+$/);
    expect(finalizedObjectKey(stagingKey)).toMatch(/^attachments\//);
  });
});

describe('queue finalization', () => {
  it('activates only after every expected attachment is complete', () => {
    expect(isContentReadyForActivation(2, 2, 0)).toBe(true);
    expect(isContentReadyForActivation(2, 1, 0)).toBe(false);
    expect(isContentReadyForActivation(2, 2, 1)).toBe(false);
    expect(isContentReadyForActivation(0, 0, 0)).toBe(false);
  });
});
