import { test, expect } from '@playwright/test';

for (const route of ['/movies/', '/series/']) {
  test(`mobile title detail anatomy and source isolation from ${route}`, async ({ page }) => {
    await page.setViewportSize({ width: 360, height: 800 });
    const external: string[] = [];
    page.on('request', request => {
      if (!['127.0.0.1', 'localhost'].includes(new URL(request.url()).hostname)) external.push(request.url());
    });
    await page.goto(route);
    const href = await page.locator('[data-poster-card]').first().getAttribute('href');
    const response = await page.goto(href!);
    expect(response?.status()).toBe(200);
    await expect(page.locator('h1')).toContainText('Sample:');
    await expect(page.getByRole('link', { name: /Where to Watch/i }).first()).toHaveAttribute('href', /^\/watch\//);
    await expect(page.getByRole('link', { name: /Trailer/i }).first()).toHaveAttribute('href', /^\/trailer\//);
    await expect(page.getByRole('heading', { name: 'Storyline', exact: true })).toBeVisible();
    await expect(page.getByRole('heading', { name: 'Community Verdict', exact: true })).toBeVisible();
    await expect(page.getByRole('heading', { name: 'More Like This', exact: true })).toBeVisible();
    expect(await page.locator('[data-poster-card]').count()).toBeLessThanOrEqual(12);
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
    await expect(page.locator('link[rel="stylesheet"]')).toHaveCount(1);
    await expect(page.locator('iframe')).toHaveCount(0);
    expect(external).toEqual([]);
    if (route === '/series/') await expect(page.getByRole('heading', { name: 'Seasons', exact: true })).toBeVisible();
  });
}

test('unknown title has an actual styled HTTP 404', async ({ page }) => {
  const response = await page.goto('/movie/a-title-that-does-not-exist-2026/');
  expect(response?.status()).toBe(404);
  await expect(page.locator('header.site-header')).toBeVisible();
  await expect(page.locator('meta[name="robots"]')).toHaveAttribute('content', /noindex/);
});
