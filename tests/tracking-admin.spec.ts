import { test, expect } from '@playwright/test';
import { testWorker } from './helpers/worker.ts';
import { accessFixture } from './helpers/access.ts';

// Gate G10 — admin Tracking shell + Overview with seeded data.
test('G10.1-G10.4 overview renders real numbers; off state explains; roles gate the module', async ({ browser }) => {
  test.setTimeout(120_000);
  const fixture = accessFixture();
  const worker = await testWorker({ ADS_ENABLED: '0', CF_ACCESS_TEAM_DOMAIN: fixture.team, CF_ACCESS_AUD: fixture.aud }, 8790, { [fixture.certUrl]: { body: { keys: [fixture.jwk] } } });
  const owner = await browser.newContext({ viewport: { width: 360, height: 800 }, extraHTTPHeaders: fixture.headers('owner@example.test') });
  const page = await owner.newPage();
  try {
    await worker.local.db.batch([
      { sql: "INSERT INTO admin_users(email,role) VALUES('owner@example.test','owner'),('viewer@example.test','viewer')" },
      { sql: "INSERT INTO admin_users(email,role,modules) VALUES('blocked@example.test','owner','{\"tracking\":false}')" },
      { sql: "UPDATE config SET value='1' WHERE key='tracking_enabled'" },
      { sql: "INSERT INTO links(slug,name,destination,type,enabled) VALUES('insight-admin-link','Insight Link','https://example.com/offer','smartlink',1)" },
    ]);
    for (let i = 0; i < 2; i++) await fetch(worker.base + '/go/insight-admin-link/', { redirect: 'manual' });
    await expect.poll(async () => (await worker.local.db.query<{ count: number }>('SELECT COUNT(*) AS count FROM tr_clicks'))[0]?.count, { timeout: 15_000 }).toBe(2);

    const response = await page.goto(worker.base + '/admin/tracking/');
    expect(response?.status()).toBe(200);
    await expect(page.getByRole('heading', { name: 'Tracking', exact: true })).toBeVisible();
    await expect(page.getByText('Stored raw 2 of 2 total today')).toBeVisible(); // quota widget, docs/02 wording
    await expect(page.getByText('Live feed — latest clicks')).toBeVisible();
    await expect(page.getByText('example.com').first()).toBeVisible();
    await expect(page.getByText('insight-admin-link').first()).toBeVisible();

    // Off state: the section explains itself instead of showing zeros.
    await worker.local.db.batch([{ sql: "UPDATE config SET value='0' WHERE key='tracking_enabled'" }]);
    await page.reload();
    await expect(page.getByText('Tracking is off')).toBeVisible();
    await worker.local.db.batch([{ sql: "UPDATE config SET value='1' WHERE key='tracking_enabled'" }]);

    // Viewer role can read the section.
    const viewer = await browser.newContext({ viewport: { width: 360, height: 800 }, extraHTTPHeaders: fixture.headers('viewer@example.test') });
    const viewerPage = await viewer.newPage();
    try {
      expect((await viewerPage.goto(worker.base + '/admin/tracking/'))?.status()).toBe(200);
      await expect(viewerPage.getByRole('heading', { name: 'Tracking', exact: true })).toBeVisible();
    } finally { await viewer.close(); }

    // A per-user module disable closes it even for an owner role.
    const blocked = await browser.newContext({ extraHTTPHeaders: fixture.headers('blocked@example.test') });
    try {
      const denied = await blocked.request.get(worker.base + '/admin/tracking/');
      expect(denied.status()).toBe(403);
    } finally { await blocked.close(); }
  } finally { await owner.close(); await worker.dispose(); }
});

test('G10.3 empty state says why when nothing has been recorded', async ({ browser }) => {
  const fixture = accessFixture();
  const worker = await testWorker({ ADS_ENABLED: '0', CF_ACCESS_TEAM_DOMAIN: fixture.team, CF_ACCESS_AUD: fixture.aud }, 8790, { [fixture.certUrl]: { body: { keys: [fixture.jwk] } } });
  const context = await browser.newContext({ viewport: { width: 360, height: 800 }, extraHTTPHeaders: fixture.headers('owner@example.test') });
  const page = await context.newPage();
  try {
    await worker.local.db.batch([
      { sql: "INSERT INTO admin_users(email,role) VALUES('owner@example.test','owner')" },
      { sql: "UPDATE config SET value='1' WHERE key='tracking_enabled'" },
    ]);
    await page.goto(worker.base + '/admin/tracking/');
    await expect(page.getByText(/No clicks recorded yet today/)).toBeVisible();
    await expect(page.getByText(/No postbacks received in the last 24 hours/)).toBeVisible();
  } finally { await context.close(); await worker.dispose(); }
});
