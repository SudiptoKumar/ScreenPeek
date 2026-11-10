import { test, expect } from '@playwright/test';
import { localBindings } from '../sync/local.ts';

test('watch pages localise providers and never load a popunder slot', async ({ page }) => {
  await page.setViewportSize({ width: 360, height: 800 });
  const local = await localBindings();
  const title = (await local.db.query<{ slug: string }>('SELECT slug FROM titles WHERE id=-10002'))[0];
  try {
    expect((await page.goto(`/watch/${title.slug}/?country=GB`))?.status()).toBe(200);
    await expect(page.locator('h1')).toContainText('United Kingdom');
    await expect(page.getByRole('heading', { name: 'Rent', exact: true })).toBeVisible();
    await expect(page.getByText('Streaming data by JustWatch.', { exact: true })).toBeVisible();
    await expect(page.locator('[data-placement="popunder"], [data-popunder]')).toHaveCount(0);
    await expect(page.locator('body')).toHaveAttribute('data-page-type', 'watch');
    await page.getByRole('navigation', { name: 'Watch country' }).getByRole('link', { name: 'US', exact: true }).click();
    await expect(page.locator('h1')).toContainText('United States');
    await expect(page.getByRole('heading', { name: 'Stream', exact: true })).toBeVisible();
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
    expect((await page.goto('/watch/no-such-title/'))?.status()).toBe(404);
  } finally { await local.dispose(); }
});
