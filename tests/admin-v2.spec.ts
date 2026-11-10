import { test, expect } from '@playwright/test';
import { accessFixture } from './helpers/access.ts';
import { testWorker } from './helpers/worker.ts';
import { applyAdminAction } from '../src/lib/admin/actions.ts';
test('owner can Undo an ad, see duplicate warnings, retry delivery and edit working SEO controls', async ({ browser }) => {
  const access = accessFixture(), zone = 'a'.repeat(32);
  const worker = await testWorker({ CF_ACCESS_TEAM_DOMAIN: access.team, CF_ACCESS_AUD: access.aud, ADS_ENABLED: '1', CLOUDFLARE_ZONE_ID: zone, CLOUDFLARE_API_TOKEN: 'fixture-only' }, 8790, { [access.certUrl]: { body: { keys: [access.jwk] } }, [`https://api.cloudflare.com/client/v4/zones/${zone}/purge_cache`]: { body: { success: true } } });
  const context = await browser.newContext({ extraHTTPHeaders: access.headers('owner@example.test') }); const page = await context.newPage();
  const actor = { email: 'owner@example.test', role: 'owner' as const, modules: {} };
  const env = { DB: worker.local.database as unknown as D1Database, CONFIG: worker.local.config as unknown as KVNamespace };
  try {
    await worker.local.db.batch([{ sql: "INSERT INTO admin_users(email,role) VALUES('owner@example.test','owner')" }]);
    await applyAdminAction(env, actor, 'settings', new URLSearchParams({ key: 'ads_enabled', value: '1', revision: '0' }));
    for (const [code, revision] of [['<div data-ad-fixture>Old</div>','-1'],['<div data-ad-fixture>New</div>','0']]) await applyAdminAction(env, actor, 'ads', new URLSearchParams({ page_type: 'detail', placement: 'native', enabled: '1', code, revision }));
    await page.goto(worker.base + '/admin/changes/');
    await page.getByRole('row').filter({ hasText: 'ad_slot · detail/native' }).first().getByRole('button', { name: 'Undo', exact: true }).click();
    await expect(page.locator('.notice[role="status"]')).toContainText('Saved.');
    await page.goto(worker.base + '/movie/sample-the-quiet-atlas-1-2022/'); await expect(page.locator('[data-ad-fixture]')).toHaveText('Old');
    await applyAdminAction(env, actor, 'ads', new URLSearchParams({ page_type: 'home', placement: 'native', enabled: '1', code: '<div data-ad-fixture>Old</div>', revision: '-1' }));
    await page.goto(worker.base + '/admin/ads/'); await expect(page.getByText(/Duplicate code also used/).first()).toBeVisible();
    await page.goto(worker.base + '/admin/seo/');
    await page.getByLabel('From path', { exact: true }).fill('/owner-old-route/'); await page.getByLabel('To owned path').fill('/movies/'); await page.getByRole('button', { name: 'Save redirect', exact: true }).click();
    const moved = await context.request.get(worker.base + '/owner-old-route/', { maxRedirects: 0 }); expect(moved.status()).toBe(301); expect(moved.headers().location).toBe('/movies/');
    await page.getByLabel('google_site_verification', { exact: true }).fill('fixture-verification');
    await page.locator('form').filter({ has: page.locator('input[name="key"][value="google_site_verification"]') }).getByRole('button').click();
    await page.goto(worker.base + '/movie/sample-the-quiet-atlas-1-2022/'); await expect(page.locator('meta[name="google-site-verification"]')).toHaveAttribute('content', 'fixture-verification');
    await page.goto(worker.base + '/admin/'); await page.getByRole('button', { name: 'Retry pending propagation and purge' }).click(); await expect(page.locator('.notice[role="status"]')).toContainText('Retried');
  } finally { await context.close(); await worker.dispose(); }
});
