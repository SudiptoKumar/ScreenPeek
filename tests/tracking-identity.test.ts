import test from 'node:test';
import assert from 'node:assert/strict';
import { consentAllows, resolveIdentity } from '../src/lib/tracking/identity.ts';

// Gate G5 (unit half) — consent matrix and cookie behaviour.
const req = (headers: Record<string, string> = {}) => new Request('https://screenpeek.test/', { headers });

test('G5.3 consent: GPC and DNT are honoured in basic mode; strict needs an opt-in', () => {
  assert.equal(consentAllows(req(), 'basic'), true);
  assert.equal(consentAllows(req({ 'Sec-GPC': '1' }), 'basic'), false);
  assert.equal(consentAllows(req({ DNT: '1' }), 'basic'), false);
  assert.equal(consentAllows(req(), 'strict'), false);
  assert.equal(consentAllows(req({ Cookie: 'sp_consent=1' }), 'strict'), true);
  assert.equal(consentAllows(req({ Cookie: 'sp_consent=1', 'Sec-GPC': '1' }), 'strict'), false);
  assert.equal(consentAllows(req({ 'Sec-GPC': '1' }), 'off'), true);
});

test('G5.1 existing cookies are reused; the session cookie is refreshed', () => {
  const result = resolveIdentity(req({ Cookie: 'sp_vid=visitor-1; sp_sid=session-1' }), 'basic');
  assert.equal(result.visitorId, 'visitor-1');
  assert.equal(result.sessionId, 'session-1');
  assert.equal(result.setCookies.length, 1);
  assert.match(result.setCookies[0], /^sp_sid=session-1;/);
});

test('G5.1/G5.2 a fresh visitor is minted both ids; denied consent mints nothing', () => {
  const fresh = resolveIdentity(req(), 'basic');
  assert.ok(fresh.visitorId);
  assert.ok(fresh.sessionId);
  assert.notEqual(fresh.visitorId, fresh.sessionId);
  assert.equal(fresh.setCookies.length, 2);
  const denied = resolveIdentity(req({ 'Sec-GPC': '1' }), 'basic');
  assert.deepEqual(denied, { visitorId: '', sessionId: '', setCookies: [] });
});

test('G5.4 identity cookies are first-party only (no Domain attribute, Lax, Secure)', () => {
  const { setCookies } = resolveIdentity(req(), 'basic');
  for (const cookie of setCookies) {
    assert.ok(!/Domain=/i.test(cookie), cookie);
    assert.match(cookie, /SameSite=Lax/);
    assert.match(cookie, /Secure/);
    assert.match(cookie, /^sp_(vid|sid)=/);
  }
});
