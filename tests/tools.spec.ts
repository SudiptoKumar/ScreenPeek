import { test, expect } from '@playwright/test';
import { testWorker } from './helpers/worker.ts';
import { accessFixture } from './helpers/access.ts';

test('admin tools: global search, TTL settings, preview-as-visitor, run-any-job and purge', async ({ browser }) => {
  test.setTimeout(120_000);
  const fixture = accessFixture();
  const zone = 'b'.repeat(32);
  const worker = await testWorker({
    CF_ACCESS_TEAM_DOMAIN: fixture.team, CF_ACCESS_AUD: fixture.aud,
    GITHUB_REPO: 'owner/repo', GITHUB_ACTIONS_TOKEN: 'fixture-only',
    CLOUDFLARE_ZONE_ID: zone, CLOUDFLARE_API_TOKEN: 'fixture-only',
  }, 8790, {
    [fixture.certUrl]: { body: { keys: [fixture.jwk] } },
    'https://api.github.com/repos/owner/repo/actions/workflows/backup.yml/dispatches': { body: {}, status: 204 },
    [`https://api.cloudflare.com/client/v4/zones/${zone}/purge_cache`]: { body: { success: true } },
  });
  const context = await browser.newContext({ viewport: { width: 360, height: 800 }, extraHTTPHeaders: fixture.headers('owner@example.test') });
  const page = await context.newPage();
  try {
    await worker.local.db.batch([
      { sql: "INSERT INTO admin_users(email,role) VALUES('owner@example.test','owner'),('viewer@example.test','viewer')" },
      { sql: "INSERT INTO links(slug,name,type,destination,enabled) VALUES('tools-link','Tools Link','smartlink','https://example.com/',1)" },
    ]);
    const tools = await page.goto(`${worker.base}/admin/tools/`);
    expect(tools?.status()).toBe(200);
    await expect(page.getByRole('heading', { name: 'Tools', exact: true })).toBeVisible();
    await expect(page.getByRole('heading', { name: 'Global search' })).toBeVisible();
    await expect(page.getByRole('heading', { name: 'Preview as visitor' })).toBeVisible();
    await expect(page.getByRole('heading', { name: 'Run a job' })).toBeVisible();
    await expect(page.getByRole('heading', { name: 'Purge cache' })).toBeVisible();
    await expect(page.getByRole('link', { name: 'Tools' })).toBeVisible();

    await page.getByLabel(/Search titles, people, links, pages and redirects/).fill('Tools Link');
    await page.getByRole('button', { name: 'Search' }).click();
    const found = page.getByRole('link', { name: 'Tools Link' });
    await expect(found).toBeVisible();
    await expect(found).toHaveAttribute('href', '/admin/links/?edit=tools-link');

    await page.goto(`${worker.base}/admin/settings/`);
    const ttlForm = page.locator('form').filter({ has: page.getByLabel('List cache TTL (seconds)', { exact: true }) });
    await expect(page.getByLabel('Detail cache TTL (seconds)', { exact: true })).toBeVisible();
    await ttlForm.getByLabel('List cache TTL (seconds)', { exact: true }).fill('7200');
    await ttlForm.getByRole('button').click();
    await expect(page.locator('.notice[role="status"]')).toBeVisible();

    await page.goto(`${worker.base}/admin/tools/`);
    await page.getByRole('link', { name: 'GB', exact: true }).click();
    await page.goto(`${worker.base}/`);
    await expect(page.locator('.preview-banner')).toContainText('GB');
    expect((await context.cookies()).find(cookie => cookie.name === 'sp_preview_country')?.value).toBe('GB');
    await page.goto(`${worker.base}/admin/tools/?preview=off`);
    await page.goto(`${worker.base}/`);
    await expect(page.locator('.preview-banner')).toHaveCount(0);
    expect((await context.cookies()).find(cookie => cookie.name === 'sp_preview_country')).toBeUndefined();

    await page.goto(`${worker.base}/admin/tools/`);
    await page.getByRole('button', { name: 'Run private backup now' }).click();
    await expect(page.locator('.notice[role="status"]')).toContainText('GitHub accepted the job request');
    await expect(page.getByRole('link', { name: /Check the workflow/ })).toBeVisible();

    await page.getByRole('button', { name: 'Purge cache' }).click();
    await expect(page.locator('.notice[role="status"]')).toContainText('Full cache purge accepted');

    const viewer = await browser.newContext({ extraHTTPHeaders: fixture.headers('viewer@example.test') });
    try {
      const viewerPage = await viewer.newPage();
      expect((await viewerPage.goto(`${worker.base}/admin/tools/`))?.status()).toBe(403);
    } finally { await viewer.close(); }
  } finally { await context.close(); await worker.dispose(); }
});
