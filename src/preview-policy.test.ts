import { describe, expect, it } from 'vitest';
import { previewKind } from './preview-policy';

describe('preview policy', () => {
  it('recognizes direct HTML files as HTML pages', () => {
    expect(previewKind('landing.html', 'application/octet-stream')).toBe('html');
    expect(previewKind('landing.HTM', '')).toBe('html');
  });

  it('keeps ZIP archives separate from generic downloads', () => {
    expect(previewKind('site.zip', 'application/octet-stream')).toBe('zip');
    expect(previewKind('site.bin', 'application/zip')).toBe('zip');
  });

  it('does not classify SVG as an executable inline preview', () => {
    expect(previewKind('icon.svg', 'image/svg+xml')).toBe('download');
  });

  it('routes QuickTime MOV to native video even when upload metadata is generic', () => {
    expect(previewKind('clip.mov', 'video/quicktime')).toBe('video');
    expect(previewKind('clip.mov', 'application/octet-stream')).toBe('video');
  });
});
