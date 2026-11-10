import { test, expect } from '@playwright/test';
import { localBindings } from '../sync/local.ts';

test('managed redirect uses country rules and its approximate click is batched within a minute', async ({ request }) => {
  const local = await localBindings();
  const slug = `test-go-${Date.now()}`;
  try {
    await local.db.batch([{ sql: 'INSERT INTO links(slug,name,destination,type,rules) VALUES(?,?,?,?,?)', params: [slug, 'Temporary redirect fixture', 'https://default.example.test', 'affiliate', JSON.stringify({ byCountry: { GB: 'https://gb.example.test' } })] }]);
    const response = await request.get(`/go/${slug}/`, { headers: { Cookie: 'country=GB' }, maxRedirects: 0 });
    expect(response.status()).toBe(302);
    expect(response.headers().location).toBe('https://gb.example.test/');
    await expect.poll(async () => (await local.db.query<{ clicks_total: number }>('SELECT clicks_total FROM links WHERE slug=?', [slug]))[0].clicks_total, { timeout: 15_000 }).toBe(1);
    const missing = await request.get('/go/no-such-managed-link/?url=https://evil.example.test', { maxRedirects: 0 });
    expect(missing.status()).toBe(302); expect(missing.headers().location).toBe('/');
  } finally {
    await local.db.batch([{ sql: 'DELETE FROM click_log WHERE slug=?', params: [slug] }, { sql: 'DELETE FROM links WHERE slug=?', params: [slug] }]);
    await local.dispose();
  }
});
