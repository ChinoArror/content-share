import { unzipSync } from 'fflate';

export const MAX_ZIP_PREVIEW_INPUT_BYTES = 100 * 1024 * 1024;
export const MAX_ZIP_PREVIEW_OUTPUT_BYTES = 160 * 1024 * 1024;

export function normalizeZipEntryName(name: string): string | null {
  const normalized = name.replaceAll('\\', '/');
  const parts = normalized.split('/').filter((part) => part && part !== '.');
  if (!parts.length || parts.some((part) => part === '..' || part.includes('\0'))) return null;
  return parts.join('/');
}

export function selectZipHtmlEntry(names: readonly string[]): string | null {
  const candidates = names
    .map((name) => normalizeZipEntryName(name))
    .filter((name): name is string => Boolean(name && /\.html?$/i.test(name)))
    .filter((name) => !name.startsWith('__MACOSX/'));
  candidates.sort((left, right) => {
    const score = (name: string) => {
      const lower = name.toLowerCase();
      const depth = lower.split('/').length - 1;
      const base = lower.split('/').pop() || '';
      return (base === 'index.html' || base === 'index.htm' ? 0 : 10) + depth;
    };
    return score(left) - score(right) || left.localeCompare(right);
  });
  return candidates[0] || null;
}

export function extractZipEntries(input: ArrayBuffer | Uint8Array): Map<string, Uint8Array> {
  const bytes = input instanceof Uint8Array ? input : new Uint8Array(input);
  if (bytes.byteLength > MAX_ZIP_PREVIEW_INPUT_BYTES) {
    throw new Error('压缩包过大，无法在线查看实际页面，请下载后打开');
  }
  const archive = unzipSync(bytes);
  const entries = new Map<string, Uint8Array>();
  let outputBytes = 0;
  for (const [rawName, data] of Object.entries(archive)) {
    const name = normalizeZipEntryName(rawName);
    if (!name || rawName.endsWith('/')) continue;
    outputBytes += data.byteLength;
    if (outputBytes > MAX_ZIP_PREVIEW_OUTPUT_BYTES) {
      throw new Error('压缩包解压后过大，无法在线查看实际页面，请下载后打开');
    }
    entries.set(name, data);
  }
  return entries;
}
