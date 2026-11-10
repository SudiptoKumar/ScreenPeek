import test from 'node:test';
import assert from 'node:assert/strict';
import { personSlug, qualityGate, slugBase, titleSlug, transformPerson, transformTitle } from '../sync/transform.ts';
import { prepareCandidates } from '../sync/prepare.ts';
import { TmdbClient } from '../sync/tmdb.ts';
import type { SourceDetails } from '../sync/types.ts';

const now = new Date('2026-11-09T00:00:00Z');
const source: SourceDetails = {
  id: 10, title: 'The Café Atlas', original_title: 'Atlas original', overview: 'An original overview with enough detail to pass the metadata completeness check. '.repeat(2),
  release_date: '2026-01-12', runtime: 108, popularity: 22, vote_average: 7.2, vote_count: 100,
  poster_path: '/poster.jpg', original_language: 'en', genres: [{ id: 1, name: 'Science Fiction' }],
  credits: { cast: Array.from({ length: 15 }, (_, i) => ({ id: i + 1, name: `Actor ${i + 1}`, character: `Role ${i + 1}` })), crew: [{ id: 100, name: 'Director Example', job: 'Director' }] },
  videos: { results: [{ key: 'abcdefghijk', site: 'YouTube', type: 'Trailer', official: true }] },
  similar: { results: [{ id: 10 }, { id: 11 }, { id: 11 }, { id: 12 }] },
  'watch/providers': { results: { US: { flatrate: [{ provider_id: 1, provider_name: 'Example service' }], buy: [{ provider_id: 2, provider_name: 'Example shop' }] }, GB: { free: [{ provider_id: 3, provider_name: 'Example free service' }] }, FR: { rent: [{ provider_id: 4, provider_name: 'Outside launch region' }] } } },
  release_dates: { results: [{ iso_3166_1: 'US', release_dates: [{ type: 3, release_date: '2026-01-12T00:00:00.000Z', certification: 'PG' }] }] },
  images: { backdrops: [{ file_path: '/backdrop.jpg' }, { file_path: '/backdrop.jpg' }] },
};

test('stable keyword slugs, accents and cross-media collisions', () => {
  assert.equal(slugBase('  Café & Cinema!  '), 'cafe-cinema');
  const used = new Set(['the-atlas-2026', 'the-atlas-2026-10']);
  assert.equal(titleSlug('The Atlas', 2026, 'tv', 10, used), 'the-atlas-2026-tv-10');
  assert.equal(titleSlug('A changed title', 2027, 'movie', 10, used, 'original-slug-2020'), 'original-slug-2020');
  assert.equal(personSlug('Alex Smith', 12, new Set(['alex-smith'])), 'alex-smith-12');
});

test('movie transform keeps top12 cast, launch providers, trailer and date metadata without inventing a copied poster', () => {
  const result = transformTitle(source, 'movie', { now, usedSlugs: new Set() });
  assert.equal(result.title.slug, 'the-cafe-atlas-2026');
  assert.equal(result.title.quality_gate, 0);
  assert.equal(result.credits.filter(row => row.role === 'cast').length, 12);
  assert.equal(result.credits.find(row => row.role === 'director')?.person_id, 100);
  assert.equal(result.providers.length, 3);
  assert.deepEqual(result.providers.map(row => row.offer_type), ['stream', 'buy', 'free']);
  assert.equal(result.title.trailer_key, 'abcdefghijk');
  assert.deepEqual(JSON.parse(result.title.similar_ids), [11, 12]);
  assert.equal(result.releases[0].certification, 'PG');
  assert.equal(result.title.updated_at, now.toISOString());
  assert.deepEqual(result.images.gallery, ['/backdrop.jpg']);
});

test('quality gate requires an owned poster, overview, popularity and cast or providers', () => {
  const base = { posterR2: 'poster/10.webp', overview: 'x'.repeat(80), popularity: 10, castCount: 3, providerCount: 0 };
  assert.equal(qualityGate(base), 1);
  assert.equal(qualityGate({ ...base, posterR2: null }), 0);
  assert.equal(qualityGate({ ...base, overview: 'short' }), 0);
  assert.equal(qualityGate({ ...base, popularity: 9 }), 0);
  assert.equal(qualityGate({ ...base, castCount: 2 }), 0);
  assert.equal(qualityGate({ ...base, castCount: 0, providerCount: 1 }), 1);
  assert.equal(transformTitle(source, 'movie', { now, usedSlugs: new Set(), posterR2: 'poster/10.webp' }).title.quality_gate, 1);
});

test('TV transform keeps creators, seasons and content ratings; unknown dates remain null', () => {
  const result = transformTitle({ ...source, name: 'Night Signals', first_air_date: '2024-02-29', created_by: [{ id: 500, name: 'Series Creator' }], episode_run_time: [42], seasons: [{ season_number: 0, name: 'Specials', episode_count: 1 }], content_ratings: { results: [{ iso_3166_1: 'GB', rating: '12' }] } }, 'tv', { now, usedSlugs: new Set() });
  assert.equal(result.title.slug, 'night-signals-2024');
  assert.equal(result.title.runtime_min, 42);
  assert.equal(result.credits.find(row => row.role === 'creator')?.person_id, 500);
  assert.equal(result.seasons[0].season_number, 0);
  assert.equal(result.releases[0].certification, '12');
  assert.equal(transformTitle({ ...source, release_date: '2025-02-29' }, 'movie', { now, usedSlugs: new Set() }).title.release_date, null);
  const person = transformPerson({ id: 5, name: 'Renée Example', biography: 'Biography' }, { now, usedSlugs: new Set() });
  assert.equal(person.slug, 'renee-example');
  assert.equal(person.bio, 'Biography');
});

test('bundled fetches preserve queue-order slugs, report 404s, reject mismatched IDs and apply post-detail admission', async () => {
  const requests: URL[] = [];
  const client = new TmdbClient({ token: 'fixture-only', maxRetries: 0, fetch: async input => {
    const url = new URL(String(input)); requests.push(url);
    const id = Number(url.pathname.split('/').at(-1));
    if (id === 3) return new Response('{}', { status: 404 });
    const data = id === 4 ? { ...source, id: 999 } : id === 5 ? { ...source, id, poster_path: null, popularity: 0 } : { ...source, id };
    return Response.json(data);
  } });
  const candidates = [1, 2, 3, 4, 5].map(id => ({ id, type: 'movie' as const, changed: true }));
  const result = await prepareCandidates(client, candidates, { now, existing: new Map(), usedSlugs: new Set() });
  assert.deepEqual(result.prepared.map(row => row.data.title.slug), ['the-cafe-atlas-2026', 'the-cafe-atlas-2026-2']);
  assert.equal(result.failures.length, 2);
  assert.equal(result.failures.find(row => row.candidate.id === 3)?.status, 404);
  assert.equal(result.skipped.length, 1);
  assert.equal(requests.length, 5);
  assert.ok(requests.every(url => url.searchParams.has('append_to_response')));
});
