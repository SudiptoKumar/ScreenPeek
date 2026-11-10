import { test, expect } from '@playwright/test';
import { testWorker } from './helpers/worker.ts';
import { accessFixture } from './helpers/access.ts';

for (const route of ['about', 'privacy', 'dmca', 'contact']) test(`trust page ${route} is readable at 360px with attribution and no ads`, async ({ page }) => {
  await page.setViewportSize({ width: 360, height: 800 });
  expect((await page.goto(`/${route}/`))?.status()).toBe(200);
  await expect(page.locator('h1')).toBeVisible();
  await expect(page.locator('.trust-content')).toBeVisible();
  await expect(page.locator('.ad-slot,[data-popunder],[data-placement="social_bar"]')).toHaveCount(0);
  await expect(page.locator('footer')).toContainText('not endorsed or certified by TMDB');
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  if (route === 'about') await expect(page.locator('.trust-attribution')).toContainText('not endorsed or certified by TMDB');
});

test('unknown routes return a styled actual 404 with a working home link', async ({ page }) => {
  await page.setViewportSize({ width: 360, height: 800 });
  for (const route of ['/no-such-route/', '/no/such/nested/route/']) {
    expect((await page.goto(route))?.status()).toBe(404);
    await expect(page.locator('header.site-header')).toBeVisible();
    await expect(page.getByRole('link', { name: 'Go home', exact: true })).toHaveAttribute('href', '/');
    await expect(page.locator('meta[name="robots"]')).toHaveAttribute('content', /noindex/);
    await expect(page.locator('.ad-slot,[data-popunder]')).toHaveCount(0);
  }
});

test('admin can edit trust Markdown without executing HTML, while About attribution cannot disappear', async ({ browser }) => {
  const fixture = accessFixture();
  const worker = await testWorker({ ADS_ENABLED: '1', CF_ACCESS_TEAM_DOMAIN: fixture.team, CF_ACCESS_AUD: fixture.aud }, 8790, { [fixture.certUrl]: { body: { keys: [fixture.jwk] } } });
  const context = await browser.newContext({ viewport: { width: 360, height: 800 }, extraHTTPHeaders: fixture.headers('editor@example.test') });
  const page = await context.newPage();
  try {
    await worker.local.db.batch([{ sql: "INSERT INTO admin_users(email,role) VALUES('editor@example.test','editor')" }]);
    expect((await page.goto(`${worker.base}/admin/pages/?edit=about`))?.status()).toBe(200);
    await page.getByRole('textbox', { name: 'Page content (Markdown) *', exact: true }).fill('## Edited information\n\nStored **safely**.\n\n<script>document.body.dataset.unsafe="yes"</script>');
    await page.getByRole('button', { name: 'Save page', exact: true }).click();
    await expect(page.locator('.notice[role="status"]')).toContainText('pending');
    await page.goto(`${worker.base}/about/`);
    await expect(page.getByRole('heading', { name: 'Edited information' })).toBeVisible();
    await expect(page.locator('.trust-content strong')).toHaveText('safely');
    expect(await page.locator('body').getAttribute('data-unsafe')).toBeNull();
    await expect(page.locator('.trust-attribution')).toContainText('not endorsed or certified by TMDB');
    const history = await worker.local.db.query<{ actor: string; entity: string }>('SELECT actor,entity FROM admin_log');
    expect(history).toEqual([{ actor: 'editor@example.test', entity: 'page' }]);
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  } finally { await context.close(); await worker.dispose(); }
});
