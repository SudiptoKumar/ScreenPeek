import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import { localBindings, applyLocalSql } from '../sync/local.ts';
import { parseCostRules, trackingProfit, type TrackingFilters } from '../src/lib/admin/tracking-data.ts';
import { trackingAction } from '../src/lib/admin/tracking-actions.ts';
import type { AdminIdentity } from '../src/lib/admin/access.ts';

// Gate G25 — cost, profit, ROI (F25).
const today = new Date().toISOString().slice(0, 10);
const filters: TrackingFilters = {
  from: new Date(Date.now() - 2 * 86_400_000).toISOString().slice(0, 10),
  to: new Date(Date.now() + 86_400_000).toISOString().slice(0, 10),
  link: '', country: '', device: '', band: '', network: '', q: '',
};
const owner: AdminIdentity = { email: 'owner@example.test', role: 'owner', modules: {} };

async function profitEnv() {
  const state = await mkdtemp(resolve(tmpdir(), 'screenpeek-pf-'));
  const local = await localBindings(state);
  await applyLocalSql(local.database, await readFile('db/schema.sql', 'utf8'));
  for (const file of (await readdir('db/migrations')).filter(name => name.endsWith('.sql')).sort())
    await applyLocalSql(local.database, await readFile(`db/migrations/${file}`, 'utf8'));
  const statements: Array<{ sql: string }> = [];
  for (let i = 0; i < 10; i++) statements.push({ sql: `INSERT INTO tr_clicks(click_id,ts,slug,sub1) VALUES('pa-${i}',datetime('now'),'link-a','promo-a')` });
  for (let i = 0; i < 5; i++) statements.push({ sql: `INSERT INTO tr_clicks(click_id,ts,slug,sub1) VALUES('ot-${i}',datetime('now'),'link-a','other')` });
  statements.push(
    { sql: `INSERT INTO tr_click_daily(day,slug,country,device_type,dest_host,currency,clicks,conversions,revenue_minor) VALUES('${today}','link-a','','','','USD',0,2,500)` },
    { sql: `INSERT INTO tr_click_daily(day,slug,country,device_type,dest_host,currency,clicks,conversions,revenue_minor) VALUES('${today}','link-a','','','','EUR',0,1,200)` },
    { sql: `INSERT INTO tr_click_daily(day,slug,country,device_type,dest_host,currency,clicks,conversions,revenue_minor) VALUES('${today}','link-c','','','','USD',0,1,75)` },
    { sql: `INSERT INTO tr_cost_daily(day,link_slug,source,cost_minor,currency) VALUES('${today}','link-a','agency',50,'EUR')` },
  );
  await local.db.batch(statements);
  const kv = new Map<string, string>();
  const env = {
    DB: local.database,
    CONFIG: { get: async (key: string) => kv.get(key) ?? null, put: async (key: string, value: string) => { kv.set(key, value); } } as unknown as KVNamespace,
  };
  return { state, local, env };
}

test('G25.1/G25.3/G25.4 CPC cost fills only for its token; profit is per currency; missing cost stays null', { timeout: 60_000 }, async () => {
  const { state, local } = await profitEnv();
  try {
    const rules = JSON.stringify({ 'promo-a': { cpc_minor: 10, currency: 'USD' } });
    const rows = await trackingProfit(local.database, filters, rules);
    const usd = rows.find(row => row.slug === 'link-a' && row.currency === 'USD');
    const eur = rows.find(row => row.slug === 'link-a' && row.currency === 'EUR');
    const linkC = rows.find(row => row.slug === 'link-c');
    // 10 promo-a clicks × 10 minor = 100; the 5 'other' clicks add nothing.
    assert.deepEqual(
      { revenue: usd?.revenueMinor, cost: usd?.costMinor, profit: usd?.profitMinor, roi: usd?.roiPct },
      { revenue: 500, cost: 100, profit: 400, roi: 400 });
    // EUR stands alone: revenue 200 − imported cost 50 = 150, never merged with USD.
    assert.deepEqual(
      { revenue: eur?.revenueMinor, cost: eur?.costMinor, profit: eur?.profitMinor },
      { revenue: 200, cost: 50, profit: 150 });
    assert.equal(rows.filter(row => row.slug === 'link-a').length, 2);
    // Revenue but no cost data anywhere: cost is null (the UI shows —).
    assert.equal(linkC?.revenueMinor, 75);
    assert.equal(linkC?.costMinor, null);
    assert.equal(linkC?.profitMinor, null);
    assert.equal(linkC?.roiPct, null);
    assert.equal(parseCostRules('{bad').size, 0);
    assert.equal(parseCostRules('{"t":{"cpc_minor":0,"currency":"USD"}}').size, 0); // zero CPC is no rule
  } finally { await local.dispose(); await rm(state, { recursive: true, force: true }); }
});

test('G25.2 CSV import lands valid rows and rejects bad rows with line numbers', { timeout: 60_000 }, async () => {
  const { state, local, env } = await profitEnv();
  try {
    const csv = [
      'day,link_slug,source,cost,currency',
      `${today},link-b,agency,20.00,USD`,
      `${today},link-b,agency,5.50,EUR`,
      'not-a-date,link-b,agency,1.00,USD',
      `${today},link-b,agency,-3,USD`,
      `${today},link-b,agency,1.00,US`,
    ].join('\n');
    const message = await trackingAction(env, owner, new URLSearchParams({ action: 'tracking_cost_import', csv }));
    assert.match(message, /2 rows imported/);
    assert.match(message, /3 rejected/);
    assert.match(message, /line 4 \(bad day\)/);
    assert.match(message, /line 5 \(bad cost\)/);
    assert.match(message, /line 6 \(bad currency\)/);
    const rows = await local.db.query<{ link_slug: string; cost_minor: number; currency: string }>(
      "SELECT link_slug, cost_minor, currency FROM tr_cost_daily WHERE link_slug='link-b' ORDER BY currency");
    assert.deepEqual(rows, [
      { link_slug: 'link-b', cost_minor: 550, currency: 'EUR' },
      { link_slug: 'link-b', cost_minor: 2000, currency: 'USD' },
    ]);
  } finally { await local.dispose(); await rm(state, { recursive: true, force: true }); }
});
