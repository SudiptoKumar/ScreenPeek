import { test, expect } from '@playwright/test';

test('header suggestions are bounded, keyboard accessible, and use the owned search endpoint', async ({ page }) => {
  await page.setViewportSize({ width: 360, height: 800 });
  const queries: string[] = [];
  page.on('request', request => {
    if (new URL(request.url()).pathname.startsWith('/api/search')) queries.push(new URL(request.url()).searchParams.get('q') || '');
  });
  await page.goto('/');
  expect(queries).toEqual([]);
  const input = page.locator('#search');
  await page.getByRole('button', { name: 'Open search' }).click();
  await input.fill('Sample');
  const results = page.getByRole('listbox');
  await expect(results).toBeVisible();
  await expect(results.getByRole('option')).toHaveCount(8);
  await expect(input).toHaveAttribute('aria-expanded', 'true');
  await input.press('ArrowDown');
  await expect(input).toHaveAttribute('aria-activedescendant', /.+/);
  await input.press('Escape');
  await expect(input).toHaveAttribute('aria-expanded', 'false');
  await input.fill('Quiet');
  await expect(results).toBeVisible();
  await input.press('ArrowDown');
  await input.press('Enter');
  await expect(page).toHaveURL(/\/(movie|tv)\/sample-/);
  expect(queries.every(query => query.trim().length >= 2)).toBe(true);
});

test('search results paginate and filter without JavaScript; the API caps results at eight', async ({ browser, request }) => {
  const context = await browser.newContext({ javaScriptEnabled: false, viewport: { width: 360, height: 800 } });
  const page = await context.newPage();
  try {
    expect((await page.goto('/search/?q=Sample'))?.status()).toBe(200);
    await expect(page.locator('[data-poster-card]')).toHaveCount(24);
    await expect(page.locator('meta[name="robots"]')).toHaveAttribute('content', /noindex/);
    await page.getByRole('navigation', { name: 'Pagination', exact: true }).getByRole('link', { name: /Page 2/i }).click();
    await expect(page).toHaveURL(/q=Sample.*page=2/);
    await expect(page.locator('[data-poster-card]')).toHaveCount(24);
    await page.goto('/search/?q=Sample&type=tv');
    await expect(page.locator('[data-poster-card]')).toHaveCount(20);
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
    expect((await page.goto('/search/?q=Sample&page=999'))?.status()).toBe(404);
  } finally { await context.close(); }
  const response = await request.get('/api/search/?q=Sample&limit=999');
  expect(response.status()).toBe(200);
  expect((await response.json()).results).toHaveLength(8);
  expect(response.headers()['cache-control']).toBe('no-store');
});
