import { test, expect } from '@playwright/test';

test('TV season and episode pages work as separate mobile information routes', async ({ page }) => {
  await page.setViewportSize({ width: 360, height: 800 });
  const external: string[] = [];
  page.on('request', request => {
    if (!['127.0.0.1', 'localhost'].includes(new URL(request.url()).hostname)) external.push(request.url());
  });
  await page.goto('/series/');
  const titleUrl = await page.locator('[data-poster-card]').first().getAttribute('href');
  await page.goto(titleUrl!);
  const seasonUrl = await page.locator('[data-detail-section="seasons"] a').first().getAttribute('href');
  expect((await page.goto(seasonUrl!))?.status()).toBe(200);
  await expect(page.locator('[data-episode-row]')).toHaveCount(3);
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  const episodeUrl = await page.locator('[data-episode-row] a[href*="/episode/"]').first().getAttribute('href');
  expect((await page.goto(episodeUrl!))?.status()).toBe(200);
  await expect(page.locator('h1')).toContainText('Sample Episode');
  await expect(page.locator('iframe')).toHaveCount(0);
  await expect(page.locator('link[rel="stylesheet"]')).toHaveCount(1);
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  expect(external).toEqual([]);
  expect((await page.goto(`${seasonUrl}episode/9999/`))?.status()).toBe(404);
  await expect(page.locator('header.site-header')).toBeVisible();
});
