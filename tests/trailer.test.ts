import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import { applyLocalSql, localBindings, applyLocalMigrations } from '../sync/local.ts';
import { createSeedSql } from '../db/seed.mjs';
import { loadTrailerPage, validTrailerKey } from '../src/lib/trailer.ts';

const movieKey = 'SampleKey_1';
const tvKey = 'TVSample-_1';

test('trailer keys accept exactly eleven URL-safe identifier characters', () => {
  for (const value of [movieKey, tvKey, 'a'.repeat(11), '0_-AbCdEfG1']) assert.equal(validTrailerKey(value), true);
  for (const value of [undefined, null, 12345678901, true, {}, [], '', 'a'.repeat(10), 'a'.repeat(12), `${movieKey}\n`, ` ${movieKey}`, `${movieKey} `, 'https://www.youtube.com/watch?v=SampleKey_1', '../Sample_1', '<script>123', 'é'.repeat(11)]) {
    assert.equal(validTrailerKey(value), false, `Reject invalid key ${JSON.stringify(value)}`);
  }
});

test('trailer data uses actual D1 metadata and inherits catalogue status without source API requests', { timeout: 15_000 }, async context => {
  const state = await mkdtemp(resolve(tmpdir(), 'screenpeek-trailer-'));
  const local = await localBindings(state);
  const db = local.database as unknown as D1Database;
  try {
    await applyLocalSql(local.database, await readFile('db/schema.sql', 'utf8'));
    await applyLocalSql(local.database, createSeedSql());
    await applyLocalMigrations(local.database);
    const movieSlug = (await local.db.query('SELECT slug FROM titles WHERE id=-10002'))[0].slug as string;
    const tvSlug = (await local.db.query('SELECT slug FROM titles WHERE id=-10032'))[0].slug as string;

    await context.test('movie and TV lookups retain their type, related data and validated cached key', async () => {
      await local.db.batch([
        { sql: 'UPDATE titles SET trailer_key=? WHERE id=-10002', params: [movieKey] },
        { sql: 'UPDATE titles SET trailer_key=? WHERE id=-10032', params: [tvKey] },
      ]);
      const movie = await loadTrailerPage(db, movieSlug);
      const tv = await loadTrailerPage(db, tvSlug);
      assert.equal(movie.status, 200); assert.equal(movie.failed, false); assert.equal(movie.key, movieKey);
      assert.equal(movie.title?.type, 'movie'); assert.ok(movie.similar.length > 0 && movie.similar.length <= 12);
      assert.equal(tv.status, 200); assert.equal(tv.key, tvKey); assert.equal(tv.title?.type, 'tv');
      assert.equal(tv.title?.id, -10032); assert.equal(tv.seasons.length, 2);
      assert.equal(movie.sample, true); assert.equal(movie.noindex, true); assert.equal(movie.cacheControl, 'no-store');
    });

    await context.test('missing or invalid keys keep a successful live detail response noindex with its normal cache policy', async () => {
      await local.db.batch([
        { sql: "DELETE FROM config WHERE key IN ('dev:sample_data','dev:fixture_import')" },
        { sql: 'UPDATE titles SET quality_gate=1,trailer_key=NULL WHERE id=-10002' },
      ]);
      const missing = await loadTrailerPage(db, movieSlug);
      assert.equal(missing.status, 200); assert.equal(missing.sample, false); assert.equal(missing.key, null);
      assert.equal(missing.noindex, true);
      assert.equal(missing.cacheControl, 'public, s-maxage=86400, stale-while-revalidate=604800');
      await local.db.query('UPDATE titles SET trailer_key=? WHERE id=-10002', ['not-an-identifier']);
      const invalid = await loadTrailerPage(db, movieSlug);
      assert.equal(invalid.status, 200); assert.equal(invalid.key, null); assert.equal(invalid.noindex, true);
      await local.db.query('UPDATE titles SET trailer_key=? WHERE id=-10002', [movieKey]);
      const valid = await loadTrailerPage(db, movieSlug);
      assert.equal(valid.status, 200); assert.equal(valid.key, movieKey); assert.equal(valid.noindex, false);
      assert.equal(valid.cacheControl, missing.cacheControl);
    });

    await context.test('hidden, trashed, permanently deleted and missing titles inherit their correct uncached status', async () => {
      await local.db.batch([
        { sql: 'UPDATE titles SET hidden=1 WHERE id=-10011' },
        { sql: "UPDATE titles SET deleted_at='2026-11-09T00:00:00Z' WHERE id=-10012" },
        { sql: "UPDATE titles SET deleted=1,hidden=1,deleted_at='2026-11-09T00:00:00Z' WHERE id=-10013" },
      ]);
      const cases: Array<[string, number]> = [['missing-title', 404], ["' OR 1=1 --", 404]];
      for (const [id, status] of [[-10011, 404], [-10012, 404], [-10013, 410]]) {
        const slug = (await local.db.query('SELECT slug FROM titles WHERE id=?', [id]))[0].slug as string;
        cases.push([slug, status]);
      }
      for (const [slug, status] of cases) {
        const page = await loadTrailerPage(db, slug);
        assert.equal(page.status, status); assert.equal(page.failed, false);
        assert.equal(page.noindex, true); assert.equal(page.cacheControl, 'no-store');
      }
    });

    await context.test('type-lookup and database failures return an explicit uncached 503', async () => {
      const unavailable = { prepare() { throw new Error('Simulated D1 outage'); } } as unknown as D1Database;
      const down = await loadTrailerPage(unavailable, movieSlug);
      assert.equal(down.status, 503); assert.equal(down.failed, true); assert.equal(down.noindex, true); assert.equal(down.cacheControl, 'no-store');
      const typeFailure = new Proxy(db, {
        get(target, property) {
          if (property === 'prepare') return (sql: string) => {
            if (sql.startsWith('SELECT type FROM titles WHERE slug=')) throw new Error('Simulated type lookup failure');
            return target.prepare(sql);
          };
          const value = Reflect.get(target, property, target);
          return typeof value === 'function' ? value.bind(target) : value;
        },
      });
      const failed = await loadTrailerPage(typeFailure, movieSlug);
      assert.equal(failed.title?.id, -10002, 'A later successful read must not hide the preceding lookup failure');
      assert.equal(failed.status, 503); assert.equal(failed.failed, true);
      assert.equal(failed.noindex, true); assert.equal(failed.cacheControl, 'no-store');
    });
  } finally {
    await local.dispose();
    await rm(state, { recursive: true, force: true });
  }
});
