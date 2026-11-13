import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import { applyLocalSql, localBindings, applyLocalMigrations } from '../sync/local.ts';
import { createSeedSql } from '../db/seed.mjs';
import { launchCountry, loadTitlePage, parseJsonArray } from '../src/lib/detail.ts';

test('detail queries use actual local D1, honour catalogue visibility and read external scores only when enabled', { timeout: 15_000 }, async context => {
  const state = await mkdtemp(resolve(tmpdir(), 'screenpeek-detail-'));
  const local = await localBindings(state);
  const database = local.database as unknown as D1Database;
  const statements: string[] = [];
  const db = new Proxy(database, {
    get(target, property) {
      if (property === 'prepare') return (sql: string) => { statements.push(sql); return target.prepare(sql); };
      const value = Reflect.get(target, property, target);
      return typeof value === 'function' ? value.bind(target) : value;
    },
  });
  try {
    await applyLocalSql(local.database, await readFile('db/schema.sql', 'utf8'));
    await applyLocalSql(local.database, createSeedSql());
    await applyLocalMigrations(local.database);
    const movieSlug = (await local.db.query('SELECT slug FROM titles WHERE id=-10002'))[0].slug as string;
    const tvSlug = (await local.db.query('SELECT slug FROM titles WHERE id=-10032'))[0].slug as string;

    await context.test('movie and TV detail data, cast, genres, providers and ordered seasons load from fixtures', async () => {
        const movie = await loadTitlePage(db, movieSlug, 'movie', 'GB');
      assert.equal(movie.status, 200); assert.equal(movie.failed, false);
      assert.equal(movie.title?.id, -10002); assert.equal(movie.title?.type, 'movie');
      assert.equal(movie.cast.filter(person => person.role === 'cast').length, 3);
      assert.equal(movie.cast.filter(person => person.role === 'director').length, 1);
      assert.deepEqual(movie.genres.map(genre => genre.slug), ['drama']);
      assert.equal(movie.providers.length, 1);
      assert.equal(movie.providers[0].country, 'GB');
      assert.equal(movie.providers[0].offer_type, 'rent');
      assert.deepEqual(movie.seasons, []);
      assert.ok(movie.similar.length > 0 && movie.similar.length <= 12);
      assert.ok(movie.similar.every(title => title.type === 'movie' && title.id !== movie.title?.id));
      assert.equal(movie.sample, true); assert.equal(movie.noindex, true); assert.equal(movie.cacheControl, 'no-store');
      const tv = await loadTitlePage(db, tvSlug, 'tv');
      assert.equal(tv.status, 200); assert.equal(tv.title?.type, 'tv');
      assert.deepEqual(tv.seasons.map(season => season.season_number), [1, 2]);
      assert.ok(tv.cast.some(person => person.role === 'creator'));
      assert.ok(tv.similar.every(title => title.type === 'tv'));
    });

    await context.test('external ratings remain unread while off and use only cached D1 values while on', async () => {
      await local.db.query("INSERT INTO ratings_ext(title_id,title_type,imdb,rt,metacritic,fetched_at) VALUES(-10002,'movie',8.1,90,82,'2026-11-09T00:00:00Z')");
      statements.length = 0;
      assert.equal((await loadTitlePage(db, movieSlug, 'movie')).external, null);
      assert.equal(statements.some(sql => /\bratings_ext\b/.test(sql)), false);
      await local.db.query("UPDATE config SET value='1' WHERE key='ratings_external'");
      statements.length = 0;
      assert.deepEqual((await loadTitlePage(db, movieSlug, 'movie')).external, { imdb: 8.1, rt: 90, metacritic: 82, fetched_at: '2026-11-09T00:00:00Z' });
      assert.equal(statements.filter(sql => /\bratings_ext\b/.test(sql)).length, 1);
      await local.db.query("UPDATE config SET value='0' WHERE key='ratings_external'");
      statements.length = 0;
      assert.equal((await loadTitlePage(db, movieSlug, 'movie')).external, null);
      assert.equal(statements.some(sql => /\bratings_ext\b/.test(sql)), false);
    });

    await context.test('country selection is confined to launch countries, with unsupported input falling back to US', async () => {
      for (const country of ['US', 'GB', 'CA', 'AU']) {
        const page = await loadTitlePage(db, movieSlug, 'movie', country);
        assert.equal(page.country, country);
        assert.ok(page.providers.every(provider => provider.country === country));
      }
      const fallback = await loadTitlePage(db, movieSlug, 'movie', 'FR');
      assert.equal(fallback.country, 'US');
      assert.equal(fallback.providers.length, 1);
      assert.equal(fallback.providers[0].country, 'US');
      for (const value of [undefined, null, '', 'gb', 'not-a-country']) assert.equal(launchCountry(value), 'US');
    });

    await context.test('orphan and soft-deleted people do not appear in the cast', async () => {
      const firstCast = (await loadTitlePage(db, movieSlug, 'movie')).cast[0];
      await local.db.query("UPDATE people SET deleted_at='2026-11-09T00:00:00Z' WHERE id=?", [firstCast.id]);
      await local.db.query("INSERT INTO credits(title_id,title_type,person_id,role,ord) VALUES(-10002,'movie',999999,'cast',99)");
      const page = await loadTitlePage(db, movieSlug, 'movie');
      assert.equal(page.status, 200);
      assert.equal(page.cast.length, 3);
      assert.ok(page.cast.every(person => person.id !== firstCast.id && person.id !== 999999));
    });

    await context.test('missing, wrong-type, hidden and trashed titles are 404; permanent deletion takes 410 precedence', async () => {
      await local.db.batch([
        { sql: 'UPDATE titles SET hidden=1 WHERE id=-10011' },
        { sql: "UPDATE titles SET deleted_at='2026-11-09T00:00:00Z' WHERE id=-10012" },
        { sql: "UPDATE titles SET deleted=1,hidden=1,deleted_at='2026-11-09T00:00:00Z' WHERE id=-10013" },
      ]);
      const cases: Array<{ slug: string; type: 'movie' | 'tv'; status: number }> = [
        { slug: 'unknown-title', type: 'movie', status: 404 },
        { slug: "' OR 1=1 --", type: 'movie', status: 404 },
        { slug: movieSlug, type: 'tv', status: 404 },
      ];
      for (const [id, status] of [[-10011, 404], [-10012, 404], [-10013, 410]]) {
        const row = (await local.db.query('SELECT slug FROM titles WHERE id=?', [id]))[0];
        cases.push({ slug: row.slug as string, type: 'movie', status });
      }
      for (const item of cases) {
        const page = await loadTitlePage(db, item.slug, item.type);
        assert.equal(page.status, item.status);
        assert.equal(page.noindex, true); assert.equal(page.cacheControl, 'no-store');
        assert.deepEqual(page.cast, []); assert.deepEqual(page.providers, []);
      }
    });

    await context.test('malformed or non-array stored JSON does not break detail loading', async () => {
      const slug = (await local.db.query('SELECT slug FROM titles WHERE id=-10001'))[0].slug as string;
      await local.db.query("UPDATE titles SET genres='{broken',similar_ids='{\"wrong\":true}',gallery_r2='not-json' WHERE id=-10001");
      const page = await loadTitlePage(db, slug, 'movie');
      assert.equal(page.status, 200); assert.equal(page.failed, false);
      assert.deepEqual(page.genres, []); assert.deepEqual(page.similar, []);
      assert.deepEqual(parseJsonArray(page.title?.gallery_r2), []);
      for (const value of [undefined, null, '', 'broken', '{}', 'null', '42', '"string"']) assert.deepEqual(parseJsonArray(value), []);
      assert.deepEqual(parseJsonArray('["one",2]'), ['one', 2]);
    });

    await context.test('live mode indexes gated details and limits similar titles to visible gated titles of the same type', async () => {
      await local.db.batch([
        { sql: "DELETE FROM config WHERE key IN ('dev:sample_data','dev:fixture_import')" },
        { sql: 'UPDATE titles SET quality_gate=1 WHERE id IN (-10002,-10003,-10005,-10032)' },
        { sql: 'UPDATE titles SET hidden=1 WHERE id=-10005' },
        { sql: 'UPDATE titles SET similar_ids=? WHERE id=-10002', params: ['[-10002,-10003,-10004,-10005,-10032,"bad",null]'] },
      ]);
      const gated = await loadTitlePage(db, movieSlug, 'movie');
      assert.equal(gated.sample, false); assert.equal(gated.status, 200); assert.equal(gated.noindex, false);
      assert.equal(gated.cacheControl, 'public, s-maxage=86400, stale-while-revalidate=604800');
      assert.deepEqual(gated.similar.map(title => title.id), [-10003]);
      const ungatedSlug = (await local.db.query('SELECT slug FROM titles WHERE id=-10004'))[0].slug as string;
      const ungated = await loadTitlePage(db, ungatedSlug, 'movie');
      assert.equal(ungated.status, 200); assert.equal(ungated.sample, false); assert.equal(ungated.noindex, true);
    });

    await context.test('database failures produce an explicit uncached 503 result', async () => {
      const unavailable = { prepare() { throw new Error('Simulated D1 outage'); } } as unknown as D1Database;
      const page = await loadTitlePage(unavailable, movieSlug, 'movie');
      assert.equal(page.status, 503); assert.equal(page.failed, true); assert.equal(page.noindex, true);
      assert.equal(page.cacheControl, 'no-store');
    });
  } finally {
    await local.dispose();
    await rm(state, { recursive: true, force: true });
  }
});
