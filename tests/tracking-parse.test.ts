import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { parseUserAgent, classifyReferrer, clientInfo, maskIp } from '../src/lib/tracking/parse.ts';
import { buildClickRow } from '../src/lib/tracking/click.ts';
import { parseTrackingConfig } from '../src/lib/tracking/config.ts';

// Gates G4 (parsing) + the unit half of G3.4/G3.7, driven by the v1
// package's verified test vectors (tests/fixtures/tracking-vectors.json).
interface UaVector { name: string; ua: string; expect: Record<string, string | number> }
interface RefVector { referrer: string; expect_class: string; expect_domain?: string }
interface CfFixture { name: string; cf: Record<string, unknown>; expect_stored: Record<string, unknown> }
const vectors = JSON.parse(await readFile('tests/fixtures/tracking-vectors.json', 'utf8')) as {
  user_agents: UaVector[]; referrers: RefVector[]; cf_fixtures: CfFixture[];
};
const SITE_HOST = 'screenpeek.screenpeek.workers.dev';

test('G4.1 UA vectors: 100% of expected fields match (EMPTY means stored empty)', () => {
  for (const vector of vectors.user_agents) {
    const parsed = parseUserAgent(vector.ua);
    const actual: Record<string, string | number> = {
      browser: parsed.browser, browser_major: parsed.browserMajor, os: parsed.os,
      os_version: parsed.osVersion, device_type: parsed.deviceType,
      device_brand: parsed.deviceBrand, device_model: parsed.deviceModel,
      is_bot_ua: parsed.isBotUa ? 1 : 0,
    };
    for (const [key, expected] of Object.entries(vector.expect)) {
      if (key === 'note') continue;
      assert.equal(actual[key], expected === 'EMPTY' ? '' : expected, `${vector.name}: ${key}`);
    }
  }
});

test('G4.2 referrer classes: search / social / direct / internal', () => {
  for (const vector of vectors.referrers) {
    const result = classifyReferrer(vector.referrer, SITE_HOST);
    assert.equal(result.cls, vector.expect_class, vector.referrer || '(empty)');
    if (vector.expect_domain !== undefined) assert.equal(result.domain, vector.expect_domain, vector.referrer);
  }
});

test('G4.3 reduced Android UA keeps the frozen os_version "10" as-is', () => {
  const vector = vectors.user_agents.find(item => item.name === 'android_chrome_reduced');
  assert.ok(vector);
  assert.equal(parseUserAgent(vector.ua).osVersion, '10');
});

test('G4.4 Googlebot UA is flagged as a bot', () => {
  const vector = vectors.user_agents.find(item => item.name === 'googlebot');
  assert.ok(vector);
  const parsed = parseUserAgent(vector.ua);
  assert.equal(parsed.isBotUa, true);
  assert.equal(parsed.deviceType, 'bot');
});

test('G3.4 cf fixture present: geo/asn/tls/trust stored; cf absent: NULLs, no crash', () => {
  const cfg = parseTrackingConfig({});
  const fixture = vectors.cf_fixtures[0];
  const withCf = new Request('https://screenpeek.test/go/x', { headers: { 'User-Agent': 'Mozilla/5.0' } });
  Object.assign(withCf, { cf: fixture.cf });
  const row = buildClickRow({ request: withCf, slug: 'x', linkName: 'X', linkType: 'other', destination: 'https://example.com/', routeReason: 'default', clickId: 'cid-1' }, cfg);
  assert.equal(row.country, fixture.expect_stored.country);
  assert.equal(row.asn, fixture.expect_stored.asn);
  assert.equal(row.tls_version, fixture.expect_stored.tls_version);
  assert.equal(row.trust_score, fixture.expect_stored.trust_score);

  const bare = new Request('https://screenpeek.test/go/x', { headers: { 'User-Agent': 'Mozilla/5.0' } });
  const bareRow = buildClickRow({ request: bare, slug: 'x', linkName: 'X', linkType: 'other', destination: 'https://example.com/', routeReason: 'default', clickId: 'cid-2' }, cfg);
  assert.equal(bareRow.country, '');
  assert.equal(bareRow.asn, null);
  assert.equal(bareRow.trust_score, null);
  const info = clientInfo(bare);
  assert.equal(info.ip, '');
});

test('G3.7 IP modes: masked zeroes the last IPv4 octet; off stores nothing; full stores as-is', () => {
  assert.equal(maskIp('203.0.113.87', 'masked'), '203.0.113.0');
  assert.equal(maskIp('203.0.113.87', 'off'), '');
  assert.equal(maskIp('203.0.113.87', 'full'), '203.0.113.87');
  assert.equal(maskIp('', 'masked'), '');
});
