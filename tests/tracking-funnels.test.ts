import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import { localBindings, applyLocalSql } from '../sync/local.ts';
import { ingestPostback } from '../src/lib/tracking/postback.ts';
import { computeEpcTable } from '../src/lib/tracking/autoopt.ts';
import { parseFunnels, trackingFunnels, type TrackingFilters } from '../src/lib/admin/tracking-data.ts';

// Gate G24 — funnels + attribution (F24, docs/06).
const filters: TrackingFilters = {
  from: new Date(Date.now() - 2 * 86_400_000).toISOString().slice(0, 10),
  to: new Date(Date.now() + 86_400_000).toISOString().slice(0, 10),
  link: '', country: '', device: '', band: '', network: '', q: '',
};

async function funnelEnv() {
  const state = await mkdtemp(resolve(tmpdir(), 'screenpeek-fn-'));
  const local = await localBindings(state);
  await applyLocalSql(local.database, await readFile('db/schema.sql', 'utf8'));
  for (const file of (await readdir('db/migrations')).filter(name => name.endsWith('.sql')).sort())
    await applyLocalSql(local.database, await readFile(`db/migrations/${file}`, 'utf8'));
  await local.db.batch([
    { sql: "UPDATE config SET value='1' WHERE key='tracking_enabled'" },
    { sql: "UPDATE config SET value='3' WHERE key='tracking_attribution_window_days'" },
  ]);
  const env = { DB: local.database, TRACKING_PB_SECRET_TESTNET: 'topsecret' } as { DB: D1Database } & Record<string, unknown>;
  return { state, local, env };
}

test('G24.2 a postback past the attribution window is stored late and excluded from EPC', { timeout: 60_000 }, async () => {
  const { state, local, env } = await funnelEnv();
  try {
    await local.db.batch([
      // 5 days old: inside the 7-day EPC window, outside the 3-day attribution window.
      { sql: "INSERT INTO tr_clicks(click_id,ts,slug,country,device_type,variant_id,dest_host) VALUES('click-late',datetime('now','-5 days'),'opt-link','US','mobile',1,'example.com')" },
      { sql: "INSERT INTO tr_clicks(click_id,ts,slug,country,device_type,variant_id,dest_host) VALUES('click-fresh',datetime('now','-1 days'),'opt-link','US','mobile',2,'example.com')" },
    ]);
    const late = await ingestPostback(env, 'testnet', new URLSearchParams({ click_id: 'click-late', event: 'purchase', payout: '10.00', txid: 'TX-LATE', status: 'approved', key: 'topsecret' }));
    assert.equal(late.result, 'matched'); // stored — but as late
    const fresh = await ingestPostback(env, 'testnet', new URLSearchParams({ click_id: 'click-fresh', event: 'purchase', payout: '10.00', txid: 'TX-FRESH', status: 'approved', key: 'topsecret' }));
    assert.equal(fresh.result, 'matched');
    const rows = await local.db.query<{ click_id: string; status_mapped: string; status_raw: string }>('SELECT click_id, status_mapped, status_raw FROM tr_conversions ORDER BY click_id');
    assert.deepEqual(rows, [
      { click_id: 'click-fresh', status_mapped: 'approved', status_raw: 'approved' },
      { click_id: 'click-late', status_mapped: 'late', status_raw: 'approved' },
    ]);
    const epc = await computeEpcTable(local.database, ['US', 'GB', 'CA', 'AU']);
    const lateVariant = epc.find(row => row.variantId === 1);
    const freshVariant = epc.find(row => row.variantId === 2);
    assert.equal(lateVariant?.clicks, 1); // the click still counts
    assert.equal(lateVariant?.conversions, 0); // the late conversion does not
    assert.equal(lateVariant?.revenueMinor, 0);
    assert.equal(freshVariant?.conversions, 1);
    assert.equal(freshVariant?.revenueMinor, 1000);
  } finally { await local.dispose(); await rm(state, { recursive: true, force: true }); }
});

test('G24.1 funnel counts and step conversion rates per link from seeded data', { timeout: 60_000 }, async () => {
  const { state, local } = await funnelEnv();
  try {
    const statements: Array<{ sql: string }> = [];
    for (let i = 0; i < 4; i++) statements.push({ sql: `INSERT INTO tr_clicks(click_id,ts,slug,country,device_type) VALUES('a-${i}',datetime('now','-1 hours'),'link-a','US','mobile')` });
    for (let i = 0; i < 2; i++) statements.push({ sql: `INSERT INTO tr_clicks(click_id,ts,slug,country,device_type) VALUES('b-${i}',datetime('now','-1 hours'),'link-b','GB','desktop')` });
    for (let i = 0; i < 3; i++) statements.push({ sql: `INSERT INTO tr_conversions(click_id,network,event,payout_minor,currency,status_mapped,txid,ts_received) VALUES('a-${i}','testnet','lead',0,'USD','approved','L${i}',datetime('now'))` });
    statements.push({ sql: "INSERT INTO tr_conversions(click_id,network,event,payout_minor,currency,status_mapped,txid,ts_received) VALUES('a-0','testnet','sale',900,'USD','approved','S0',datetime('now'))" });
    statements.push({ sql: "INSERT INTO tr_conversions(click_id,network,event,payout_minor,currency,status_mapped,txid,ts_received) VALUES('b-0','testnet','lead',0,'USD','approved','L9',datetime('now'))" });
    await local.db.batch(statements);
    const json = JSON.stringify({ testnet: [{ event: 'lead', label: 'Lead' }, { event: 'sale', label: 'Sale' }] });
    const data = await trackingFunnels(local.database, filters, json, '');
    assert.equal(data.network, 'testnet');
    assert.deepEqual(data.steps.map(step => step.label), ['Lead', 'Sale']);
    const linkA = data.rows.find(row => row.slug === 'link-a');
    const linkB = data.rows.find(row => row.slug === 'link-b');
    assert.deepEqual({ clicks: linkA?.clicks, counts: linkA?.counts, rates: linkA?.rates }, { clicks: 4, counts: [3, 1], rates: [75, 33.3] });
    assert.deepEqual({ clicks: linkB?.clicks, counts: linkB?.counts, rates: linkB?.rates }, { clicks: 2, counts: [1, 0], rates: [50, 0] });
  } finally { await local.dispose(); await rm(state, { recursive: true, force: true }); }
});

test('G24.4 unconfigured networks keep single-event behaviour; malformed chains are ignored', { timeout: 60_000 }, async () => {
  assert.deepEqual(parseFunnels('{}'), []);
  assert.deepEqual(parseFunnels('{bad'), []);
  assert.deepEqual(parseFunnels('{"net":["lead","sale"]}'), [{ network: 'net', steps: [{ event: 'lead', label: 'lead' }, { event: 'sale', label: 'sale' }] }]);
  const { state, local, env } = await funnelEnv();
  try {
    const empty = await trackingFunnels(local.database, filters, '{}', '');
    assert.deepEqual(empty.rows, []);
    assert.equal(empty.network, '');
    // A funnel configured for a different network changes nothing here.
    await local.db.batch([
      { sql: "INSERT INTO tr_clicks(click_id,ts,slug,country,device_type) VALUES('click-plain',datetime('now'),'smartlink-main','US','desktop')" },
      { sql: `UPDATE config SET value='${JSON.stringify({ othernet: ['lead', 'sale'] })}' WHERE key='tracking_funnels'` },
    ]);
    const outcome = await ingestPostback(env, 'testnet', new URLSearchParams({ click_id: 'click-plain', event: 'purchase', payout: '2.00', txid: 'TX-PLAIN', status: 'approved', key: 'topsecret' }));
    assert.equal(outcome.result, 'matched');
    const rows = await local.db.query<{ status_mapped: string; event: string }>('SELECT status_mapped, event FROM tr_conversions');
    assert.deepEqual(rows, [{ status_mapped: 'approved', event: 'purchase' }]);
  } finally { await local.dispose(); await rm(state, { recursive: true, force: true }); }
});
