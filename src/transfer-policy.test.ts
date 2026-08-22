import { describe, expect, it } from 'vitest';
import {
  GiB,
  MiB,
  MAX_UPLOAD_SIZE,
  buildPartPlan,
  buildPartWindow,
  chooseUploadMode,
  finalizedObjectKey,
  isContentReadyForActivation,
  normalizeUploadFilename,
  partSizeFor,
  parseByteRange,
  safeObjectKey,
  safeStagingObjectKey
} from './transfer-policy';

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

  it('uses 8 MiB parts through 100 MiB and 64 MiB parts above it', () => {
    expect(partSizeFor(100 * MiB)).toBe(8 * MiB);
    expect(partSizeFor(100 * MiB + 1)).toBe(64 * MiB);
  });

  it('supports exactly 5 GiB as 80 uniform parts', () => {
    const parts = buildPartPlan(5 * GiB);

    expect(MAX_UPLOAD_SIZE).toBe(5 * GiB);
    expect(parts).toHaveLength(80);
    expect(parts.every((part) => part.size === 64 * MiB)).toBe(true);
    expect(parts.at(-1)).toEqual({
      partNumber: 80,
      start: 5 * GiB - 64 * MiB,
      end: 5 * GiB,
      size: 64 * MiB
    });
  });

  it('rejects empty files and bytes above 5 GiB', () => {
    expect(() => buildPartPlan(0)).toThrow('File size must be positive');
    expect(() => buildPartPlan(5 * GiB + 1)).toThrow('File exceeds 5 GiB');
  });
});

describe('buildPartWindow', () => {
  it('returns at most eight missing parts after the cursor and reports the next gap', () => {
    const completed = new Set([1, 3, 10]);

    const first = buildPartWindow(100 * MiB, completed, 0, 99);
    const second = buildPartWindow(100 * MiB, completed, 11, 8);

    expect(first.parts.map((part) => part.partNumber)).toEqual([2, 4, 5, 6, 7, 8, 9, 11]);
    expect(first).toMatchObject({ nextPartNumber: 12, hasMoreParts: true });
    expect(second.parts.map((part) => part.partNumber)).toEqual([12, 13]);
    expect(second).toMatchObject({ nextPartNumber: null, hasMoreParts: false });
  });

  it('never returns completed parts from a later window', () => {
    const completed = [2, 4, 6, 8, 10, 12];

    const window = buildPartWindow(100 * MiB, completed, 5, 8);

    expect(window.parts.map((part) => part.partNumber)).toEqual([7, 9, 11, 13]);
    expect(window.hasMoreParts).toBe(false);
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
