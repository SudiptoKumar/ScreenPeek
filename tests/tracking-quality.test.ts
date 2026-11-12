import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import { localBindings, applyLocalSql } from '../sync/local.ts';
import { flagsForSignals, connClassFromOrg, tzCountryMismatch, type QualitySignals } from '../src/lib/tracking/quality.ts';
import { captureClick } from '../src/lib/tracking/click.ts';

// Gate G9 — quality flags: expected flags per scenario, flag-only
// behaviour, and config-overridable weights.
const cleanSignals: QualitySignals = {
  isBotUa: false, connClass: 'residential', trustScore: null, tzMismatch: false, velocityPerHour: 2, noReferrerOnSiteClick: false,
};

test('G9.1 seeded scenarios produce the expected flags and bands', () => {
  assert.deepEqual(flagsForSignals(cleanSignals, '{}'), { flags: [], band: 'clean', score: 0 });
  const bot = flagsForSignals({ ...cleanSignals, isBotUa: true }, '{}');
  assert.deepEqual(bot.flags, ['bot_ua']);
  assert.equal(bot.band, 'likely_bad'); // 60 >= 50
  const dc = flagsForSignals({ ...cleanSignals, connClass: 'datacentre' }, '{}');
  assert.deepEqual(dc.flags, ['datacentre']);
  assert.equal(dc.band, 'review'); // 40 in [20, 50)
  const stacked = flagsForSignals({ ...cleanSignals, connClass: 'datacentre', tzMismatch: true, trustScore: 10 }, '{}');
  assert.deepEqual(stacked.flags.sort(), ['datacentre', 'trust_low', 'tz_mismatch']);
  assert.equal(stacked.band, 'likely_bad'); // 95
  const velocity = flagsForSignals({ ...cleanSignals, velocityPerHour: 45 }, '{}');
  assert.deepEqual(velocity.flags, ['velocity']);
  assert.equal(connClassFromOrg('Amazon.com, Inc.'), 'datacentre');
  assert.equal(connClassFromOrg('Comcast Cable Communications'), 'residential');
  assert.equal(connClassFromOrg(''), 'unknown');
  assert.equal(tzCountryMismatch('Asia/Dhaka', '', 'US'), true);
  assert.equal(tzCountryMismatch('America/New_York', '', 'US'), false);
  assert.equal(tzCountryMismatch('', '', 'US'), false);
});

test('G9.3 config weights change the band for the same signals', () => {
  const dc = { ...cleanSignals, connClass: 'datacentre' };
  assert.equal(flagsForSignals(dc, '{}').band, 'review');
  assert.equal(flagsForSignals(dc, '{"datacentre":5}').band, 'clean');
  assert.equal(flagsForSignals(dc, '{"datacentre":5,"band_review":3}').band, 'review');
  assert.equal(flagsForSignals(dc, '{"datacentre":80}').band, 'likely_bad');
});

test('G9.2/G9.4 a fully-flagged click is still captured and counted (flag-only)', { timeout: 60_000 }, async () => {
  const state = await mkdtemp(resolve(tmpdir(), 'screenpeek-q9-'));
  const local = await localBindings(state);
  try {
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
    const request = new Request('https://screenpeek.test/go/x/', {
      headers: { 'User-Agent': 'Mozilla/5.0 (compatible; Googlebot/2.1; +http://www.google.com/bot.html)', 'CF-Connecting-IP': '203.0.113.9' },
    });
    Object.assign(request, { cf: { country: 'US', asOrganization: 'Google Cloud', clientTrustScore: 5 } });
    await captureClick(env, {
      request, slug: 'smartlink-main', linkName: 'Main', linkType: 'smartlink',
      destination: 'https://example.com/offer', routeReason: 'default', clickId: 'flagged-1',
    });
    const rows = await local.db.query<{ quality_flags: string; quality_band: string }>('SELECT quality_flags, quality_band FROM tr_clicks WHERE click_id=\'flagged-1\'');
    assert.equal(rows.length, 1); // stored normally despite the flags
    const flags = JSON.parse(rows[0].quality_flags) as string[];
    assert.ok(flags.includes('bot_ua'));
    assert.ok(flags.includes('datacentre'));
    assert.ok(flags.includes('trust_low'));
    assert.equal(rows[0].quality_band, 'likely_bad');
    const daily = await local.db.query<{ clicks: number }>('SELECT clicks FROM tr_click_daily');
    assert.equal(daily[0].clicks, 1); // aggregates still count it
  } finally { await local.dispose(); await rm(state, { recursive: true, force: true }); }
});
