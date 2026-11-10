import { test, expect } from '@playwright/test';

for (const route of ['/', '/movies/', '/series/']) {
  test(`mobile catalogue layout and source isolation: ${route}`, async ({ page }) => {
    await page.setViewportSize({ width: 360, height: 800 });
    const requests: string[] = [];
    page.on('request', request => requests.push(request.url()));
    const response = await page.goto(route);
    expect(response?.status()).toBe(200);
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
    expect(await page.locator('[data-poster-card]').count()).toBeLessThanOrEqual(24);
    expect(await page.locator('[data-poster-card]').count()).toBeGreaterThan(0);
    await expect(page.locator('link[rel="stylesheet"]')).toHaveCount(1);
    for (const image of await page.locator('img').all()) {
      expect(await image.getAttribute('width')).toBeTruthy();
      expect(await image.getAttribute('height')).toBeTruthy();
    }
    expect(requests.some(url => /api\.themoviedb\.org|image\.tmdb\.org/.test(url))).toBe(false);
  });
}

test('movie filters and numbered pagination work with real navigation and no JavaScript', async ({ browser }) => {
  const context = await browser.newContext({ javaScriptEnabled: false, viewport: { width: 360, height: 800 } });
  const page = await context.newPage();
  try {
    await page.goto('/movies/');
    await expect(page.locator('[data-catalogue-grid] [data-poster-card]')).toHaveCount(24);
    await page.getByRole('navigation', { name: 'Pagination', exact: true }).getByRole('link', { name: /Page 2/i }).click();
    await expect(page).toHaveURL(/page\/2\//);
    await expect(page.locator('[data-catalogue-grid] [data-poster-card]')).toHaveCount(6);
    await page.goto('/movies/');
    const filters = page.getByRole('form', { name: 'Catalogue filters' });
    await filters.locator('select[name="genre"]').selectOption('drama');
    await filters.getByRole('button', { name: /apply|filter/i }).click();
    await expect(page.locator('[data-catalogue-grid] [data-poster-card]')).toHaveCount(10);
    const missing = await page.goto('/movies/page/9999/');
    expect(missing?.status()).toBe(404);
    await expect(page.locator('header')).toBeVisible();
  } finally { await context.close(); }
});
