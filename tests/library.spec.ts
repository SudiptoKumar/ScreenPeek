import { test, expect } from '@playwright/test';

test('My List toggles on cards/detail, survives reload, and records browser-local history without ads', async ({ page }) => {
  await page.setViewportSize({ width: 360, height: 800 });
  await page.goto('/movies/');
  const card = page.locator('.poster-item').first();
  const href = await card.locator('[data-poster-card]').getAttribute('href');
  await card.locator('[data-mylist-toggle]').click();
  await expect(card.locator('[data-mylist-toggle]')).toHaveAttribute('aria-pressed', 'true');
  await page.reload();
  await expect(page.locator('[data-mylist-toggle]').first()).toHaveAttribute('aria-pressed', 'true');
  await page.goto(href!);
  await expect(page.locator('.detail-actions [data-mylist-toggle]')).toHaveAttribute('aria-pressed', 'true');
  await page.goto('/mylist/');
  await expect(page.locator('[data-library-saved] [data-poster-card]')).toHaveCount(1);
  await expect(page.locator('[data-library-history] a')).toHaveCount(1);
  await expect(page.locator('.ad-slot')).toHaveCount(0);
  await expect(page.locator('meta[name="robots"]')).toHaveAttribute('content', /noindex/);
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  await page.locator('[data-library-saved] button').click();
  await expect(page.locator('[data-library-saved]')).toContainText('Your list is empty');
  await expect(page.locator('[data-library-history] a')).toHaveCount(1);
  await page.reload();
  await expect(page.locator('[data-library-saved]')).toContainText('Your list is empty');
});

test('stored library data is rendered as text and poster grids remain capped at 24 with real page links', async ({ page }) => {
  const external: string[] = [];
  page.on('request', request => { if (new URL(request.url()).hostname !== '127.0.0.1') external.push(request.url()); });
  await page.addInitScript(() => {
    const items = Array.from({ length: 30 }, (_, id) => ({ id: id + 1, type: 'movie', slug: `sample-${id + 1}`, title: id ? `Title ${id}` : '<img src=x onerror=alert(1)>', year: '2026', poster: 'https://unowned.example.test/poster.webp' }));
    localStorage.setItem('screenpeek:mylist', JSON.stringify(items));
    localStorage.setItem('screenpeek:history', JSON.stringify(items));
  });
  await page.goto('/mylist/');
  await expect(page.locator('[data-library-saved] [data-poster-card]')).toHaveCount(24);
  await expect(page.locator('[data-library-saved]')).toContainText('<img src=x onerror=alert(1)>');
  await expect(page.locator('[data-library-page] img')).toHaveCount(0);
  expect(external).toEqual([]);
  await page.getByRole('navigation', { name: 'saved pages' }).getByRole('link', { name: '2', exact: true }).click();
  await expect(page.locator('[data-library-saved] [data-poster-card]')).toHaveCount(6);
  await expect(page).toHaveURL(/saved=2/);
});
