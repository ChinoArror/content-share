import { describe, expect, it } from 'vitest';
import worker from './worker';

describe('API cache policy', () => {
  it('marks JSON API responses as private and uncacheable', async () => {
    const response = await worker.fetch(new Request('https://content.aryuki.com/api/not-a-route'), {} as never, {} as never);
    expect(response.status).toBe(404);
    expect(response.headers.get('cache-control')).toBe('private, no-store');
  });

  it('marks public background file responses as uncacheable', async () => {
    const env = { BUCKET: { get: async () => ({ body: new ReadableStream(), httpMetadata: { contentType: 'image/png' } }) } };
    const response = await worker.fetch(new Request('https://content.aryuki.com/api/background/example.png'), env as never, {} as never);
    expect(response.status).toBe(200);
    expect(response.headers.get('cache-control')).toBe('private, no-store');
  });
});
