import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import { localBindings, applyLocalSql } from '../sync/local.ts';
import { ingestPixel } from '../src/lib/tracking/pixel.ts';

// Gate G22 — browser pixel conversions (F22, docs/06).
async function pixelEnv() {
  const state = await mkdtemp(resolve(tmpdir(), 'screenpeek-px-'));
  const local = await localBindings(state);
  await applyLocalSql(local.database, await readFile('db/schema.sql', 'utf8'));
  for (const file of (await readdir('db/migrations')).filter(name => name.endsWith('.sql')).sort())
    await applyLocalSql(local.database, await readFile(`db/migrations/${file}`, 'utf8'));
  await local.db.batch([
    { sql: "UPDATE config SET value='1' WHERE key='tracking_enabled'" },
    // One directly addressable click, plus two clicks from one visitor
    // (older + newer) for the cookie-attribution fallback.
    { sql: "INSERT INTO tr_clicks(click_id,ts,slug,country,device_type,visitor_id,session_id,dest_host) VALUES('click-px-1',datetime('now','-1 hours'),'smartlink-main','US','desktop','visitor-a','s1','example.com')" },
    { sql: "INSERT INTO tr_clicks(click_id,ts,slug,country,device_type,visitor_id,session_id,dest_host) VALUES('click-old',datetime('now','-5 days'),'link-old','GB','mobile','visitor-b','s2','old.example.com')" },
    { sql: "INSERT INTO tr_clicks(click_id,ts,slug,country,device_type,visitor_id,session_id,dest_host) VALUES('click-new',datetime('now','-2 hours'),'link-new','GB','mobile','visitor-b','s3','new.example.com')" },
    { sql: "INSERT INTO tr_clicks(click_id,ts,slug,country,device_type,visitor_id,session_id,dest_host) VALUES('click-ancient',datetime('now','-40 days'),'link-old','GB','mobile','visitor-c','s4','old.example.com')" },
  ]);
  const kv = new Map<string, string>();
  const env = {
    DB: local.database,
    CONFIG: {
      get: async (key: string) => kv.get(key) ?? null,
      put: async (key: string, value: string) => { kv.set(key, value); },
    } as unknown as KVNamespace,
  };
  return { state, local, env };
}

const request = (cookie?: string) => new Request('https://screenpeek.test/api/pixel/testnet', {
  headers: { 'CF-Connecting-IP': '203.0.113.9', ...(cookie ? { Cookie: cookie } : {}) },
});
const params = (record: Record<string, string>) => new URLSearchParams(record);

test('G22.1 explicit cid stores a pixel conversion and updates the daily aggregate', { timeout: 60_000 }, async () => {
  const { state, local, env } = await pixelEnv();
  try {
    const outcome = await ingestPixel(env, 'testnet', request(), params({ cid: 'click-px-1', event: 'purchase', payout: '7.25', cur: 'USD', txid: 'PX100' }));
    assert.equal(outcome.status, 200);
    assert.equal(outcome.result, 'matched');
    const rows = await local.db.query<{ source: string; status_mapped: string; payout_minor: number; click_id: string }>('SELECT source, status_mapped, payout_minor, click_id FROM tr_conversions');
    assert.equal(rows.length, 1);
    assert.equal(rows[0].source, 'pixel');
    assert.equal(rows[0].status_mapped, 'approved');
    assert.equal(rows[0].payout_minor, 725);
    assert.equal(rows[0].click_id, 'click-px-1');
    const daily = await local.db.query<{ conversions: number; revenue_minor: number }>('SELECT conversions, revenue_minor FROM tr_click_daily');
    assert.deepEqual(daily, [{ conversions: 1, revenue_minor: 725 }]);
  } finally { await local.dispose(); await rm(state, { recursive: true, force: true }); }
});

test('G22.2 a repeated pixel fire dedupes on (click, txid, event)', { timeout: 60_000 }, async () => {
  const { state, local, env } = await pixelEnv();
  try {
    const fire = params({ cid: 'click-px-1', event: 'purchase', payout: '7.25', cur: 'USD', txid: 'PX100' });
    assert.equal((await ingestPixel(env, 'testnet', request(), fire)).result, 'matched');
    const again = await ingestPixel(env, 'testnet', request(), fire);
    assert.equal(again.result, 'duplicate');
    assert.equal((await local.db.query('SELECT * FROM tr_conversions')).length, 1);
  } finally { await local.dispose(); await rm(state, { recursive: true, force: true }); }
});

test('G22.3 cookie fallback attributes by mode: last takes the newest click, first the oldest', { timeout: 60_000 }, async () => {
  const { state, local, env } = await pixelEnv();
  try {
    const last = await ingestPixel(env, 'testnet', request('sp_vid=visitor-b'), params({ event: 'signup', payout: '1.00', txid: 'PX200' }));
    assert.equal(last.result, 'matched');
    let rows = await local.db.query<{ click_id: string }>('SELECT click_id FROM tr_conversions');
    assert.deepEqual(rows, [{ click_id: 'click-new' }]); // default mode = last
    await local.db.batch([
      { sql: "UPDATE config SET value='first' WHERE key='tracking_attribution_mode'" },
      { sql: 'DELETE FROM tr_conversions' },
    ]);
    const first = await ingestPixel(env, 'testnet', request('sp_vid=visitor-b'), params({ event: 'signup', payout: '1.00', txid: 'PX201' }));
    assert.equal(first.result, 'matched');
    rows = await local.db.query<{ click_id: string }>('SELECT click_id FROM tr_conversions');
    assert.deepEqual(rows, [{ click_id: 'click-old' }]);
  } finally { await local.dispose(); await rm(state, { recursive: true, force: true }); }
});

test('G22.4 no cid and no usable cookie: unmatched, nothing stored, raw-logged', { timeout: 60_000 }, async () => {
  const { state, local, env } = await pixelEnv();
  try {
    const outcome = await ingestPixel(env, 'testnet', request(), params({ event: 'purchase', payout: '3.00', txid: 'PX300' }));
    assert.equal(outcome.status, 200);
    assert.equal(outcome.result, 'unmatched');
    // A visitor whose only click is outside the 30-day window is unmatched too.
    const stale = await ingestPixel(env, 'testnet', request('sp_vid=visitor-c'), params({ event: 'purchase', txid: 'PX301' }));
    assert.equal(stale.result, 'unmatched');
    assert.equal((await local.db.query('SELECT * FROM tr_conversions')).length, 0);
    const raw = await local.db.query<{ result: string; params_json: string }>('SELECT result, params_json FROM tr_postbacks_raw ORDER BY id');
    assert.equal(raw.length, 2);
    assert.equal(raw[0].result, 'unmatched_pixel');
    assert.match(raw[0].params_json, /"source":"pixel"/);
  } finally { await local.dispose(); await rm(state, { recursive: true, force: true }); }
});

test('G22.5 dark: tracking off answers 404 and stores nothing', { timeout: 60_000 }, async () => {
  const { state, local, env } = await pixelEnv();
  try {
    await local.db.batch([{ sql: "UPDATE config SET value='0' WHERE key='tracking_enabled'" }]);
    const outcome = await ingestPixel(env, 'testnet', request(), params({ cid: 'click-px-1', event: 'purchase', payout: '7.25', txid: 'PX100' }));
    assert.equal(outcome.status, 404);
    assert.equal(outcome.result, 'dark');
    assert.equal((await local.db.query('SELECT * FROM tr_conversions')).length, 0);
    assert.equal((await local.db.query('SELECT * FROM tr_postbacks_raw')).length, 0);
  } finally { await local.dispose(); await rm(state, { recursive: true, force: true }); }
});
