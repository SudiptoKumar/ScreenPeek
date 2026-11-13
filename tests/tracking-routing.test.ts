import assert from 'node:assert/strict';
import test from 'node:test';
import { decideRoute, hashFraction, pickVariant, scheduleAllows, underCaps, type VariantRow } from '../src/lib/tracking/routing.ts';

const variant = (id: number, weight: number, extra: Partial<VariantRow> = {}): VariantRow => ({
  id, link_slug: 'smartlink-main', dest_url: `https://example.com/v${id}`, weight,
  chain_order: id, active: 1, cap_clicks_day: 0, cap_conv_day: 0, schedule: '', note: '', ...extra,
});
const noCounts = new Map();

test('G18.1 weighted pick honours weights; sticky hash is deterministic per visitor', () => {
  const variants = [variant(1, 75), variant(2, 25)];
  // Sticky: the same visitor always lands on the same variant.
  const first = pickVariant(variants, 'smartlink-main:visitor-a');
  for (let i = 0; i < 5; i++) assert.equal(pickVariant(variants, 'smartlink-main:visitor-a')?.id, first?.id);
  // Distribution across many sticky keys roughly follows the weights.
  let ones = 0;
  for (let i = 0; i < 400; i++) if (pickVariant(variants, `slug:visitor-${i}`)?.id === 1) ones++;
  assert.ok(ones > 240 && ones < 360, `expected ~300 of 400 on the 75% variant, got ${ones}`);
  assert.ok(hashFraction('x') >= 0 && hashFraction('x') < 1);
  // Zero-weight variants never win the weighted pick but chain order serves when all are zero.
  assert.equal(pickVariant([variant(1, 0), variant(2, 10)], null, () => 0.99)?.id, 2);
  assert.equal(pickVariant([variant(3, 0), variant(4, 0)], null)?.id, 3);
});

test('G18.2/G19.1 decideRoute records variant:<id>, cascades on caps, and falls back honestly', () => {
  const variants = [variant(1, 100, { cap_clicks_day: 5 }), variant(2, 100)];
  const counts = new Map([[1, { clicks: 5, conversions: 0 }], [2, { clicks: 0, conversions: 0 }]]);
  const cascaded = decideRoute({ variants, counts, fallbackDestination: 'https://example.com/base', fallbackReason: 'default', stickyKey: 's:v', now: new Date() });
  assert.equal(cascaded.variantId, 2);
  assert.equal(cascaded.routeReason, 'variant:2');
  assert.deepEqual(cascaded.cappedIds, [1]);
  const allCapped = decideRoute({
    variants, counts: new Map([[1, { clicks: 9, conversions: 0 }], [2, { clicks: 0, conversions: 3 }]]),
    fallbackDestination: 'https://example.com/base', fallbackReason: 'default', stickyKey: null, now: new Date(),
  });
  // variant 2 has no caps set, so it is never capped by conversions here.
  assert.equal(allCapped.variantId, 2);
  const bothCapped = decideRoute({
    variants: [variant(1, 100, { cap_clicks_day: 1 }), variant(2, 100, { cap_conv_day: 1 })],
    counts: new Map([[1, { clicks: 1, conversions: 0 }], [2, { clicks: 0, conversions: 1 }]]),
    fallbackDestination: 'https://example.com/base', fallbackReason: 'country', stickyKey: null, now: new Date(),
  });
  assert.equal(bothCapped.destination, 'https://example.com/base');
  assert.equal(bothCapped.routeReason, 'cap_fallback');
  assert.equal(underCaps(variant(1, 1, { cap_clicks_day: 3 }), { clicks: 2, conversions: 0 }), true);
  assert.equal(underCaps(variant(1, 1, { cap_clicks_day: 3 }), { clicks: 3, conversions: 0 }), false);
  // No variants at all: untouched fallback.
  const none = decideRoute({ variants: [], counts: noCounts, fallbackDestination: 'https://example.com/base', fallbackReason: 'device', stickyKey: null, now: new Date() });
  assert.equal(none.routeReason, 'device');
});

test('G21.1 schedules gate by weekday and time window in their own timezone', () => {
  const saturday = new Date('2026-11-14T10:00:00Z'); // a Saturday
  assert.equal(scheduleAllows('', saturday), true);
  assert.equal(scheduleAllows('{"days":[1,2,3,4,5],"tz":"UTC"}', saturday), false); // weekdays only
  assert.equal(scheduleAllows('{"days":[6],"tz":"UTC"}', saturday), true);
  assert.equal(scheduleAllows('{"start":"09:00","end":"17:00","tz":"UTC"}', saturday), true);
  assert.equal(scheduleAllows('{"start":"11:00","end":"17:00","tz":"UTC"}', saturday), false);
  assert.equal(scheduleAllows('not json', saturday), true);
  const blocked = decideRoute({
    variants: [variant(1, 100, { schedule: '{"days":[1],"tz":"UTC"}' })], counts: noCounts,
    fallbackDestination: 'https://example.com/base', fallbackReason: 'default', stickyKey: null, now: saturday,
  });
  assert.equal(blocked.routeReason, 'schedule');
  assert.equal(blocked.destination, 'https://example.com/base');
});

test('G21.2 quality gate needs 2+ signals (bot UA, datacentre, low trust)', async () => {
  const { qualityGateSignals } = await import('../src/lib/tracking/routing.ts');
  const request = new Request('https://screenpeek.test/go/x/');
  assert.equal(qualityGateSignals(request, 'Google Cloud', null, false), 1);
  assert.equal(qualityGateSignals(request, 'Google Cloud', 10, false), 2);
  assert.equal(qualityGateSignals(request, 'Comcast Cable', null, true), 1);
  assert.equal(qualityGateSignals(request, 'Comcast Cable', null, false), 0);
});
