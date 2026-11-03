import { readFileSync } from 'node:fs';
import { runInNewContext } from 'node:vm';
import { describe, expect, it } from 'vitest';

const html = readFileSync(new URL('../index.html', import.meta.url), 'utf8');

function visit(protocol: string, hostname: string) {
  let destination = '';
  const location = {
    protocol,
    hostname,
    host: hostname,
    pathname: '/s/example',
    search: '?file=1',
    hash: '#preview',
    replace: (url: string) => { destination = url; },
  };
  const inline = html.match(/<script>([\s\S]*?)<\/script>/)?.[1];
  expect(inline).toBeTruthy();
  runInNewContext(inline!, { location });
  return destination;
}

describe('HTTPS entry', () => {
  it('redirects the public HTTP hostname before loading the module bundle', () => {
    expect(visit('http:', 'content.aryuki.cn')).toBe('https://content.aryuki.cn/s/example?file=1#preview');
    expect(html.indexOf('<script>')).toBeLessThan(html.indexOf('type="module"'));
  });

  it('leaves HTTPS and local development URLs untouched', () => {
    expect(visit('https:', 'content.aryuki.cn')).toBe('');
    expect(visit('http:', 'localhost')).toBe('');
  });
});
