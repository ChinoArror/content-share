export const MiB = 1024 * 1024;
export const SINGLE_UPLOAD_LIMIT = 16 * MiB;
export const MULTIPART_PART_SIZE = 8 * MiB;
export const MAX_UPLOAD_SIZE = 100 * MiB;

export type UploadMode = 'single' | 'multipart';
export type UploadPartPlan = {
  partNumber: number;
  start: number;
  end: number;
  size: number;
};

export function chooseUploadMode(size: number): UploadMode {
  return size <= SINGLE_UPLOAD_LIMIT ? 'single' : 'multipart';
}

export function buildPartPlan(size: number): UploadPartPlan[] {
  if (!Number.isSafeInteger(size) || size <= 0) throw new Error('File size must be positive');
  if (size > MAX_UPLOAD_SIZE) throw new Error('File exceeds 100 MiB');

  const parts: UploadPartPlan[] = [];
  for (let start = 0, partNumber = 1; start < size; start += MULTIPART_PART_SIZE, partNumber += 1) {
    const end = Math.min(start + MULTIPART_PART_SIZE, size);
    parts.push({ partNumber, start, end, size: end - start });
  }
  return parts;
}

export function parseByteRange(header: string, totalSize: number): { offset: number; length: number } | null {
  if (!Number.isSafeInteger(totalSize) || totalSize <= 0) return null;
  const match = /^bytes=(\d*)-(\d*)$/.exec(header.trim());
  if (!match || (!match[1] && !match[2])) return null;

  if (!match[1]) {
    const suffix = Number(match[2]);
    if (!Number.isSafeInteger(suffix) || suffix <= 0) return null;
    const length = Math.min(suffix, totalSize);
    return { offset: totalSize - length, length };
  }

  const offset = Number(match[1]);
  const requestedEnd = match[2] ? Number(match[2]) : totalSize - 1;
  if (!Number.isSafeInteger(offset) || !Number.isSafeInteger(requestedEnd) || offset < 0 || offset >= totalSize || requestedEnd < offset) return null;
  const end = Math.min(requestedEnd, totalSize - 1);
  return { offset, length: end - offset + 1 };
}

export function normalizeUploadFilename(filename: string): string {
  const normalized = filename
    .replace(/\r\n/g, '_')
    .replace(/[\\/\r\n\0]/g, '_')
    .trim()
    .slice(0, 180);
  return normalized || 'file';
}

function safeKeySegment(value: string): string {
  return value
    .toLowerCase()
    .replace(/[^a-z0-9_-]+/g, '_')
    .replace(/^_+|_+$/g, '')
    .slice(0, 96) || 'unknown';
}

export function safeObjectKey(owner: string, contentId: string, attachmentId: string): string {
  return `attachments/${safeKeySegment(owner)}/${safeKeySegment(contentId)}/${safeKeySegment(attachmentId)}`;
}

export function safeStagingObjectKey(owner: string, contentId: string, attachmentId: string): string {
  return `upload-staging/${safeKeySegment(owner)}/${safeKeySegment(contentId)}/${safeKeySegment(attachmentId)}`;
}

export function finalizedObjectKey(stagingKey: string): string {
  return stagingKey.startsWith('upload-staging/')
    ? `attachments/${stagingKey.slice('upload-staging/'.length)}`
    : `${stagingKey}/final`;
}

export function isContentReadyForActivation(expectedAttachments: number, completedAttachments: number, failedAttachments: number): boolean {
  return expectedAttachments > 0 && completedAttachments === expectedAttachments && failedAttachments === 0;
}
