import { test, expect } from '@playwright/test';
import { testWorker } from './helpers/worker.ts';
import { accessFixture } from './helpers/access.ts';

test('admin verifies Access, enforces roles, creates a working link and ad without deploying, and exports private config', async ({ browser }) => {
  test.setTimeout(90_000);
  const fixture = accessFixture();
  const worker = await testWorker({ ADS_ENABLED: '1', CF_ACCESS_TEAM_DOMAIN: fixture.team, CF_ACCESS_AUD: fixture.aud }, 8790, { [fixture.certUrl]: { body: { keys: [fixture.jwk] } } });
  const context = await browser.newContext({ viewport: { width: 360, height: 800 }, extraHTTPHeaders: fixture.headers('owner@example.test') });
  const page = await context.newPage();
  try {
    await worker.local.db.batch([{ sql: "INSERT INTO admin_users(email,role) VALUES('owner@example.test','owner'),('viewer@example.test','viewer'),('ads@example.test','ads')" }]);
    const anonymous = await browser.newContext();
    try {
      const request = await anonymous.request.get(`${worker.base}/admin/`); expect(request.status()).toBe(401);
      const spoofed = await anonymous.request.get(`${worker.base}/admin/links/`, { headers: { 'Cf-Access-Authenticated-User-Email': 'owner@example.test' } }); expect(spoofed.status()).toBe(401);
    } finally { await anonymous.close(); }
    expect((await page.goto(`${worker.base}/admin/`))?.status()).toBe(200);
    await expect(page.getByRole('heading', { name: 'Dashboard', exact: true })).toBeVisible();
    await expect(page.locator('.ad-slot,[data-popunder]')).toHaveCount(0);
    expect((await page.goto(`${worker.base}/admin/links/`))?.status()).toBe(200);
    await page.getByLabel('Name *', { exact: true }).fill('Browser managed link');
    await page.getByLabel('Slug *', { exact: true }).fill('browser-managed');
    await page.getByLabel('Default destination *', { exact: true }).fill('https://default.example.test/');
    await page.getByLabel('GB destination', { exact: true }).fill('https://gb.example.test/');
    await page.getByRole('button', { name: 'Save link', exact: true }).click();
    await expect(page.locator('.notice[role="status"]')).toContainText('Saved in D1');
    const redirect = await context.request.get(`${worker.base}/go/browser-managed/?country=GB`, { maxRedirects: 0 });
    expect(redirect.status()).toBe(302); expect(redirect.headers().location).toBe('https://gb.example.test/');
    await expect.poll(async () => (await worker.local.db.query<{ clicks_total: number }>("SELECT clicks_total FROM links WHERE slug='browser-managed'"))[0]?.clicks_total, { timeout: 15_000 }).toBe(1);
    await page.goto(`${worker.base}/admin/ads/`);
    const slot = page.locator('.admin-slot').filter({ has: page.getByRole('heading', { name: 'detail / native', exact: true }) });
    await slot.getByLabel('Original code').fill('<div id="admin-created-ad">Admin test advertisement</div>');
    await slot.getByLabel('Enabled', { exact: true }).check();
    await slot.getByRole('button', { name: 'Save detail/native', exact: true }).click();
    await expect(page.locator('.notice[role="status"]')).toContainText('pending');
    await page.goto(`${worker.base}/admin/settings/`);
    const master = page.locator('form').filter({ has: page.getByLabel('Master ads switch', { exact: true }) });
    await master.getByLabel('Master ads switch', { exact: true }).fill('1');
    await master.getByRole('button').click();
    const slug = (await worker.local.db.query<{ slug: string }>("SELECT slug FROM titles WHERE id=-10001 AND type='movie'"))[0].slug;
    await page.goto(`${worker.base}/movie/${slug}/`);
    await expect(page.locator('#admin-created-ad')).toHaveText('Admin test advertisement');
    await page.goto(`${worker.base}/admin/ads/`);
    await slot.getByLabel('Authenticated test mode', { exact: true }).check();
    await slot.getByRole('button', { name: 'Save detail/native', exact: true }).click();
    await expect(page.locator('.notice[role="status"]')).toContainText('pending');
    await page.goto(`${worker.base}/movie/${slug}/`);
    await expect(page.locator('#admin-created-ad')).toHaveCount(0);
    const preview = await page.goto(`${worker.base}/movie/${slug}/?adtest=1`);
    expect(preview?.headers()['cache-control']).toContain('no-store');
    await expect(page.locator('#admin-created-ad')).toBeVisible();
    const untrustedPreview = await browser.newContext();
    try {
      const response = await untrustedPreview.request.get(`${worker.base}/movie/${slug}/?adtest=1`);
      expect(await response.text()).not.toContain('id="admin-created-ad"');
    } finally { await untrustedPreview.close(); }
    const backup = await context.request.get(`${worker.base}/admin/backup/?download=1`);
    expect(backup.status()).toBe(200); expect(backup.headers()['content-disposition']).toContain('attachment');
    const exported = await backup.json(); expect(exported.data.links[0].slug).toBe('browser-managed');
    const viewer = await browser.newContext({ extraHTTPHeaders: fixture.headers('viewer@example.test') });
    try {
      const denied = await viewer.request.post(`${worker.base}/admin/links/`, { headers: { Origin: worker.base }, form: { name: 'Forbidden', slug: 'forbidden', type: 'affiliate', destination: 'https://example.test/', revision: '-1' } });
      expect(denied.status()).toBe(403);
      expect((await viewer.request.get(`${worker.base}/admin/backup/?download=1`)).status()).toBe(403);
    } finally { await viewer.close(); }
    const ads = await browser.newContext({ extraHTTPHeaders: fixture.headers('ads@example.test') });
    try {
      expect((await ads.request.get(`${worker.base}/admin/settings/`)).status()).toBe(403);
      const denied = await ads.request.post(`${worker.base}/admin/ads/`, { headers: { Origin: worker.base }, form: { key: 'maintenance', value: '1', revision: '0' } });
      expect(denied.status()).toBe(403);
    } finally { await ads.close(); }
    const history = await worker.local.db.query<{ actor: string }>('SELECT actor FROM admin_log');
    expect(history.length).toBeGreaterThanOrEqual(3); expect(history.every(row => row.actor === 'owner@example.test')).toBe(true);
    for (const route of ['sync', 'backup']) {
      expect((await page.goto(`${worker.base}/admin/${route}/`))?.status()).toBe(200);
      expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
      await expect(page.locator('.ad-slot,[data-popunder]')).toHaveCount(0);
    }
    await page.goto(`${worker.base}/admin/content/`);
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
    await page.screenshot({ path: '.cache/admin-mobile.png', fullPage: false });
    await page.goto(`${worker.base}/admin/settings/`);
    const maintenance = page.locator('form').filter({ has: page.getByLabel('Maintenance mode', { exact: true }) });
    await maintenance.getByLabel('Maintenance mode', { exact: true }).fill('1'); await maintenance.getByRole('button').click();
    await expect(page.locator('.notice[role="status"]')).toContainText('pending');
    expect((await page.goto(`${worker.base}/movies/`))?.status()).toBe(503);
    await expect(page.getByRole('heading', { name: 'We’ll be back soon.' })).toBeVisible();
    expect((await page.goto(`${worker.base}/admin/settings/`))?.status()).toBe(200);
    await maintenance.getByLabel('Maintenance mode', { exact: true }).fill('0'); await maintenance.getByRole('button').click();
    await expect(page.locator('.notice[role="status"]')).toContainText('pending');
    expect((await page.goto(`${worker.base}/movies/`))?.status()).toBe(200);
  } finally { await context.close(); await worker.dispose(); }
});
