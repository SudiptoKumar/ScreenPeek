import test from 'node:test';
import assert from 'node:assert/strict';
import { gzipSync } from 'node:zlib';
import { mkdtemp, readFile, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import { localBindings, applyLocalSql } from '../sync/local.ts';
import { sanitizeBeacon, ingestBeacon } from '../src/lib/tracking/beacon.ts';

// Gates G7.2/G7.3 (sanitizer) + G7.1/G7.4/G7.5 (ingestion over a real D1).
const vectors = JSON.parse(await readFile('tests/fixtures/tracking-vectors.json', 'utf8')) as {
  beacon_payloads: { valid_pageview: Record<string, unknown>; invalid_unknown_keys: Record<string, unknown> };
};

test('G6.1/F17 beacon asset stays inside its gzip budget (2 KB at F6, 3 KB with the F17 signals)', async () => {
  const source = await readFile('public/sp-beacon.js');
  const size = gzipSync(source).length;
  assert.ok(size <= 3072, `beacon gz size ${size} exceeds 3072`);
  const text = source.toString('utf8');
  for (const marker of ['getBattery', 'mediaDevices', 'RTCPeerConnection', 'OfflineAudioContext', 'requestAdapter', 'webdriver', 'plugins']) {
    assert.ok(text.includes(marker), `beacon is missing the ${marker} collector`);
  }
});

test('G7.3 unknown payload keys are dropped by the sanitizer', () => {
  const clean = sanitizeBeacon(vectors.beacon_payloads.invalid_unknown_keys);
  assert.ok(clean);
  const flat = JSON.stringify(clean);
  assert.ok(!flat.includes('email'));
  assert.ok(!flat.includes('gps'));
  assert.equal(clean.type, 'pageview');
  assert.equal(sanitizeBeacon({ type: 'form_submit', email: 'x@example.com' }), null);
  assert.equal(sanitizeBeacon('junk'), null);
  assert.equal(sanitizeBeacon(null), null);
});

async function beaconEnv() {
  const state = await mkdtemp(resolve(tmpdir(), 'screenpeek-beacon-'));
  const local = await localBindings(state);
  await applyLocalSql(local.database, await readFile('db/schema.sql', 'utf8'));
  for (const file of (await readdir('db/migrations')).filter(name => name.endsWith('.sql')).sort())
    await applyLocalSql(local.database, await readFile(`db/migrations/${file}`, 'utf8'));
  await local.db.batch([{ sql: "UPDATE config SET value='1' WHERE key='tracking_enabled'" }]);
  const kv = new Map<string, string>();
  const env = {
    DB: local.database,
    CONFIG: {
      get: async (key: string) => kv.get(key) ?? null,
      put: async (key: string, value: string) => { kv.set(key, value); },
    } as unknown as KVNamespace,
  };
  return { state, local, env, kv };
}

const post = (payload: unknown, headers: Record<string, string> = {}) => new Request('https://screenpeek.test/api/beacon', {
  method: 'POST', headers: { 'Content-Type': 'application/json', ...headers }, body: typeof payload === 'string' ? payload : JSON.stringify(payload),
});

test('G7.1/G7.2/G7.5 valid batch stores events + session; garbage stores nothing; timeline stays ordered', { timeout: 60_000 }, async () => {
  const { state, local, env } = await beaconEnv();
  try {
    const pageview = { ...vectors.beacon_payloads.valid_pageview };
    const first = await ingestBeacon(env, post(pageview, { Cookie: 'sp_vid=v1; sp_sid=s1' }));
    assert.equal(first.status, 204);
    await ingestBeacon(env, post({ type: 'scroll', scroll_pct: 100 }, { Cookie: 'sp_vid=v1; sp_sid=s1' }));
    await ingestBeacon(env, post({ type: 'exit', duration_s: 42, max_scroll_pct: 100 }, { Cookie: 'sp_vid=v1; sp_sid=s1' }));
    const garbage = await ingestBeacon(env, post('x'.repeat(5000)));
    assert.equal(garbage.status, 204);
    const badJson = await ingestBeacon(env, post('{not json'));
    assert.equal(badJson.status, 204);

    const events = await local.db.query<{ event_type: string }>('SELECT event_type FROM tr_events ORDER BY id');
    assert.deepEqual(events.map(row => row.event_type), ['pageview', 'scroll', 'exit']); // G7.5 order, G7.2 nothing extra
    const pageviewRow = await local.db.query<{ screen_w: number; browser_timezone: string }>('SELECT screen_w, browser_timezone FROM tr_events WHERE event_type=\'pageview\'');
    assert.equal(pageviewRow[0].screen_w, 412);
    assert.equal(pageviewRow[0].browser_timezone, 'Asia/Dhaka');
    const session = await local.db.query<{ pageviews: number; max_scroll_pct: number; total_duration_s: number }>('SELECT pageviews, max_scroll_pct, total_duration_s FROM tr_sessions WHERE session_id=\'s1\'');
    assert.equal(session[0].pageviews, 1);
    assert.equal(session[0].max_scroll_pct, 100);
    assert.equal(session[0].total_duration_s, 42);
  } finally { await local.dispose(); await rm(state, { recursive: true, force: true }); }
});

test('G7.4 quota: Tier-1 pageview stored, other-country pageview skipped when the cap is full for it', { timeout: 60_000 }, async () => {
  const { state, local, env } = await beaconEnv();
  try {
    await local.db.batch([{ sql: "UPDATE config SET value='1' WHERE key='tracking_daily_cap'" }]); // test cap of 1
    const us = new Request('https://screenpeek.test/api/beacon', {
      method: 'POST', headers: { 'Content-Type': 'application/json', Cookie: 'sp_vid=v2; sp_sid=s2' },
      body: JSON.stringify({ type: 'pageview', page_url: '/', page_type: 'home' }),
    });
    Object.assign(us, { cf: { country: 'US' } });
    assert.equal((await ingestBeacon(env, us)).status, 204);
    const bd = new Request('https://screenpeek.test/api/beacon', {
      method: 'POST', headers: { 'Content-Type': 'application/json', Cookie: 'sp_vid=v3; sp_sid=s3' },
      body: JSON.stringify({ type: 'pageview', page_url: '/', page_type: 'home' }),
    });
    Object.assign(bd, { cf: { country: 'BD' } });
    assert.equal((await ingestBeacon(env, bd)).status, 204);
    const stored = await local.db.query<{ visitor_id: string }>('SELECT visitor_id FROM tr_events');
    assert.deepEqual(stored.map(row => row.visitor_id), ['v2']); // Tier-1 stored, BD skipped at cap
  } finally { await local.dispose(); await rm(state, { recursive: true, force: true }); }
});

test('beacon endpoint is dark (404) while tracking is off', { timeout: 60_000 }, async () => {
  const { state, local, env } = await beaconEnv();
  try {
    await local.db.batch([{ sql: "UPDATE config SET value='0' WHERE key='tracking_enabled'" }]);
    assert.equal((await ingestBeacon(env, post({ type: 'pageview' }))).status, 404);
  } finally { await local.dispose(); await rm(state, { recursive: true, force: true }); }
});

test('G17 extra signals survive the sanitizer and land in payload_json; absent battery stays null', { timeout: 60_000 }, async () => {
  const clean = sanitizeBeacon({ type: 'pageview', page_url: '/', is_webdriver: 1, plugins_count: 3, pdf_viewer: 1, battery_level: 82, battery_charging: 0, audio_hash: 'a1b2', webgpu_vendor: 'apple', media_devices: { audioinput: 1, videoinput: 2, audiooutput: 1 } });
  assert.ok(clean);
  assert.equal(clean.numbers.is_webdriver, 1);
  assert.equal(clean.numbers.battery_level, 82);
  assert.equal(clean.strings.audio_hash, 'a1b2');
  assert.deepEqual(clean.mediaDevices, { audioinput: 1, videoinput: 2, audiooutput: 1 });
  const bare = sanitizeBeacon({ type: 'pageview', page_url: '/' });
  assert.equal(bare?.numbers.battery_level, null); // non-Chromium: no battery API, field stays null

  const { state, local, env } = await beaconEnv();
  try {
    const outcome = await ingestBeacon(env, post({ type: 'pageview', page_url: '/', page_type: 'home', is_webdriver: 0, plugins_count: 5, battery_level: 64, battery_charging: 1, media_devices: { audioinput: 1, videoinput: 1, audiooutput: 2 } }, { Cookie: 'sp_vid=v17; sp_sid=s17' }));
    assert.equal(outcome.status, 204);
    const rows = await local.db.query<{ payload_json: string }>('SELECT payload_json FROM tr_events');
    assert.equal(rows.length, 1);
    const payload = JSON.parse(rows[0].payload_json) as Record<string, unknown>;
    assert.equal(payload.battery_level, 64);
    assert.equal(payload.battery_charging, 1);
    assert.equal(payload.plugins_count, 5);
    assert.deepEqual(payload.media_devices, { audioinput: 1, videoinput: 1, audiooutput: 2 });
  } finally { await local.dispose(); await rm(state, { recursive: true, force: true }); }
});
