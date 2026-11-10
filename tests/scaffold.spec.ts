import { test, expect } from '@playwright/test';

test('production scaffold: mobile navigation, attribution, one stylesheet and reserved ads', async ({ page }) => {
  await page.setViewportSize({ width: 360, height: 800 });
  const response = await page.goto('/');
  expect(response?.status()).toBe(200);
  await expect(page).toHaveTitle(/ScreenPeek/);
  expect(await page.locator('header').evaluate(el => el.getBoundingClientRect().height)).toBeLessThanOrEqual(56);
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  await page.locator('summary').click();
  await expect(page.getByRole('navigation', { name: 'Mobile navigation' })).toBeVisible();
  await expect(page.locator('link[rel="stylesheet"]')).toHaveCount(1);
  for (const script of await page.locator('script[src]').all()) {
    expect(new URL((await script.getAttribute('src'))!, page.url()).origin).toBe(new URL(page.url()).origin);
  }
  await expect(page.locator('.ad-slot[data-placement="top_300x250"]')).toHaveCSS('min-height', '250px');
  await expect(page.locator('footer')).toContainText('not endorsed or certified by TMDB');
  await page.locator('img[alt="TMDB"]').scrollIntoViewIfNeeded();
  await expect.poll(() => page.locator('img[alt="TMDB"]').evaluate((el: HTMLImageElement) => el.complete && el.naturalWidth > 0)).toBe(true);
});
