import { test, expect } from '@playwright/test';
import { localBindings } from '../sync/local.ts';

test('trailer facade makes zero YouTube requests until an explicit click', async ({ page }) => {
  const state = await localBindings();
  const sample = (await state.db.query<{ slug: string; trailer_key: string | null }>("SELECT slug,trailer_key FROM titles WHERE id=-10001 AND type='movie' AND title LIKE 'Sample:%'"))[0];
  if (!sample) throw new Error('Prepare the local sample catalogue before browser tests');
  const fixtureKey = 'sampleKey01';
  try {
    await state.db.batch([{ sql: "UPDATE titles SET trailer_key=? WHERE id=-10001 AND type='movie'", params: [fixtureKey] }]);
    await page.setViewportSize({ width: 360, height: 800 });
    const youtube: string[] = [];
    page.on('request', request => { if (/youtube|ytimg|googlevideo/.test(request.url())) youtube.push(request.url()); });
    await page.route('https://www.youtube-nocookie.com/**', route => route.fulfill({ contentType: 'text/html', body: '<!doctype html><title>Simulated trailer embed</title><p>Trailer test</p>' }));
    expect((await page.goto(`/trailer/${sample.slug}/`))?.status()).toBe(200);
    await expect(page.locator('[data-trailer-facade]')).toBeVisible();
    await expect(page.locator('iframe')).toHaveCount(0);
    expect(youtube).toEqual([]);
    await page.locator('[data-trailer-facade] a').click();
    await expect(page.locator('iframe')).toHaveAttribute('src', new RegExp(`youtube-nocookie\\.com/embed/${fixtureKey}`));
    await expect.poll(() => youtube.length).toBeGreaterThan(0);
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  } finally {
    await state.db.batch([{ sql: "UPDATE titles SET trailer_key=? WHERE id=-10001 AND type='movie' AND trailer_key=?", params: [sample.trailer_key, fixtureKey] }]);
    await state.dispose();
  }
});

test('missing trailer and unknown title never show a fake player', async ({ page }) => {
  await page.goto('/movies/');
  const href = await page.locator('[data-poster-card]').first().getAttribute('href');
  const slug = href!.split('/').filter(Boolean).at(-1);
  expect((await page.goto(`/trailer/${slug}/`))?.status()).toBe(200);
  await expect(page.locator('iframe')).toHaveCount(0);
  await expect(page.locator('[data-trailer-facade]')).toHaveCount(0);
  expect((await page.goto('/trailer/no-such-title/'))?.status()).toBe(404);
});
