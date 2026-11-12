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

test('G11 lists filter and paginate; click detail shows every group with estimate labels', async ({ browser }) => {
  test.setTimeout(120_000);
  const fixture = accessFixture();
  const worker = await testWorker({ ADS_ENABLED: '0', CF_ACCESS_TEAM_DOMAIN: fixture.team, CF_ACCESS_AUD: fixture.aud }, 8790, { [fixture.certUrl]: { body: { keys: [fixture.jwk] } } });
  const context = await browser.newContext({ viewport: { width: 360, height: 800 }, extraHTTPHeaders: fixture.headers('owner@example.test') });
  const page = await context.newPage();
  const today = new Date().toISOString().slice(0, 10);
  try {
    await worker.local.db.batch([
      { sql: "INSERT INTO admin_users(email,role) VALUES('owner@example.test','owner')" },
      { sql: "UPDATE config SET value='1' WHERE key='tracking_enabled'" },
      { sql: `INSERT INTO tr_clicks(click_id,ts,slug,country,device_type,device_model,browser,dest_host,quality_band,quality_flags,visitor_id,session_id,sp_page,as_org,city,postal_code) VALUES('detail-click-1','${today} 10:00:00','smartlink-main','US','mobile','SM-S918B','Samsung Internet','offers.example.com','review','["datacentre"]','visitor-9','session-9','/movie/dune-part-two-2024/','Google Cloud','New York','10001')` },
      { sql: `INSERT INTO tr_clicks(click_id,ts,slug,country,device_type,browser,dest_host,quality_band,quality_flags) VALUES('plain-click-2','${today} 11:00:00','smartlink-main','GB','desktop','Chrome','offers.example.com','clean','[]')` },
      { sql: `INSERT INTO tr_sessions(session_id,visitor_id,started_at,last_seen_at,pageviews,entry_page,exit_page,country,device_type) VALUES('session-9','visitor-9','${today} 09:59:00','${today} 10:05:00',3,'/movie/dune-part-two-2024/','/watch/dune/','US','mobile')` },
      { sql: `INSERT INTO tr_page_daily(day,page_type,page_url,pageviews,unique_sessions,cta_clicks) VALUES('${today}','detail','/movie/dune-part-two-2024/',10,4,2)` },
      { sql: `INSERT INTO tr_conversions(click_id,network,event,payout_minor,currency,status_mapped,status_raw,txid) VALUES('detail-click-1','testnet','purchase',1250,'USD','approved','approved','TX1001')` },
    ]);
    // Clicks list: both rows; country filter narrows to one.
    await page.goto(worker.base + '/admin/tracking/?view=clicks');
    await expect(page.getByText('detail-click-1'.slice(0, 13))).toBeVisible();
    await expect(page.getByText('2 records')).toBeVisible();
    await page.goto(worker.base + `/admin/tracking/?view=clicks&country=GB&from=${today}&to=${today}`);
    await expect(page.getByText('1 records')).toBeVisible();
    // Out-of-range date shows the explained empty state.
    await page.goto(worker.base + '/admin/tracking/?view=clicks&from=2020-01-01&to=2020-01-02');
    await expect(page.getByText(/Nothing matches in this date range/)).toBeVisible();
    // Click detail: all groups + estimate labels.
    await page.goto(worker.base + '/admin/tracking/?view=clicks&click=detail-click-1');
    await expect(page.getByText('Click detail — detail-click-1')).toBeVisible();
    await expect(page.getByText('Location — IP estimate')).toBeVisible();
    await expect(page.getByText('Device & browser — best effort')).toBeVisible();
    await expect(page.getByText('New York')).toBeVisible();
    await expect(page.getByText('SM-S918B', { exact: true })).toBeVisible();
    // Pages, sessions, conversions, quality views render their rows.
    await page.goto(worker.base + '/admin/tracking/?view=pages');
    await expect(page.getByText('/movie/dune-part-two-2024/').first()).toBeVisible();
    await page.goto(worker.base + '/admin/tracking/?view=sessions');
    await expect(page.getByText('visitor-').first()).toBeVisible();
    await page.goto(worker.base + '/admin/tracking/?view=conversions');
    await expect(page.getByText('TX1001')).toBeVisible();
    await expect(page.getByText('USD 12.50')).toBeVisible();
    await page.goto(worker.base + '/admin/tracking/?view=quality');
    await expect(page.getByText('Flag counts in range')).toBeVisible();
    await expect(page.getByText('datacentre').first()).toBeVisible();
  } finally { await context.close(); await worker.dispose(); }
});

test('G12 charts render from aggregates with the raw-sample note', async ({ browser }) => {
  test.setTimeout(120_000);
  const fixture = accessFixture();
  const worker = await testWorker({ ADS_ENABLED: '0', CF_ACCESS_TEAM_DOMAIN: fixture.team, CF_ACCESS_AUD: fixture.aud }, 8790, { [fixture.certUrl]: { body: { keys: [fixture.jwk] } } });
  const context = await browser.newContext({ viewport: { width: 360, height: 800 }, extraHTTPHeaders: fixture.headers('owner@example.test') });
  const page = await context.newPage();
  const today = new Date().toISOString().slice(0, 10);
  const yesterday = new Date(Date.now() - 86_400_000).toISOString().slice(0, 10);
  try {
    await worker.local.db.batch([
      { sql: "INSERT INTO admin_users(email,role) VALUES('owner@example.test','owner')" },
      { sql: "UPDATE config SET value='1' WHERE key='tracking_enabled'" },
      { sql: `INSERT INTO tr_click_daily(day,slug,country,device_type,dest_host,currency,clicks,conversions,revenue_minor) VALUES('${yesterday}','smartlink-main','US','mobile','h','USD',40,2,500),('${today}','smartlink-main','US','mobile','h','USD',60,3,700),('${today}','smartlink-main','GB','desktop','h','USD',20,0,0)` },
      { sql: `INSERT INTO tr_page_daily(day,page_type,page_url,pageviews) VALUES('${today}','detail','/movie/x/',55)` },
      { sql: `INSERT INTO tr_clicks(click_id,ts,slug,browser,referrer_class,quality_band) VALUES('chart-click-1','${today} 08:00:00','smartlink-main','Chrome','search','clean')` },
    ]);
    await page.goto(worker.base + `/admin/tracking/?view=charts&from=${yesterday}&to=${today}`);
    await expect(page.getByRole('img', { name: 'Clicks per day chart' })).toBeVisible();
    await expect(page.getByText('raw sample 1 of 120 clicks in range')).toBeVisible();
    await expect(page.getByText(/^US — 100/)).toBeVisible();
    await expect(page.getByText(/Chrome — 1/)).toBeVisible();
    await expect(page.getByText('55').first()).toBeVisible();
  } finally { await context.close(); await worker.dispose(); }
});

test('G13 export: counts shown first, CSV excludes IP by default, over-cap refused, roles gate', async ({ browser }) => {
  test.setTimeout(120_000);
  const fixture = accessFixture();
  const worker = await testWorker({ ADS_ENABLED: '0', CF_ACCESS_TEAM_DOMAIN: fixture.team, CF_ACCESS_AUD: fixture.aud }, 8790, { [fixture.certUrl]: { body: { keys: [fixture.jwk] } } });
  const context = await browser.newContext({ viewport: { width: 360, height: 800 }, extraHTTPHeaders: fixture.headers('owner@example.test') });
  const page = await context.newPage();
  const today = new Date().toISOString().slice(0, 10);
  try {
    await worker.local.db.batch([
      { sql: "INSERT INTO admin_users(email,role) VALUES('owner@example.test','owner'),('viewer@example.test','viewer')" },
      { sql: "UPDATE config SET value='1' WHERE key='tracking_enabled'" },
      { sql: `INSERT INTO tr_clicks(click_id,ts,slug,ip,country,browser) VALUES('export-click-1','${today} 09:00:00','smartlink-main','203.0.113.9','US','Chrome')` },
    ]);
    await page.goto(worker.base + '/admin/tracking/?view=export');
    await expect(page.getByText('Export centre')).toBeVisible();
    await expect(page.getByRole('button', { name: 'Download export' })).toBeVisible();
    // CSV download without IP.
    const downloadPromise = page.waitForEvent('download');
    await page.getByRole('button', { name: 'Download export' }).click();
    const download = await downloadPromise;
    expect(download.suggestedFilename()).toMatch(/^screenpeek-clicks-\d{8}\.csv$/);
    const path = await download.path();
    const csv = await import('node:fs').then(fs => fs.readFileSync(path!, 'utf8'));
    expect(csv).toContain('export-click-1');
    expect(csv).not.toContain('203.0.113.9');
    expect(csv.split('\n')[0]).not.toContain(',ip,');
    const jobs = await worker.local.db.query('SELECT dataset, row_count, filters_json FROM tr_export_jobs');
    expect(jobs.length).toBe(1);
    expect(jobs[0].dataset).toBe('clicks');
    expect(jobs[0].row_count).toBe(1);
    expect(JSON.parse(String(jobs[0].filters_json)).ip_included).toBe(false);
    // Direct API-style fetch: JSON format works too.
    const jsonResponse = await fetch(`${worker.base}/admin/tracking/?texport=1&dataset=clicks&format=json&from=${today}&to=${today}`, { headers: fixture.headers('owner@example.test') });
    expect(jsonResponse.headers.get('Content-Type')).toContain('application/json');
    const parsed = JSON.parse(await jsonResponse.text());
    expect(parsed[0].click_id).toBe('export-click-1');
    expect(parsed[0].ip).toBeUndefined();
    // Viewer cannot export.
    const viewerResponse = await fetch(`${worker.base}/admin/tracking/?texport=1&dataset=clicks&from=${today}&to=${today}`, { headers: fixture.headers('viewer@example.test') });
    expect(viewerResponse.status).toBe(403);
  } finally { await context.close(); await worker.dispose(); }
});

test('G14 settings save + validate, tools: UA tester, postback tester, purge, retention dry run', async ({ browser }) => {
  test.setTimeout(120_000);
  const fixture = accessFixture();
  const worker = await testWorker({ ADS_ENABLED: '0', CF_ACCESS_TEAM_DOMAIN: fixture.team, CF_ACCESS_AUD: fixture.aud, TRACKING_PB_SECRET_TESTNET: 'tester-secret' }, 8790, { [fixture.certUrl]: { body: { keys: [fixture.jwk] } } });
  const context = await browser.newContext({ viewport: { width: 360, height: 800 }, extraHTTPHeaders: fixture.headers('owner@example.test') });
  const page = await context.newPage();
  try {
    await worker.local.db.batch([
      { sql: "INSERT INTO admin_users(email,role) VALUES('owner@example.test','owner'),('editor@example.test','editor')" },
      { sql: "UPDATE config SET value='1' WHERE key='tracking_enabled'" },
      { sql: "INSERT INTO tr_clicks(click_id,ts,slug,is_test) VALUES('old-real-click','2020-01-01 00:00:00','smartlink-main',0)" },
    ]);
    // Settings page renders every field with help text.
    await page.goto(worker.base + '/admin/tracking/?view=settings');
    await expect(page.getByText('Tracking enabled')).toBeVisible();
    await expect(page.getByText('Tier-1 countries')).toBeVisible();
    await expect(page.getByRole('button', { name: 'Save tracking settings' })).toBeVisible();
    // Save a change via POST.
    const saveResponse = await fetch(worker.base + '/admin/tracking/?view=settings', {
      method: 'POST', redirect: 'manual',
      headers: { ...fixture.headers('owner@example.test'), 'Content-Type': 'application/x-www-form-urlencoded', Origin: worker.base },
      body: new URLSearchParams({ action: 'tracking_settings', tracking_daily_cap: '2500', tracking_tier1_countries: 'US, GB', tracking_enabled: '1', tracking_consent_mode: 'basic', tracking_ip_mode: 'masked' }),
    });
    expect(saveResponse.status).toBe(303);
    const cap = await worker.local.db.query("SELECT value FROM config WHERE key='tracking_daily_cap'");
    expect(cap).toEqual([{ value: '2500' }]);
    const tier1 = await worker.local.db.query("SELECT value FROM config WHERE key='tracking_tier1_countries'");
    expect(tier1).toEqual([{ value: 'US,GB' }]);
    // Invalid value is refused with a plain error.
    const badResponse = await fetch(worker.base + '/admin/tracking/?view=settings', {
      method: 'POST',
      headers: { ...fixture.headers('owner@example.test'), 'Content-Type': 'application/x-www-form-urlencoded', Origin: worker.base },
      body: new URLSearchParams({ action: 'tracking_settings', tracking_daily_cap: '5' }),
    });
    expect(await badResponse.text()).toContain('between 100 and 100000');
    // Editor cannot save tracking settings (owner-only).
    const editorResponse = await fetch(worker.base + '/admin/tracking/?view=settings', {
      method: 'POST',
      headers: { ...fixture.headers('editor@example.test'), 'Content-Type': 'application/x-www-form-urlencoded', Origin: worker.base },
      body: new URLSearchParams({ action: 'tracking_settings', tracking_daily_cap: '2000' }),
    });
    expect(await editorResponse.text()).toContain('owner-only');
    // UA tester parses a pasted agent.
    await page.goto(worker.base + '/admin/tracking/?view=tools&ua=' + encodeURIComponent('Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Mobile/15E148 Safari/604.1'));
    await expect(page.getByText(/Safari 17 · OS iOS/)).toBeVisible();
    // Postback tester records a test conversion; purge removes test rows only.
    const testResponse = await fetch(worker.base + '/admin/tracking/?view=tools', {
      method: 'POST', redirect: 'manual',
      headers: { ...fixture.headers('owner@example.test'), 'Content-Type': 'application/x-www-form-urlencoded', Origin: worker.base },
      body: new URLSearchParams({ action: 'tracking_postback_test', network: 'testnet', event: 'purchase', payout: '2.50', status: 'approved' }),
    });
    expect(testResponse.status).toBe(303);
    const conversions = await worker.local.db.query('SELECT click_id, is_test, payout_minor FROM tr_conversions');
    expect(conversions).toEqual([{ click_id: 'test-click-tester', is_test: 1, payout_minor: 250 }]);
    const purgeResponse = await fetch(worker.base + '/admin/tracking/?view=tools', {
      method: 'POST', redirect: 'manual',
      headers: { ...fixture.headers('owner@example.test'), 'Content-Type': 'application/x-www-form-urlencoded', Origin: worker.base },
      body: new URLSearchParams({ action: 'tracking_purge_test' }),
    });
    expect(purgeResponse.status).toBe(303);
    expect(await worker.local.db.query('SELECT COUNT(*) AS count FROM tr_conversions')).toEqual([{ count: 0 }]);
    expect(await worker.local.db.query('SELECT COUNT(*) AS count FROM tr_clicks')).toEqual([{ count: 1 }]);
    // Retention dry run counts the ancient real click, deletes nothing.
    const retentionResponse = await fetch(worker.base + '/admin/tracking/?view=tools', {
      method: 'POST', redirect: 'manual',
      headers: { ...fixture.headers('owner@example.test'), 'Content-Type': 'application/x-www-form-urlencoded', Origin: worker.base },
      body: new URLSearchParams({ action: 'tracking_retention', dry_run: '1' }),
    });
    expect(retentionResponse.status).toBe(303);
    expect(await worker.local.db.query('SELECT COUNT(*) AS count FROM tr_clicks')).toEqual([{ count: 1 }]);
  } finally { await context.close(); await worker.dispose(); }
});
