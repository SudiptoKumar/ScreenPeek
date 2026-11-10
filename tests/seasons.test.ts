import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import { applyLocalSql, localBindings, applyLocalMigrations } from '../sync/local.ts';
import { createSeedSql } from '../db/seed.mjs';
import { episodePath, loadEpisodePage, loadSeasonPage, seasonPath } from '../src/lib/seasons.ts';

test('season and episode queries use actual D1 with canonical paths, visibility and pagination', { timeout: 15_000 }, async context => {
  const state = await mkdtemp(resolve(tmpdir(), 'screenpeek-seasons-'));
  const local = await localBindings(state);
  const db = local.database as unknown as D1Database;
  try {
    await applyLocalSql(local.database, await readFile('db/schema.sql', 'utf8'));
    await applyLocalSql(local.database, createSeedSql());
    await applyLocalMigrations(local.database);
    const tvSlug = (await local.db.query('SELECT slug FROM titles WHERE id=-10032'))[0].slug as string;
    const movieSlug = (await local.db.query('SELECT slug FROM titles WHERE id=-10002'))[0].slug as string;

    await context.test('season two lists its three episodes in order and episode navigation handles first/middle/last', async () => {
      const season = await loadSeasonPage(db, tvSlug, '2');
      assert.equal(season.status, 200); assert.equal(season.failed, false);
      assert.equal(season.title?.id, -10032); assert.equal(season.season?.season_number, 2);
      assert.equal(season.total, 3); assert.equal(season.pages, 1);
      assert.deepEqual(season.episodes.map(episode => episode.episode_number), [1, 2, 3]);
      assert.equal(season.sample, true); assert.equal(season.noindex, true); assert.equal(season.cacheControl, 'no-store');
      const first = await loadEpisodePage(db, tvSlug, '2', '1');
      const middle = await loadEpisodePage(db, tvSlug, '2', '2');
      const last = await loadEpisodePage(db, tvSlug, '2', '3');
      assert.equal(first.status, 200); assert.equal(first.episode?.episode_number, 1);
      assert.equal(first.previous, null); assert.equal(first.next?.episode_number, 2);
      assert.equal(middle.status, 200); assert.equal(middle.previous?.episode_number, 1); assert.equal(middle.next?.episode_number, 3);
      assert.equal(last.status, 200); assert.equal(last.previous?.episode_number, 2); assert.equal(last.next, null);
      assert.equal(middle.noindex, true); assert.equal(middle.cacheControl, 'no-store');
      assert.equal(seasonPath('sample title/%', 0), '/tv/sample%20title%2F%25/season/0/');
      assert.equal(episodePath('sample-show', 2, 3), '/tv/sample-show/season/2/episode/3/');
    });

    await context.test('specials use canonical season zero; missing and malformed path numbers are 404', async () => {
      await local.db.batch([
        { sql: "INSERT INTO seasons(title_id,season_number,name,episode_count) VALUES(-10032,0,'Sample Specials',2)" },
        { sql: "INSERT INTO episodes(title_id,season_number,episode_number,name) VALUES(-10032,0,1,'Special One'),(-10032,0,2,'Special Two')" },
      ]);
      const specials = await loadSeasonPage(db, tvSlug, '0');
      assert.equal(specials.status, 200); assert.equal(specials.total, 2);
      assert.equal((await loadEpisodePage(db, tvSlug, '0', '1')).next?.episode_number, 2);
      assert.equal((await loadSeasonPage(db, tvSlug, '99')).status, 404);
      assert.equal((await loadEpisodePage(db, tvSlug, '2', '99')).status, 404);
      assert.equal((await loadSeasonPage(db, 'missing-series', '1')).status, 404);
      assert.equal((await loadSeasonPage(db, movieSlug, '1')).status, 404);
      assert.equal((await loadEpisodePage(db, movieSlug, '1', '1')).status, 404);
      for (const value of ['00', '01', '-1', '1.0', '1e0', '9007199254740992']) {
        const season = await loadSeasonPage(db, tvSlug, value);
        assert.equal(season.status, 404, `Season path ${value} must not coerce to a valid season`);
        assert.equal(season.noindex, true); assert.equal(season.cacheControl, 'no-store');
      }
      for (const value of ['0', '01', '-1', '1.0', '1e0', '9007199254740992']) {
        const episode = await loadEpisodePage(db, tvSlug, '2', value);
        assert.equal(episode.status, 404, `Episode path ${value} must not coerce to a valid episode`);
        assert.equal(episode.noindex, true); assert.equal(episode.cacheControl, 'no-store');
      }
    });

    await context.test('24-row pagination keeps order, reaches later episodes and rejects pages beyond the last', async () => {
      await local.db.batch([
        { sql: "INSERT INTO episodes(title_id,season_number,episode_number,name) SELECT -10032,1,value,'Sample extra episode '||value FROM json_each(?)", params: [JSON.stringify(Array.from({ length: 24 }, (_, index) => 27 - index))] },
        { sql: 'UPDATE seasons SET episode_count=27 WHERE title_id=-10032 AND season_number=1' },
      ]);
      const first = await loadSeasonPage(db, tvSlug, '1', '1');
      const second = await loadSeasonPage(db, tvSlug, '1', '2');
      const outside = await loadSeasonPage(db, tvSlug, '1', '3');
      assert.equal(first.total, 27); assert.equal(first.pages, 2); assert.equal(first.episodes.length, 24);
      assert.deepEqual(first.episodes.map(episode => episode.episode_number), Array.from({ length: 24 }, (_, index) => index + 1));
      assert.equal(second.status, 200); assert.equal(second.page, 2);
      assert.deepEqual(second.episodes.map(episode => episode.episode_number), [25, 26, 27]);
      assert.equal(outside.status, 404); assert.deepEqual(outside.episodes, []); assert.equal(outside.noindex, true);
      const episode = await loadEpisodePage(db, tvSlug, '1', '27');
      assert.equal(episode.status, 200); assert.equal(episode.episode?.episode_number, 27);
      assert.equal(episode.previous?.episode_number, 26); assert.equal(episode.next, null);
    });

    await context.test('hidden and trashed parents are 404; permanent deletion takes 410 precedence', async () => {
      await local.db.batch([
        { sql: 'UPDATE titles SET hidden=1 WHERE id=-10033' },
        { sql: "UPDATE titles SET deleted_at='2026-11-09T00:00:00Z' WHERE id=-10034" },
        { sql: "UPDATE titles SET deleted=1,hidden=1,deleted_at='2026-11-09T00:00:00Z' WHERE id=-10035" },
      ]);
      for (const [id, status] of [[-10033, 404], [-10034, 404], [-10035, 410]]) {
        const slug = (await local.db.query('SELECT slug FROM titles WHERE id=?', [id]))[0].slug as string;
        const season = await loadSeasonPage(db, slug, '1');
        const episode = await loadEpisodePage(db, slug, '1', '1');
        assert.equal(season.status, status); assert.equal(episode.status, status);
        assert.deepEqual(season.episodes, []); assert.equal(episode.episode, null);
        assert.equal(season.noindex, true); assert.equal(episode.noindex, true);
        assert.equal(season.cacheControl, 'no-store'); assert.equal(episode.cacheControl, 'no-store');
      }
    });

    await context.test('live ungated parents remain noindex; successful live pages use the documented cache policy', async () => {
      await local.db.query("DELETE FROM config WHERE key IN ('dev:sample_data','dev:fixture_import')");
      const ungated = await loadSeasonPage(db, tvSlug, '2');
      const ungatedEpisode = await loadEpisodePage(db, tvSlug, '2', '2');
      assert.equal(ungated.sample, false); assert.equal(ungated.status, 200); assert.equal(ungated.noindex, true);
      assert.equal(ungatedEpisode.noindex, true);
      assert.equal(ungated.cacheControl, 'public, s-maxage=86400, stale-while-revalidate=604800');
      await local.db.query('UPDATE titles SET quality_gate=1 WHERE id=-10032');
      assert.equal((await loadSeasonPage(db, tvSlug, '2')).noindex, false);
      const gatedEpisode = await loadEpisodePage(db, tvSlug, '2', '2');
      assert.equal(gatedEpisode.noindex, false);
      assert.equal(gatedEpisode.cacheControl, 'public, s-maxage=86400, stale-while-revalidate=604800');
    });

    await context.test('episode-query failure is an explicit uncached 503 and preserves the failure flag', async () => {
      const failingDb = new Proxy(db, {
        get(target, property) {
          if (property === 'prepare') return (sql: string) => {
            if (/episode_number=\?/.test(sql)) throw new Error('Simulated episode read failure');
            return target.prepare(sql);
          };
          const value = Reflect.get(target, property, target);
          return typeof value === 'function' ? value.bind(target) : value;
        },
      });
      const episode = await loadEpisodePage(failingDb, tvSlug, '2', '2');
      assert.equal(episode.status, 503); assert.equal(episode.failed, true);
      assert.equal(episode.noindex, true); assert.equal(episode.cacheControl, 'no-store');
      const unavailable = { prepare() { throw new Error('Simulated parent database failure'); } } as unknown as D1Database;
      const parentFailure = await loadEpisodePage(unavailable, tvSlug, '2', '2');
      assert.equal(parentFailure.status, 503); assert.equal(parentFailure.failed, true);
    });
  } finally {
    await local.dispose();
    await rm(state, { recursive: true, force: true });
  }
});
