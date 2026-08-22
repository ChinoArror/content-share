import { zipSync } from 'fflate';
import { describe, expect, it } from 'vitest';
import { extractZipEntries, selectZipHtmlEntry } from './zip-preview';

describe('zip page preview', () => {
  it('prefers a root index.html entry', () => {
    expect(selectZipHtmlEntry(['assets/app.js', 'docs/page.html', 'index.html'])).toBe('index.html');
  });

  it('falls back to the first safe HTML entry and rejects traversal names', () => {
    expect(selectZipHtmlEntry(['../index.html', '__MACOSX/._index.html', 'site/home.htm'])).toBe('site/home.htm');
    expect(selectZipHtmlEntry(['assets/app.js', 'readme.txt'])).toBeNull();
  });

  it('extracts HTML and asset bytes from a compressed archive', () => {
    const archive = zipSync({
      'index.html': new TextEncoder().encode('<h1>Hello</h1>'),
      'assets/app.js': new TextEncoder().encode('console.log("ok")')
    });
    const entries = extractZipEntries(archive);
    expect(new TextDecoder().decode(entries.get('index.html'))).toContain('Hello');
    expect(new TextDecoder().decode(entries.get('assets/app.js'))).toContain('console.log');
  });
});
