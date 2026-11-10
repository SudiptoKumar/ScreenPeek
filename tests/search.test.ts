import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import { localBindings, applyLocalSql, applyLocalMigrations } from '../sync/local.ts';
import { createSeedSql } from '../db/seed.mjs';
import { loadSearchPage, matchQuery, searchText, searchTitles } from '../src/lib/search.ts';
import { handleSearch } from '../functions/api/search.ts';

test('search text compiles literal AND-prefix terms rather than accepting FTS operators', () => {
  assert.equal(searchText('  Quiet \n Atlas  '), 'Quiet Atlas');
  assert.equal(matchQuery('Quiet Atl'), '"Quiet"* AND "Atl"*');
  assert.equal(matchQuery('café! OR "1"*'), '"café"* AND "OR"* AND "1"*');
  assert.equal(matchQuery('!@#$%^&*()'), '');
  assert.equal(matchQuery('one two three four five six seven eight nine').split(' AND ').length, 8);
  assert.throws(() => searchText('x'.repeat(101)), /at most 100/);
});

test('search operates against actual local D1 with bounded API results and safe full-page filtering', { timeout: 20_000 }, async context => {
  const directory = await mkdtemp(resolve(tmpdir(), 'screenpeek-search-'));
  const local = await localBindings(directory);
  const db = local.database as unknown as D1Database;
  try {
    await applyLocalSql(local.database, await readFile('db/schema.sql', 'utf8'));
    await applyLocalSql(local.database, createSeedSql());
    await applyLocalMigrations(local.database);

    await context.test('full results paginate 24+24+2 and prefix words match without syntax errors', async () => {
      const pages = await Promise.all([1, 2, 3].map(page => searchTitles(db, 'Sample', { includeUngated: true, filters: { page } })));
      assert.deepEqual(pages.map(page => page.titles.length), [24, 24, 2]);
      assert.ok(pages.every(page => page.total === 50 && page.pages === 3));
      assert.equal(new Set(pages.flatMap(page => page.titles.map(title => `${title.type}:${title.id}`))).size, 50);
      const prefix = await searchTitles(db, 'Qui Atl', { includeUngated: true });
      assert.equal(prefix.total, 5);
      assert.ok(prefix.titles.every(title => title.title.includes('Quiet Atlas')));
      for (const query of ['" OR 1=1; DROP TABLE titles; --', 'NEAR(quiet atlas)', '"unclosed', '*', '!!']) {
        const result = await searchTitles(db, query, { includeUngated: true });
        assert.ok(result.titles.length <= 24);
      }
      assert.equal((await local.db.query<{ count: number }>('SELECT COUNT(*) AS count FROM titles'))[0].count, 50);
    });

    await context.test('full-page filters use indexed catalogue fields and sorting retains the requested semantics', async () => {
      assert.equal((await searchTitles(db, 'Sample', { includeUngated: true, filters: { type: 'movie' } })).total, 30);
      assert.equal((await searchTitles(db, 'Sample', { includeUngated: true, filters: { type: 'tv' } })).total, 20);
      assert.equal((await searchTitles(db, 'Sample', { includeUngated: true, filters: { genre: 'drama' } })).total, 17);
      assert.equal((await searchTitles(db, 'Sample', { includeUngated: true, filters: { type: 'movie', year: 2025 } })).total, 5);
      await local.db.batch([{ sql: "UPDATE titles SET vote_average=8.8,added_at='2026-11-10T00:00:00Z' WHERE id=-10001" }]);
      assert.equal((await searchTitles(db, 'Sample', { includeUngated: true, filters: { minRating: 8 } })).total, 1);
      for (const sort of ['newest', 'rating'] as const) assert.equal((await searchTitles(db, 'Sample', { includeUngated: true, filters: { sort } })).titles[0].id, -10001);
      const released = await searchTitles(db, 'Sample', { includeUngated: true, filters: { sort: 'release' } });
      assert.ok(released.titles.every((title, index, rows) => index === 0 || rows[index - 1].release_date! >= title.release_date!));
    });

    await context.test('Unicode prefixes and movie/TV records sharing a source ID stay distinct', async () => {
      await local.db.batch([
        { sql: "INSERT INTO titles(id,type,slug,title,quality_gate) VALUES(900001,'movie','eclair-cinema','Éclair cinéma',1),(900002,'movie','shared-search-movie','SharedWord Example',1),(900002,'tv','shared-search-tv','SharedWord Example',1)" },
        { sql: "INSERT INTO titles_fts(title,slug,year,type) SELECT title,slug,year,type FROM titles WHERE id IN (900001,900002)" },
      ]);
      assert.equal((await searchTitles(db, 'eclai ciné')).titles[0].slug, 'eclair-cinema');
      const shared = await searchTitles(db, 'SharedWord');
      assert.equal(shared.total, 2);
      assert.deepEqual(shared.titles.map(title => title.type).sort(), ['movie', 'tv']);
    });

    await context.test('suggestion API exposes at most eight safe fields and only owned media URLs', async () => {
      await local.db.batch([{ sql: "UPDATE titles SET poster_r2='poster/fixture_w185.webp' WHERE id<0" }]);
      const response = await handleSearch(new Request('https://example.test/api/search?q=Sample&limit=999'), { DB: db, R2_PUBLIC_BASE: 'https://img.example.test' });
      assert.equal(response.status, 200);
      assert.equal(response.headers.get('cache-control'), 'no-store');
      assert.equal(response.headers.get('x-content-type-options'), 'nosniff');
      assert.match(response.headers.get('content-type')!, /application\/json/);
      const body = await response.json() as { results: Array<Record<string, unknown>> };
      assert.equal(body.results.length, 8);
      for (const result of body.results) {
        assert.deepEqual(Object.keys(result).sort(), ['href', 'id', 'poster', 'slug', 'title', 'type', 'year']);
        assert.match(result.href as string, /^\/(movie|tv)\/[^/]+\/$/);
        assert.equal(result.poster, 'https://img.example.test/poster/fixture_w185.webp');
      }
      const absentMedia = await handleSearch(new Request('https://example.test/api/search?q=Sample'), { DB: db });
      assert.ok(((await absentMedia.json()) as { results: Array<{ poster: unknown }> }).results.every(result => result.poster === null));
    });

    await context.test('short/oversized/method-invalid API requests never query D1', async () => {
      let calls = 0;
      const unavailable = { prepare() { calls++; throw new Error('must not query'); } } as unknown as D1Database;
      for (const query of ['', 'a', ' ']) {
        const response = await handleSearch(new Request(`https://example.test/api/search?q=${encodeURIComponent(query)}`), { DB: unavailable });
        assert.equal(response.status, 200);
        assert.deepEqual(await response.json(), { results: [] });
      }
      assert.equal((await handleSearch(new Request(`https://example.test/api/search?q=${'x'.repeat(101)}`), { DB: unavailable })).status, 400);
      const method = await handleSearch(new Request('https://example.test/api/search?q=Sample', { method: 'POST' }), { DB: unavailable });
      assert.equal(method.status, 405); assert.equal(method.headers.get('allow'), 'GET');
      assert.equal(calls, 0);
    });

    await context.test('hidden/deleted/trashed and ungated live titles cannot escape search visibility rules', async () => {
      await local.db.batch([
        { sql: 'UPDATE titles SET hidden=1 WHERE id=-10050' },
        { sql: 'UPDATE titles SET deleted=1 WHERE id=-10049' },
        { sql: "UPDATE titles SET deleted_at='2026-11-09T00:00:00Z' WHERE id=-10048" },
      ]);
      const sample = await searchTitles(db, 'Sample', { includeUngated: true });
      assert.equal(sample.total, 47);
      assert.ok(sample.titles.every(title => ![-10050, -10049, -10048].includes(title.id)));
      await local.db.batch([
        { sql: "DELETE FROM config WHERE key IN ('dev:sample_data','dev:fixture_import')" },
        { sql: 'UPDATE titles SET quality_gate=1 WHERE id IN (-10001,-10002,-10048,-10049,-10050)' },
      ]);
      const live = await searchTitles(db, 'Sample');
      assert.equal(live.total, 2);
      assert.deepEqual(live.titles.map(title => title.id).sort((a, b) => a - b), [-10002, -10001]);
      const response = await handleSearch(new Request('https://example.test/api/search?q=Sample'), { DB: db });
      assert.equal(((await response.json()) as { results: unknown[] }).results.length, 2);
    });

    await context.test('search pages stay noindex/no-store and distinguish input, missing-page and infrastructure failures', async () => {
      const empty = await loadSearchPage(db, new URL('https://example.test/search/'));
      assert.equal(empty.status, 200); assert.equal(empty.noindex, true); assert.equal(empty.cacheControl, 'no-store');
      const valid = await loadSearchPage(db, new URL('https://example.test/search/?q=Sample&type=movie&rating=&sort='));
      assert.equal(valid.status, 200); assert.equal(valid.filters.sort, undefined); assert.equal(valid.filters.minRating, undefined);
      assert.equal(valid.catalogue.total, 2);
      assert.equal((await loadSearchPage(db, new URL('https://example.test/search/?q=Sample&page=999'))).status, 404);
      const invalid = await loadSearchPage(db, new URL(`https://example.test/search/?q=${'x'.repeat(101)}`));
      assert.equal(invalid.status, 400); assert.equal(invalid.invalid, true); assert.equal(invalid.noindex, true);
      const unavailable = { prepare() { throw new Error('private SQL diagnostic'); } } as unknown as D1Database;
      const failed = await loadSearchPage(unavailable, new URL('https://example.test/search/?q=Sample'));
      assert.equal(failed.status, 503); assert.equal(failed.failed, true); assert.equal(failed.noindex, true); assert.equal(failed.cacheControl, 'no-store');
      const response = await handleSearch(new Request('https://example.test/api/search?q=Sample'), { DB: unavailable });
      assert.equal(response.status, 503);
      assert.equal(JSON.stringify(await response.json()).includes('private SQL diagnostic'), false);
    });
  } finally { await local.dispose(); await rm(directory, { recursive: true, force: true }); }
});
