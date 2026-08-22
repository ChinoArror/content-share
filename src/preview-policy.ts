export type PreviewKind = 'image' | 'video' | 'audio' | 'pdf' | 'html' | 'text' | 'office' | 'zip' | 'download';

const ZIP_TYPES = new Set([
  'application/zip',
  'application/x-zip-compressed',
  'multipart/x-zip'
]);

export function fileExtension(filename: string): string {
  return filename.split(/[\\/]/).pop()?.split('.').pop()?.toLowerCase() || '';
}

export function previewKind(filename: string, contentType?: string | null): PreviewKind {
  const ext = fileExtension(filename);
  const type = (contentType || '').toLowerCase().split(';', 1)[0].trim();
  if (ZIP_TYPES.has(type) || ext === 'zip') return 'zip';
  if (type === 'image/svg+xml' || ext === 'svg') return 'download';
  if (type.startsWith('image/')) return 'image';
  if (type.startsWith('video/')) return 'video';
  if (type.startsWith('audio/')) return 'audio';
  if (type === 'application/pdf' || ext === 'pdf') return 'pdf';
  if (type === 'text/html' || ['html', 'htm'].includes(ext)) return 'html';
  if (type.startsWith('text/') || ['txt', 'md', 'csv', 'json', 'log', 'xml', 'css', 'js', 'ts'].includes(ext)) return 'text';
  if (['doc', 'docx', 'xls', 'xlsx', 'ppt', 'pptx'].includes(ext)) return 'office';
  return 'download';
}

export function mimeTypeForArchivePath(path: string): string {
  const ext = fileExtension(path);
  const types: Record<string, string> = {
    html: 'text/html', htm: 'text/html', css: 'text/css', js: 'text/javascript', mjs: 'text/javascript',
    json: 'application/json', xml: 'application/xml', svg: 'image/svg+xml', png: 'image/png', jpg: 'image/jpeg',
    jpeg: 'image/jpeg', gif: 'image/gif', webp: 'image/webp', avif: 'image/avif', ico: 'image/x-icon',
    mp3: 'audio/mpeg', wav: 'audio/wav', ogg: 'audio/ogg', mp4: 'video/mp4', webm: 'video/webm',
    txt: 'text/plain', md: 'text/markdown', csv: 'text/csv', woff: 'font/woff', woff2: 'font/woff2',
    ttf: 'font/ttf', otf: 'font/otf'
  };
  return types[ext] || 'application/octet-stream';
}
