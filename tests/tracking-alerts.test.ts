import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer, type Server } from 'node:http';
import { mkdtemp, readFile, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import { localBindings, applyLocalSql } from '../sync/local.ts';
import { dispatchUnsent, evaluateAlerts, raiseAlert } from '../src/lib/tracking/alerts.ts';
import { recordCapAlerts } from '../src/lib/tracking/routing.ts';
import { runLinkHealth } from '../src/lib/tracking/health.ts';
import { buildWeeklyReport, sendWeeklyReport } from '../src/lib/tracking/report.ts';
import { trackingCharts, type TrackingFilters } from '../src/lib/admin/tracking-data.ts';
import { authorizeInsightApi, insightClicks, insightStats, type InsightApiFilters } from '../src/lib/tracking/api.ts';

// Gate G26 — alerts, weekly report, reporting API, link health (F26).
let server: Server;
let port = 0;
test.before(async () => {
  server = createServer((request, response) => {
    if ((request.url || '').startsWith('/dead')) { response.writeHead(500); response.end('no'); return; }
    response.writeHead(200); response.end('ok');
  });
  await new Promise<void>(done => server.listen(0, '127.0.0.1', done));
  port = (server.address() as { port: number }).port;
});
test.after(async () => { server.closeAllConnections(); await new Promise(done => server.close(done)); });

async function alertEnv() {
  const state = await mkdtemp(resolve(tmpdir(), 'screenpeek-al-'));
  const local = await localBindings(state);
  await applyLocalSql(local.database, await readFile('db/schema.sql', 'utf8'));
  for (const file of (await readdir('db/migrations')).filter(name => name.endsWith('.sql')).sort())
    await applyLocalSql(local.database, await readFile(`db/migrations/${file}`, 'utf8'));
  await local.db.batch([{ sql: "UPDATE config SET value='1' WHERE key='tracking_enabled'" }]);
  const kv = new Map<string, string>();
  const env = {
    DB: local.database,
    CONFIG: { get: async (key: string) => kv.get(key) ?? null, put: async (key: string, value: string) => { kv.set(key, value); } } as unknown as KVNamespace,
    MONEY_BOT_TOKEN: 'test-token', MONEY_BOT_CHAT_ID: '4242',
  };
  return { state, local, env };
}

const today = new Date().toISOString().slice(0, 10);
const dayAgo = (days: number) => new Date(Date.now() - days * 86_400_000).toISOString().slice(0, 10);

test('G26.1 alert dedupe: 50 cap hits and repeated raises leave exactly one row per event per day', { timeout: 60_000 }, async () => {
  const { state, local, env } = await alertEnv();
  try {
    for (let i = 0; i < 50; i++) await recordCapAlerts(env, 'smartlink-main', [7], new Date());
    let rows = await local.db.query<{ kind: string; ref: string }>('SELECT kind, ref FROM tr_alerts');
    assert.deepEqual(rows, [{ kind: 'cap_hit', ref: 'smartlink-main#7' }]);
    assert.equal(await raiseAlert(env, 'cr_drop', 'link-x', 'first'), true);
    assert.equal(await raiseAlert(env, 'cr_drop', 'link-x', 'second'), false);
    rows = await local.db.query('SELECT * FROM tr_alerts');
    assert.equal(rows.length, 2);
    // With telegram configured, dispatch marks rows sent exactly once.
    await local.db.batch([{ sql: "UPDATE config SET value='telegram' WHERE key='tracking_alert_channels'" }]);
    const okFetcher = (async () => new Response(JSON.stringify({ ok: true }), { status: 200 })) as typeof fetch;
    assert.equal(await dispatchUnsent(env, okFetcher), 2);
    assert.equal(await dispatchUnsent(env, okFetcher), 0);
    const sent = await local.db.query<{ sent: number }>('SELECT sent FROM tr_alerts ORDER BY id');
    assert.deepEqual(sent, [{ sent: 1 }, { sent: 1 }]);
  } finally { await local.dispose(); await rm(state, { recursive: true, force: true }); }
});

test('G26.2 CR-drop alert fires on a -60% day and stays quiet on a -10% day', { timeout: 60_000 }, async () => {
  const seed = async (local: Awaited<ReturnType<typeof localBindings>>, todayConversions: number) => {
    const statements: Array<{ sql: string }> = [
      { sql: `INSERT INTO tr_click_daily(day,slug,country,device_type,dest_host,currency,clicks,conversions,revenue_minor) VALUES('${today}','top-link','','','','',100,${todayConversions},0)` },
    ];
    for (let d = 1; d <= 7; d++) statements.push({ sql: `INSERT INTO tr_click_daily(day,slug,country,device_type,dest_host,currency,clicks,conversions,revenue_minor) VALUES('${dayAgo(d)}','top-link','','','','',100,10,0)` });
    await local.db.batch(statements);
  };
  const dropped = await alertEnv();
  try {
    await seed(dropped.local, 4); // 4% vs 10% average = -60%
    const result = await evaluateAlerts(dropped.env);
    assert.deepEqual(result.raised, ['cr_drop']);
    const rows = await dropped.local.db.query<{ kind: string; ref: string }>('SELECT kind, ref FROM tr_alerts');
    assert.deepEqual(rows, [{ kind: 'cr_drop', ref: 'top-link' }]);
  } finally { await dropped.local.dispose(); await rm(dropped.state, { recursive: true, force: true }); }
  const steady = await alertEnv();
  try {
    await seed(steady.local, 9); // 9% vs 10% average = -10%
    const result = await evaluateAlerts(steady.env);
    assert.deepEqual(result.raised, []);
    assert.equal((await steady.local.db.query('SELECT * FROM tr_alerts')).length, 0);
  } finally { await steady.local.dispose(); await rm(steady.state, { recursive: true, force: true }); }
});

test('G26.3 weekly report numbers equal the aggregate numbers for the same range, and it sends once a week', { timeout: 60_000 }, async () => {
  const { state, local, env } = await alertEnv();
  try {
    const statements: Array<{ sql: string }> = [];
    for (let d = 0; d < 7; d++) {
      statements.push({ sql: `INSERT INTO tr_click_daily(day,slug,country,device_type,dest_host,currency,clicks,conversions,revenue_minor) VALUES('${dayAgo(d)}','link-a','US','','','USD',${10 + d},${d},${d * 100})` });
      statements.push({ sql: `INSERT INTO tr_page_daily(day,page_url,page_type,pageviews,unique_sessions) VALUES('${dayAgo(d)}','/','home',${20 + d},${5 + d})` });
    }
    await local.db.batch(statements);
    const filters: TrackingFilters = { from: dayAgo(6), to: today, link: '', country: '', device: '', band: '', network: '', q: '' };
    const charts = await trackingCharts({ DB: local.database }, filters);
    const expected = {
      clicks: charts.days.reduce((sum, day) => sum + day.clicks, 0),
      conversions: charts.days.reduce((sum, day) => sum + day.conversions, 0),
      revenueMinor: charts.days.reduce((sum, day) => sum + day.revenueMinor, 0),
      pageviews: charts.days.reduce((sum, day) => sum + day.pageviews, 0),
    };
    const built = await buildWeeklyReport({ DB: local.database });
    assert.deepEqual(built.totals, expected);
    assert.match(built.text, new RegExp(`Clicks: ${expected.clicks}`));
    // Send gating: wrong day skips; the right day sends once, then the marker blocks a repeat.
    const weekday = ['sunday', 'monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday'][new Date().getUTCDay()];
    await local.db.batch([
      { sql: "UPDATE config SET value='telegram' WHERE key='tracking_alert_channels'" },
      { sql: `UPDATE config SET value='${weekday === 'monday' ? 'tuesday' : 'monday'}' WHERE key='tracking_report_day'` },
    ]);
    const okFetcher = (async () => new Response(JSON.stringify({ ok: true }), { status: 200 })) as typeof fetch;
    assert.equal((await sendWeeklyReport(env, okFetcher)).reason, 'not_report_day');
    await local.db.batch([{ sql: `UPDATE config SET value='${weekday}' WHERE key='tracking_report_day'` }]);
    const sent = await sendWeeklyReport(env, okFetcher);
    assert.equal(sent.sent, true);
    assert.deepEqual(sent.totals, expected);
    assert.equal((await sendWeeklyReport(env, okFetcher)).reason, 'already_sent_this_week');
  } finally { await local.dispose(); await rm(state, { recursive: true, force: true }); }
});

test('G26.4 reporting API: disabled without a key secret, 401 without the key, capped clicks with the message', { timeout: 120_000 }, async () => {
  const { state, local } = await alertEnv();
  try {
    const apiEnv = { DB: local.database } as { DB: D1Database } & Record<string, unknown>;
    const request = (key?: string) => new Request('https://screenpeek.test/api/insight/stats', key ? { headers: { 'X-Insight-Key': key } } : {});
    const authStatus = async (key?: string) => {
      const result = await authorizeInsightApi(apiEnv, request(key));
      return result.ok ? 200 : result.status;
    };
    // No secret name configured at all → disabled (404).
    assert.equal(await authStatus(), 404);
    await local.db.batch([{ sql: "UPDATE config SET value='TRACKING_API_KEY' WHERE key='tracking_api_key'" }]);
    // Name configured but the secret itself does not exist → still disabled.
    assert.equal(await authStatus('anything'), 404);
    apiEnv.TRACKING_API_KEY = 'the-real-key';
    assert.equal(await authStatus(), 401);
    assert.equal(await authStatus('wrong'), 401);
    assert.equal(await authStatus('the-real-key'), 200);
    // Stats match the seeded aggregates.
    await local.db.batch([
      { sql: `INSERT INTO tr_click_daily(day,slug,country,device_type,dest_host,currency,clicks,conversions,revenue_minor) VALUES('${today}','link-a','','','','USD',40,3,250)` },
      { sql: `INSERT INTO tr_page_daily(day,page_url,page_type,pageviews,unique_sessions) VALUES('${today}','/','home',90,30)` },
    ]);
    const filters: InsightApiFilters = { from: today, to: today, link: '', country: '', device: '' };
    const stats = await insightStats(local.database, filters);
    assert.equal(stats.totals.clicks, 40);
    assert.equal(stats.totals.conversions, 3);
    assert.deepEqual(stats.totals.revenueByCurrency, [{ currency: 'USD', revenueMinor: 250 }]);
    assert.equal(stats.totals.pageviews, 90);
    // Clicks cap: 3,005 stored rows come back as 3,000 + the cap message, IPs stripped.
    await local.db.batch([{ sql: `WITH RECURSIVE gen(n) AS (SELECT 1 UNION ALL SELECT n+1 FROM gen WHERE n < 3005)
      INSERT INTO tr_clicks(click_id,ts,slug,ip) SELECT 'cap-' || n, datetime('now'), 'cap-link', '203.0.113.7' FROM gen` }]);
    const clicks = await insightClicks(local.database, { ...filters, link: 'cap-link' });
    assert.equal(clicks.total, 3005);
    assert.equal(clicks.rows.length, 3000);
    assert.equal(clicks.capped, true);
    assert.match(clicks.message || '', /capped at 3,000 rows/);
    assert.equal('ip' in (clicks.rows[0] as Record<string, unknown>), false);
  } finally { await local.dispose(); await rm(state, { recursive: true, force: true }); }
});

test('G26.5 a dead destination is flagged only after two consecutive failed days', { timeout: 60_000 }, async () => {
  const { state, local, env } = await alertEnv();
  try {
    await local.db.batch([
      { sql: 'DELETE FROM links' },
      { sql: 'DELETE FROM tr_link_variants' },
      { sql: "INSERT INTO links(slug,name,destination,type,enabled) VALUES('dead-link','Dead','https://fixture.test/dead','other',1)" },
      { sql: "INSERT INTO links(slug,name,destination,type,enabled) VALUES('live-link','Live','https://fixture.test/live','other',1)" },
    ]);
    // Destinations must be https in this system, so the probe runs
    // against a stub fetcher keyed by path (real HTTP fetch behaviour
    // is covered by the G23 fixture-server tests).
    const stubFetcher = (async (url: string) => new Response('x', { status: String(url).includes('/dead') ? 500 : 200 })) as typeof fetch;
    const day1 = await runLinkHealth(env, stubFetcher, new Date());
    assert.equal(day1.checked, 2);
    assert.deepEqual(day1.dead, []); // one bad day is recorded, not flagged
    const day2 = await runLinkHealth(env, stubFetcher, new Date(Date.now() + 86_400_000));
    assert.deepEqual(day2.dead.map(target => target.slug), ['dead-link']);
    const alerts = await local.db.query<{ kind: string; ref: string }>('SELECT kind, ref FROM tr_alerts');
    assert.deepEqual(alerts, [{ kind: 'dead_link', ref: 'dead-link' }]);
    const health = await local.db.query<{ link_slug: string; ok: number }>('SELECT link_slug, ok FROM tr_link_health ORDER BY link_slug, day');
    assert.deepEqual(health, [
      { link_slug: 'dead-link', ok: 0 }, { link_slug: 'dead-link', ok: 0 },
      { link_slug: 'live-link', ok: 1 }, { link_slug: 'live-link', ok: 1 },
    ]);
  } finally { await local.dispose(); await rm(state, { recursive: true, force: true }); }
});
