import test from 'node:test';
import assert from 'node:assert/strict';
import { collectCandidates, filterCandidates } from '../sync/collectors.ts';
import type { Candidate, ExistingTitleState } from '../sync/types.ts';
import type { DiscoveryList, TmdbClient, TmdbPage, TmdbSummary } from '../sync/tmdb.ts';

const now = new Date('2026-11-09T08:30:00.000Z');
const page = <T>(results: T[], current = 1, total = 1): TmdbPage<T> => ({ results, page: current, total_pages: total });
const emptyClient = (): Pick<TmdbClient, 'changes' | 'discovery'> => ({
  changes: async (_type, _start, _end, current = 1) => page([], current, 0),
  discovery: async (_list, current = 1) => page([], current, 0),
});

test('collects every changes page and at most three discovery pages, merges metadata and excludes invalid/adult/person entries', async () => {
  const calls: string[] = [];
  const client: Pick<TmdbClient, 'changes' | 'discovery'> = {
    changes: async (type, start, end, current = 1) => {
      calls.push(`changes:${type}:${current}`);
      assert.equal(start, '2026-11-08'); assert.equal(end, '2026-11-09');
      if (type === 'movie') return current === 1 ? page([{ id: 1 }, { id: 2, adult: true }], current, 2) : page([{ id: 4 }, { id: 1 }], current, 2);
      if (type === 'tv') return page([{ id: 1 }], current);
      return current === 1 ? page([{ id: 8 }, { id: 9, adult: true }, { id: 0 }], current, 2) : page([{ id: 8 }, { id: 10 }], current, 2);
    },
    discovery: async (list, current = 1) => {
      calls.push(`discovery:${list}:${current}`);
      if (list === 'trending') return page<TmdbSummary>(current === 1 ? [
        { id: 1, media_type: 'movie', popularity: 40, poster_path: '/first.jpg' },
        { id: 1, media_type: 'tv', popularity: 50 },
        { id: 25, media_type: 'person' }, { id: -1, media_type: 'movie' },
      ] : [], current, 4);
      if (list === 'now_playing') return page([{ id: 4, title: 'Changed movie', popularity: 20 }, { id: 2 }, { id: 5, adult: true }, { id: 1.5 }], current);
      if (list === 'upcoming') return page(current === 1 ? [{ id: 6, popularity: 30, poster_path: '/poster.jpg' }] : [{ id: 6, popularity: 60, poster_path: null }], current, 2);
      if (list === 'on_the_air') return page([], current, 0);
      return page([{ id: 7, popularity: 5 }], current);
    },
  };
  const result = await collectCandidates(client, { now });
  assert.equal(calls.length, 13);
  assert.ok(calls.includes('changes:movie:2'));
  assert.ok(calls.includes('changes:person:2'));
  assert.ok(calls.includes('discovery:trending:3'));
  assert.ok(!calls.includes('discovery:trending:4'));
  assert.ok(!calls.includes('discovery:now_playing:2'));
  assert.deepEqual(result.titles.map(({ type, id }) => `${type}:${id}`), ['movie:1', 'movie:4', 'movie:6', 'tv:1', 'tv:7']);
  assert.equal(result.titles.find(candidate => candidate.id === 4)?.changed, true);
  assert.equal(result.titles.find(candidate => candidate.id === 4)?.title, 'Changed movie');
  assert.equal(result.titles.find(candidate => candidate.id === 6)?.popularity, 60);
  assert.equal(result.titles.find(candidate => candidate.id === 6)?.poster_path, '/poster.jpg');
  assert.deepEqual(result.personIds, [8, 10]);
  assert.equal(result.needsReconciliation, false);
});

test('lookback covers failed gaps up to fourteen days and signals manual reconciliation for larger gaps', async () => {
  const client = emptyClient();
  assert.deepEqual((await collectCandidates(client, { now })).window, { startDate: '2026-11-08', endDate: '2026-11-09' });
  assert.equal((await collectCandidates(client, { now, lastSuccess: '2026-11-03T08:30:00Z' })).window.startDate, '2026-11-03');
  const boundary = await collectCandidates(client, { now, lastSuccess: '2026-10-26T08:30:00Z' });
  assert.equal(boundary.window.startDate, '2026-10-26'); assert.equal(boundary.needsReconciliation, false);
  const old = await collectCandidates(client, { now, lastSuccess: '2026-10-01T08:30:00Z' });
  assert.equal(old.window.startDate, '2026-10-26'); assert.equal(old.needsReconciliation, true);
  assert.equal((await collectCandidates(client, { now, lastSuccess: '2026-11-10T08:30:00Z' })).window.startDate, '2026-11-08');
  await assert.rejects(collectCandidates(client, { now, lastSuccess: 'invalid' }), /timestamp/);
  await assert.rejects(collectCandidates(client, { now: new Date(NaN) }), /valid date/);
});

test('feed failures and malformed pagination propagate instead of returning an incomplete successful queue', async () => {
  const client = emptyClient();
  const failure = new Error('Mock page failure');
  client.changes = async (type, _start, _end, current = 1) => {
    if (type === 'movie' && current === 2) throw failure;
    return page([], current, type === 'movie' ? 2 : 0);
  };
  await assert.rejects(collectCandidates(client, { now }), error => error === failure);
  const malformed = emptyClient();
  malformed.discovery = async (_list: DiscoveryList, current = 1) => page([], current, Number.POSITIVE_INFINITY);
  await assert.rejects(collectCandidates(malformed, { now }), /invalid pagination/);
});

test('filter skips blocked/deleted/fresh/low-discovery titles while prioritising changed titles and deferring overflow', () => {
  const candidate = (id: number, extra: Partial<Candidate> = {}): Candidate => ({ id, type: 'movie', changed: false, ...extra });
  const state = (id: number, extra: Partial<ExistingTitleState> = {}): ExistingTitleState => ({ id, type: 'movie', slug: `existing-${id}`, updated_at: now.toISOString(), ...extra });
  const candidates = [candidate(1), candidate(2), candidate(3), candidate(4), candidate(5, { changed: true, popularity: 1 }), candidate(6),
    candidate(7, { popularity: 3 }), candidate(8, { poster_path: '/poster.jpg' }), candidate(9, { popularity: 25 }), candidate(10, { changed: true }),
    candidate(11, { adult: true, popularity: 40 }), candidate(0), candidate(13, { changed: true, popularity: 1, poster_path: null }), candidate(14)];
  const existing = new Map([
    ['movie:2', state(2, { deleted: 1 })], ['movie:3', state(3, { deleted_at: '2026-11-08T00:00:00Z' })],
    ['movie:4', state(4)], ['movie:5', state(5)], ['movie:6', state(6, { updated_at: '2026-11-01T00:00:00Z' })],
    ['movie:14', state(14, { hidden: 1, updated_at: 'invalid' })],
  ]);
  const original = JSON.stringify(candidates);
  const result = filterCandidates(candidates, { existing, blocklist: new Set(['movie:1']), now, maxTitles: 3 });
  assert.deepEqual(result.selected.map(item => item.id), [5, 10, 9]);
  assert.deepEqual(result.deferred.map(item => item.id), [6, 8, 14]);
  assert.deepEqual(Object.fromEntries(result.skipped.map(item => [item.candidate.id, item.reason])), {
    0: 'invalid-id-or-type', 1: 'blocklisted', 2: 'deleted', 3: 'deleted', 4: 'fresh', 7: 'below-discovery-gate', 11: 'adult', 13: 'below-discovery-gate',
  });
  assert.equal(JSON.stringify(candidates), original);
});

test('default cap is 2000, deduplication and tie order are deterministic, and zero cap defers eligible work', () => {
  const candidates: Candidate[] = Array.from({ length: 2001 }, (_, index) => ({ id: 2001 - index, type: 'movie', changed: false, popularity: 20 }));
  const options = { existing: new Map<string, ExistingTitleState>(), blocklist: new Set<string>(), now };
  const result = filterCandidates(candidates, options);
  assert.equal(result.selected.length, 2000);
  assert.deepEqual(result.deferred.map(item => item.id), [2001]);
  const deduped = filterCandidates([{ id: 1, type: 'tv', changed: false, popularity: 20 }, { id: 1, type: 'movie', changed: false, popularity: 20 }, { id: 1, type: 'movie', changed: true }], options);
  assert.deepEqual(deduped.selected.map(item => `${item.type}:${item.id}`), ['movie:1', 'tv:1']);
  assert.equal(deduped.selected[0].changed, true);
  const adultDuplicate = filterCandidates([{ id: 2, type: 'movie', changed: false, adult: true, popularity: 20 }, { id: 2, type: 'movie', changed: true, adult: false }], options);
  assert.equal(adultDuplicate.selected.length, 0);
  assert.equal(adultDuplicate.skipped[0].reason, 'adult');
  assert.equal(filterCandidates(candidates, { ...options, maxTitles: 0 }).deferred.length, 2001);
  assert.throws(() => filterCandidates(candidates, { ...options, maxTitles: -1 }), /Maximum/);
  assert.throws(() => filterCandidates(candidates, { ...options, freshnessHours: NaN }), /Freshness/);
  assert.throws(() => filterCandidates(candidates, { ...options, popularityGate: Infinity }), /Popularity/);
});
