import test from 'node:test';
import assert from 'node:assert/strict';
import { QuotaEngine, classifyTier, quotaDecision } from '../src/lib/tracking/quota.ts';

// Gate G2 — priority quota engine (test cap of 10, per docs/03).
const rules = { dailyCap: 10, tier1Countries: ['US', 'GB', 'CA', 'AU'], fillPct: 80, fillAfterHourUtc: 20 };
const at = (hour: number, day = '2026-11-13') => new Date(`${day}T${String(hour).padStart(2, '0')}:00:00Z`);

function fakeKv() {
  const map = new Map<string, string>();
  return { map, get: async (key: string) => map.get(key) ?? null, put: async (key: string, value: string) => { map.set(key, value); } };
}

test('G2.1 tier classification', () => {
  for (const country of ['US', 'GB', 'CA', 'AU', 'us', 'gb']) assert.equal(classifyTier(country, rules.tier1Countries), 'tier1', country);
  for (const country of ['BD', 'IN', 'XX', '']) assert.equal(classifyTier(country, rules.tier1Countries), 'other', country || '(empty)');
});

test('G2.2 cap=10: ten stores succeed, the 11th raw record is skipped', async () => {
  const engine = new QuotaEngine(fakeKv());
  for (let i = 0; i < 10; i++) assert.equal((await engine.decide({ kind: 'click', country: 'US' }, rules, at(10))).decision, 'store', `store ${i + 1}`);
  assert.equal((await engine.decide({ kind: 'click', country: 'US' }, rules, at(10))).decision, 'skip');
  assert.equal(await engine.count(at(10)), 10);
});

test('G2.3 fill rule: OTHER stored below 80%, skipped at 80% before 20:00 UTC, stored again after 20:00 while quota remains', async () => {
  const kv = fakeKv();
  const engine = new QuotaEngine(kv);
  kv.map.set('tr_quota:2026-11-13', '7');
  assert.equal((await engine.decide({ kind: 'click', country: 'BD' }, rules, at(10))).decision, 'store'); // 7 < 8
  assert.equal(await engine.count(at(10)), 8);
  assert.equal((await engine.decide({ kind: 'click', country: 'BD' }, rules, at(10))).decision, 'skip'); // at 80%, before fill hour
  assert.equal((await engine.decide({ kind: 'click', country: 'BD' }, rules, at(21))).decision, 'store'); // fill-up if short
  assert.equal(await engine.count(at(21)), 9);
});

test('G2.4 Tier-1 stored at 90% usage until the cap', async () => {
  const kv = fakeKv();
  const engine = new QuotaEngine(kv);
  kv.map.set('tr_quota:2026-11-13', '9');
  assert.equal((await engine.decide({ kind: 'click', country: 'GB' }, rules, at(10))).decision, 'store');
  assert.equal((await engine.decide({ kind: 'click', country: 'GB' }, rules, at(10))).decision, 'skip'); // cap reached
});

test('G2.5 conversions bypass the cap and never increment the counter', async () => {
  const kv = fakeKv();
  const engine = new QuotaEngine(kv);
  kv.map.set('tr_quota:2026-11-13', '10');
  const result = await engine.decide({ kind: 'conversion', country: 'BD' }, rules, at(10));
  assert.equal(result.decision, 'store');
  assert.equal(await engine.count(at(10)), 10);
});

test('G2.6 at cap the degraded flag is raised; a new UTC day resets the counter and clears the flag', async () => {
  const flips: boolean[] = [];
  const engine = new QuotaEngine(fakeKv(), async value => { flips.push(value); });
  for (let i = 0; i < 10; i++) await engine.decide({ kind: 'click', country: 'US' }, rules, at(10));
  assert.deepEqual(flips, [true]);
  const nextDay = await engine.decide({ kind: 'click', country: 'US' }, rules, at(1, '2026-11-14'));
  assert.equal(nextDay.decision, 'store');
  assert.equal(nextDay.count, 1);
  assert.deepEqual(flips, [true, false]);
});

test('quotaDecision: OTHER events join the late fill only in the final hour', () => {
  assert.equal(quotaDecision(9, rules, 'other', 'event', at(21)), 'skip');
  assert.equal(quotaDecision(9, rules, 'other', 'event', at(23)), 'store');
  assert.equal(quotaDecision(5, rules, 'other', 'event', at(10)), 'store');
});
