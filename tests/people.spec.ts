import { test, expect } from '@playwright/test';

test('mobile person page links title cast into an owned-data filmography', async ({ page }) => {
  await page.setViewportSize({ width: 360, height: 800 });
  const external: string[] = [];
  page.on('request', request => {
    if (!['127.0.0.1', 'localhost'].includes(new URL(request.url()).hostname)) external.push(request.url());
  });
  await page.goto('/movies/');
  const title = await page.locator('[data-poster-card]').first().getAttribute('href');
  await page.goto(title!);
  const person = await page.locator('[data-detail-section="cast"] a[href^="/cast/"]').first().getAttribute('href');
  expect((await page.goto(person!))?.status()).toBe(200);
  await expect(page.locator('h1')).toContainText('Sample Person');
  await expect(page.getByRole('heading', { name: 'Filmography', exact: true })).toBeVisible();
  expect(await page.locator('[data-poster-card]').count()).toBeGreaterThan(0);
  expect(await page.locator('[data-poster-card]').count()).toBeLessThanOrEqual(24);
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  await expect(page.locator('link[rel="stylesheet"]')).toHaveCount(1);
  expect(external).toEqual([]);
  expect((await page.goto('/cast/no-such-person/'))?.status()).toBe(404);
  await expect(page.locator('header.site-header')).toBeVisible();
});
