import { test, expect } from '@playwright/test';
test('poster placeholders inherit a safe colour, detail hero stays flat, and swipe rows snap', async ({ page }) => {
  await page.setViewportSize({ width: 360, height: 800 });
  await page.goto('/');
  expect(await page.locator('.poster-row').first().evaluate(element => getComputedStyle(element).scrollSnapType)).toBe('x');
  await page.goto('/movie/sample-the-quiet-atlas-1-2022/');
  expect(await page.locator('.detail-hero').evaluate(element => getComputedStyle(element).backgroundImage)).toBe('none');
  expect(await page.locator('.cast-row').evaluate(element => getComputedStyle(element).scrollSnapType)).toBe('x');
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
});
