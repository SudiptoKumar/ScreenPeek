import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import { localBindings, applyLocalSql } from '../sync/local.ts';
import { ingestPostback, mapStatus, payoutToMinor } from '../src/lib/tracking/postback.ts';

// Gate G8 — postbacks + conversions, driven by the v1 test vectors.
const vectors = JSON.parse(await readFile('tests/fixtures/tracking-vectors.json', 'utf8')) as {
  postbacks: { case: string; params: Record<string, string> | string; expect: Record<string, unknown> }[];
};

async function postbackEnv() {
  const state = await mkdtemp(resolve(tmpdir(), 'screenpeek-pb-'));
  const local = await localBindings(state);
  await applyLocalSql(local.database, await readFile('db/schema.sql', 'utf8'));
  for (const file of (await readdir('db/migrations')).filter(name => name.endsWith('.sql')).sort())
    await applyLocalSql(local.database, await readFile(`db/migrations/${file}`, 'utf8'));
  await local.db.batch([
    { sql: "UPDATE config SET value='1' WHERE key='tracking_enabled'" },
    { sql: "INSERT INTO tr_clicks(click_id,ts,slug,country,device_type,visitor_id,session_id,sp_page,dest_host) VALUES('click-real-1','2026-11-13 01:00:00','smartlink-main','US','desktop','v1','s1','/movie/dune-part-two-2024/','example.com')" },
  ]);
  const env = { DB: local.database, TRACKING_PB_SECRET_TESTNET: 'topsecret' } as { DB: D1Database } & Record<string, unknown>;
  return { state, local, env };
}

const params = (record: Record<string, string>) => new URLSearchParams(record);

test('G8.5 status mapping defaults + config override; payout parsing', () => {
  assert.equal(mapStatus('approved', '{}'), 'approved');
  assert.equal(mapStatus('hold', '{}'), 'pending');
  assert.equal(mapStatus('declined', '{}'), 'rejected');
  assert.equal(mapStatus('chargeback', '{}'), 'rejected');
  assert.equal(mapStatus('refund', '{}'), 'refunded');
  assert.equal(mapStatus('whatever', '{}'), 'pending');
  assert.equal(mapStatus('whatever', '{"whatever":"approved"}'), 'approved');
  assert.equal(payoutToMinor('12.50'), 1250);
  assert.equal(payoutToMinor('0.1'), 10);
  assert.equal(payoutToMinor('garbage'), 0);
  assert.equal(payoutToMinor(null), 0);
});

test('G8.1-G8.4 the four fixture cases end to end', { timeout: 60_000 }, async () => {
  const { state, local, env } = await postbackEnv();
  try {
    const byCase = Object.fromEntries(vectors.postbacks.map(entry => [entry.case, entry]));
    const matchedParams = { ...(byCase.matched.params as Record<string, string>), click_id: 'click-real-1', key: 'topsecret' };
    const matched = await ingestPostback(env, 'testnet', params(matchedParams));
    assert.equal(matched.http, 200);
    assert.equal(matched.result, 'matched');
    const conversions = await local.db.query<{ status_mapped: string; payout_minor: number; currency: string; click_id: string }>('SELECT status_mapped, payout_minor, currency, click_id FROM tr_conversions');
    assert.equal(conversions.length, 1);
    assert.equal(conversions[0].status_mapped, 'approved');
    assert.equal(conversions[0].payout_minor, 1250);
    assert.equal(conversions[0].currency, 'USD');
    assert.equal(conversions[0].click_id, 'click-real-1');
    const daily = await local.db.query<{ conversions: number; revenue_minor: number; slug: string }>('SELECT conversions, revenue_minor, slug FROM tr_click_daily');
    assert.deepEqual(daily, [{ conversions: 1, revenue_minor: 1250, slug: 'smartlink-main' }]);

    const duplicate = await ingestPostback(env, 'testnet', params(matchedParams));
    assert.equal(duplicate.http, 200);
    assert.equal(duplicate.result, 'duplicate'); // G8.2
    assert.equal((await local.db.query('SELECT * FROM tr_conversions')).length, 1);
    assert.deepEqual(await local.db.query<{ conversions: number; revenue_minor: number; slug: string }>('SELECT conversions, revenue_minor, slug FROM tr_click_daily'), [{ conversions: 1, revenue_minor: 1250, slug: 'smartlink-main' }]);

    const unknown = await ingestPostback(env, 'testnet', params({ click_id: 'does-not-exist', payout: '1.00', txid: 'TX9999', key: 'topsecret' }));
    assert.equal(unknown.http, 200); // G8.4
    assert.equal(unknown.result, 'unknown_click');

    const badSecret = await ingestPostback(env, 'testnet', params({ key: 'wrong', click_id: 'click-real-1', txid: 'TX2000' }));
    assert.equal(badSecret.http, 401); // G8.3
    assert.equal(badSecret.result, 'bad_secret');

    const raw = await local.db.query<{ result: string; params_json: string }>('SELECT result, params_json FROM tr_postbacks_raw ORDER BY id');
    assert.deepEqual(raw.map(row => row.result), ['matched', 'duplicate', 'unknown_click', 'bad_secret']);
    for (const row of raw) {
      assert.ok(!row.params_json.includes('topsecret'), 'the real secret is never stored');
      assert.ok(!row.params_json.includes('"key"'), 'secret fields are stripped from the raw log');
    }
    assert.ok(!raw[3].params_json.includes('wrong'), 'even a wrong secret value is not stored');
  } finally { await local.dispose(); await rm(state, { recursive: true, force: true }); }
});
