import { test, expect } from '@playwright/test';

for (const route of ['/genre/drama/', '/language/en/', '/collection/sample-collection/', '/new/', '/top10/', '/upcoming/']) {
  test(`mobile taxonomy/list hub: ${route}`, async ({ page }) => {
    await page.setViewportSize({ width: 360, height: 800 });
    expect((await page.goto(route))?.status()).toBe(200);
    await expect(page.locator('[data-hub-page]')).toBeVisible();
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
    expect(await page.locator('[data-poster-card]').count()).toBeLessThanOrEqual(24);
    await expect(page.locator('link[rel="stylesheet"]')).toHaveCount(1);
    if (route !== '/top10/') expect(await page.locator('[data-poster-card]').count()).toBeGreaterThan(0);
    await expect(page.locator('meta[name="robots"]')).toHaveAttribute('content', /noindex/);
  });
}

test('language pagination, missing taxonomy, and canonical type aliases', async ({ page, request }) => {
  await page.goto('/language/en/page/3/');
  await expect(page.locator('[data-poster-card]')).toHaveCount(2);
  expect((await page.goto('/genre/not-a-known-genre/'))?.status()).toBe(404);
  await expect(page.locator('header.site-header')).toBeVisible();
  const alias = await request.get('/type/movie/?page=2', { maxRedirects: 0 });
  expect(alias.status()).toBe(301);
  expect(alias.headers().location).toBe('/movies/page/2/');
});
