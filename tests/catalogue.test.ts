import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import { applyLocalSql, localBindings, applyLocalMigrations } from '../sync/local.ts';
import { createSeedSql } from '../db/seed.mjs';
import { homeTitles, listFilterOptions, listTitles, parseListFilters, sampleMode, titleUrl } from '../src/lib/catalogue.ts';
import { mediaUrl } from '../src/lib/media.ts';

test('public catalogue queries use actual D1: pagination, filters, visibility, sample mode and homepage card cap', { timeout: 15_000 }, async () => {
  const state = await mkdtemp(resolve(tmpdir(), 'screenpeek-catalogue-'));
  const local = await localBindings(state);
  const db = local.database as unknown as D1Database;
  try {
    await applyLocalSql(local.database, await readFile('db/schema.sql', 'utf8'));
    await applyLocalSql(local.database, createSeedSql());
    await applyLocalMigrations(local.database);
    assert.equal(await sampleMode(db), true);
    const first = await listTitles(db, { type: 'movie', includeUngated: true });
    const second = await listTitles(db, { type: 'movie', includeUngated: true, page: 2 });
    assert.equal(first.total, 30);
    assert.equal(first.pages, 2);
    assert.equal(first.titles.length, 24);
    assert.equal(second.titles.length, 6);
    assert.equal(new Set([...first.titles, ...second.titles].map(title => title.id)).size, 30);
    assert.equal((await listTitles(db, { type: 'tv', includeUngated: true })).total, 20);
    assert.equal((await listTitles(db, { type: 'movie' })).total, 0, 'ungated fixtures are only visible in explicit sample mode');
    assert.equal((await listTitles(db, { type: 'movie', genre: 'drama', includeUngated: true })).total, 10);
    assert.equal((await listTitles(db, { type: 'movie', year: 2025, includeUngated: true })).total, 5);
    assert.equal((await listTitles(db, { minRating: 8, includeUngated: true })).total, 0);
    await local.db.batch([{ sql: 'UPDATE titles SET vote_average=8.2 WHERE id=-10001' }]);
    assert.equal((await listTitles(db, { minRating: 8, includeUngated: true })).total, 1);
    await local.db.batch([
      { sql: 'UPDATE titles SET hidden=1 WHERE id=-10001' },
      { sql: 'UPDATE titles SET deleted=1 WHERE id=-10002' },
      { sql: "UPDATE titles SET deleted_at='2026-11-09T00:00:00Z' WHERE id=-10003" },
    ]);
    assert.equal((await listTitles(db, { type: 'movie', includeUngated: true })).total, 27);
    const home = await homeTitles(db, true);
    assert.ok(home.trending.length + home.movies.length + home.series.length + home.upcoming.length <= 24);
    assert.ok(home.top10.length <= 10);
    assert.ok([...home.trending, ...home.movies].every(title => ![-10001, -10002, -10003].includes(title.id)));
    const filters = await listFilterOptions(db);
    assert.ok(filters.genres.some(genre => genre.slug === 'drama'));
    assert.ok(filters.years.includes(2025));
  } finally { await local.dispose(); await rm(state, { recursive: true, force: true }); }
});

test('filter inputs cannot become SQL identifiers; owned media never falls back to source hosts', () => {
  const parsed = parseListFilters(new URL("https://example.test/movies/?genre=drama'%20OR%201=1&sort=rating%3BDROP%20TABLE%20titles&year=2026%20OR%201&page=-1&rating=Infinity"), 'movie');
  assert.equal(parsed.genre, undefined);
  assert.equal(parsed.sort, 'popular');
  assert.equal(parsed.year, undefined);
  assert.equal(parsed.page, 1);
  assert.equal(parsed.minRating, undefined);
  assert.equal(parseListFilters(new URL('https://example.test/movies/?rating=')).minRating, undefined);
  assert.equal(titleUrl({ type: 'tv', slug: 'sample-show-2026' }), '/tv/sample-show-2026/');
  assert.equal(mediaUrl('poster/movie_1_hash_w185.webp', 'https://img.example.test', 500), 'https://img.example.test/poster/movie_1_hash_w500.webp');
  assert.equal(mediaUrl('poster/key.webp', undefined), null);
  for (const base of ['invalid', 'http://img.example.test', 'https://image.tmdb.org', 'https://image.tmdb.org.', 'https://user:pass@img.example.test']) assert.equal(mediaUrl('poster/key.webp', base), null);
});
