import assert from 'node:assert/strict';
import test from 'node:test';
import { computeDisguise, disguiseBand, languageCountryMismatch, browserTzMismatch, uaChIncoherent } from '../src/lib/tracking/disguise.ts';
import { mkdtemp, readFile, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import { localBindings, applyLocalSql } from '../sync/local.ts';
import { captureClick } from '../src/lib/tracking/click.ts';
import { ingestBeacon } from '../src/lib/tracking/beacon.ts';


test('G16.1 clean signals score 100 with the regular label', () => {
  const verdict = computeDisguise({ connClass: 'residential' }, '{}');
  assert.equal(verdict.score, 100);
  assert.equal(verdict.label, 'Looks like a regular local user');
  assert.deepEqual(verdict.reasons, []);
});

test('G16.1 deductions follow the spec weights and bands', () => {
  // webrtc -30, tz -25, datacentre -25 => 20 => obvious band.
  const verdict = computeDisguise({ webrtcMismatch: true, tzMismatch: true, connClass: 'datacentre' }, '{}');
  assert.equal(verdict.score, 20);
  assert.equal(verdict.band, 'obvious');
  assert.equal(verdict.label, 'Obvious proxy / bot setup');
  assert.equal(verdict.reasons.length, 3);
  // datacentre alone => 75 => mostly consistent.
  assert.equal(computeDisguise({ connClass: 'datacentre' }, '{}').band, 'mostly');
  // vpn -15 + language -15 => 70 => mostly; plus ua/ch -10 => 60 => leaks.
  assert.equal(computeDisguise({ connClass: 'vpn', languageMismatch: true }, '{}').score, 70);
  assert.equal(computeDisguise({ connClass: 'vpn', languageMismatch: true, uaChIncoherent: true }, '{}').band, 'leaks');
  // trust < 30 => -20; blacklist => -20.
  assert.equal(computeDisguise({ trustScore: 10 }, '{}').score, 80);
  assert.equal(computeDisguise({ trustScore: 80 }, '{}').score, 100);
  assert.equal(computeDisguise({ blacklisted: true }, '{}').score, 80);
  assert.equal(disguiseBand(45).label, 'Disguised, with leaks');
});

test('G16.2 weights are configurable via JSON', () => {
  assert.equal(computeDisguise({ connClass: 'datacentre' }, '{"datacentre": 5}').score, 95);
  assert.equal(computeDisguise({ connClass: 'datacentre' }, 'not json').score, 75);
});

test('G16.3 mismatch helpers are conservative', () => {
  assert.equal(languageCountryMismatch('en-US,en', 'US'), false);
  assert.equal(languageCountryMismatch('bn-BD', 'US'), true);
  assert.equal(languageCountryMismatch('xx-YY', 'US'), false);
  assert.equal(languageCountryMismatch('', 'US'), false);
  assert.equal(browserTzMismatch('Asia/Dhaka', 'US'), true);
  assert.equal(browserTzMismatch('America/New_York', 'US'), false);
  assert.equal(browserTzMismatch('Somewhere/Unknown', 'US'), false);
  assert.equal(uaChIncoherent('"Android"', 'iOS'), true);
  assert.equal(uaChIncoherent('"Windows"', 'Windows'), false);
  assert.equal(uaChIncoherent('', 'Android'), false);
});

test('G16.4 score is set at click insert and refreshed when session data lands', { timeout: 60_000 }, async () => {
  const state = await mkdtemp(resolve(tmpdir(), 'screenpeek-d16-'));
  const local = await localBindings(state);
  try {
    await applyLocalSql(local.database, await readFile('db/schema.sql', 'utf8'));
    for (const file of (await readdir('db/migrations')).filter(name => name.endsWith('.sql')).sort())
      await applyLocalSql(local.database, await readFile(`db/migrations/${file}`, 'utf8'));
    await local.db.batch([{ sql: "UPDATE config SET value='1' WHERE key='tracking_enabled'" }]);
    const store = new Map<string, string>();
    const env = {
      DB: local.database,
      CONFIG: {
        get: async (key: string) => store.get(key) ?? null,
        put: async (key: string, value: string) => { store.set(key, value); },
      } as unknown as KVNamespace,
    };
    const request = new Request('https://screenpeek.test/go/x/', {
      headers: { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/120.0 Safari/537.36', 'CF-Connecting-IP': '203.0.113.9', 'Accept-Language': 'en-US' },
    });
    Object.assign(request, { cf: { country: 'US', asOrganization: 'Google Cloud', clientTrustScore: 90 } });
    await captureClick(env, {
      request, slug: 'smartlink-main', linkName: 'Main', linkType: 'smartlink',
      destination: 'https://example.com/offer', routeReason: 'default', clickId: 'disguise-1',
      visitorId: 'vis-16', sessionId: 'sess-16',
    });
    let rows = await local.db.query<{ disguise_score: number }>('SELECT disguise_score FROM tr_clicks WHERE click_id=\'disguise-1\'');
    assert.equal(rows[0].disguise_score, 75); // datacentre -25 at insert
    const beacon = new Request('https://screenpeek.test/api/beacon', {
      method: 'POST', headers: { 'Content-Type': 'application/json', Cookie: 'sp_vid=vis-16; sp_sid=sess-16' },
      body: JSON.stringify({ type: 'pageview', page_url: '/', page_type: 'home', browser_timezone: 'Asia/Dhaka', languages: 'bn-BD', webrtc_ip: '198.51.100.7' }),
    });
    Object.assign(beacon, { cf: { country: 'US' } });
    const outcome = await ingestBeacon(env, beacon);
    assert.equal(outcome.status, 204);
    rows = await local.db.query<{ disguise_score: number }>('SELECT disguise_score FROM tr_clicks WHERE click_id=\'disguise-1\'');
    assert.equal(rows[0].disguise_score, 5); // 75 - tz 25 - language 15 - webrtc 30
  } finally { await local.dispose(); await rm(state, { recursive: true, force: true }); }
});
