import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import { applyLocalSql, localBindings, applyLocalMigrations } from '../sync/local.ts';
import { createSeedSql } from '../db/seed.mjs';
import { loadHubPage } from '../src/lib/hubs.ts';

const url = (path: string) => new URL(path, 'https://screenpeek.example');

test('taxonomy and list hubs read actual D1 with memberships, ordering, visibility and pagination', { timeout: 15_000 }, async context => {
  const state = await mkdtemp(resolve(tmpdir(), 'screenpeek-hubs-'));
  const local = await localBindings(state);
  const db = local.database as unknown as D1Database;
  try {
    await applyLocalSql(local.database, await readFile('db/schema.sql', 'utf8'));
    await applyLocalSql(local.database, createSeedSql());
    await applyLocalMigrations(local.database);
    await local.db.batch([
      { sql: "INSERT INTO collections(slug,name) VALUES('sample-picks','Sample Picks')" },
      { sql: "INSERT INTO collection_titles(collection_slug,title_id,title_type,source) VALUES('sample-picks',-10001,'movie','manual'),('sample-picks',-10002,'movie','manual'),('sample-picks',-10031,'tv','manual')" },
    ]);

    await context.test('genre and collection grids apply their memberships; language pagination yields 24+24+2 unique titles', async () => {
      const genre = await loadHubPage(db, 'genre', url('/genre/drama/'), 'drama');
      assert.equal(genre.status, 200); assert.equal(genre.catalogue.total, 17); assert.equal(genre.catalogue.titles.length, 17);
      const collection = await loadHubPage(db, 'collection', url('/collection/sample-picks/'), 'sample-picks');
      assert.equal(collection.status, 200); assert.equal(collection.name, 'Sample Picks'); assert.equal(collection.catalogue.total, 3);
      assert.deepEqual(collection.catalogue.titles.map(title => `${title.type}:${title.id}`).sort(), ['movie:-10001', 'movie:-10002', 'tv:-10031']);
      const pages = await Promise.all([1, 2, 3].map(page => loadHubPage(db, 'language', url(`/language/en/?page=${page}`), 'en')));
      assert.deepEqual(pages.map(page => page.catalogue.titles.length), [24, 24, 2]);
      assert.ok(pages.every(page => page.status === 200 && page.catalogue.total === 50 && page.catalogue.pages === 3));
      assert.equal(new Set(pages.flatMap(page => page.catalogue.titles.map(title => `${title.type}:${title.id}`))).size, 50);
      assert.match(pages[1].title, /Page 2$/);
      const outside = await loadHubPage(db, 'language', url('/language/en/?page=4'), 'en');
      assert.equal(outside.status, 404); assert.deepEqual(outside.catalogue.titles, []);
      assert.equal(genre.sample, true); assert.equal(genre.noindex, true); assert.equal(genre.cacheControl, 'no-store');
    });

    await context.test('taxonomy display overrides apply and hiding an override makes its page a 404', async () => {
      await local.db.query("INSERT INTO taxonomy_overrides(kind,slug,display_name,intro,hidden) VALUES('genre','drama','Sample Drama Picks','A fictional curated introduction.',0)");
      const visible = await loadHubPage(db, 'genre', url('/genre/drama/'), 'drama');
      assert.equal(visible.name, 'Sample Drama Picks');
      assert.equal(visible.intro, 'A fictional curated introduction.');
      assert.match(visible.title, /Sample Drama Picks/);
      await local.db.query("UPDATE taxonomy_overrides SET hidden=1 WHERE kind='genre' AND slug='drama'");
      const hidden = await loadHubPage(db, 'genre', url('/genre/drama/'), 'drama');
      assert.equal(hidden.status, 404); assert.equal(hidden.noindex, true); assert.equal(hidden.cacheControl, 'no-store');
      assert.deepEqual(hidden.catalogue.titles, []);
      await local.db.query("UPDATE taxonomy_overrides SET hidden=0 WHERE kind='genre' AND slug='drama'");
    });

    await context.test('missing or SQL-shaped slugs do not expand a taxonomy lookup', async () => {
      for (const kind of ['genre', 'collection', 'language'] as const) {
        for (const slug of ['missing-slug', "drama' OR 1=1 --"]) {
          const missing = await loadHubPage(db, kind, url(`/${kind}/missing/`), slug);
          assert.equal(missing.status, 404); assert.equal(missing.noindex, true);
          assert.deepEqual(missing.catalogue.titles, []);
        }
      }
      assert.equal((await local.db.query('SELECT count(*) AS count FROM titles'))[0].count, 50);
    });

    await context.test('new arrivals sort by added date and top ten contains at most ten titles with no second page', async () => {
      await local.db.batch([
        { sql: "UPDATE titles SET added_at='2026-01-01T00:00:00Z'" },
        { sql: "UPDATE titles SET added_at='2026-11-05T00:00:00Z' WHERE id=-10001" },
        { sql: "UPDATE titles SET added_at='2026-11-07T00:00:00Z' WHERE id=-10002" },
        { sql: "UPDATE titles SET added_at='2026-11-06T00:00:00Z' WHERE id=-10031" },
      ]);
      const newest = await loadHubPage(db, 'new', url('/new/'));
      assert.equal(newest.status, 200); assert.equal(newest.catalogue.total, 50);
      assert.deepEqual(newest.catalogue.titles.slice(0, 3).map(title => title.id), [-10002, -10031, -10001]);
      const top = await loadHubPage(db, 'top10', url('/top10/'));
      assert.equal(top.status, 200); assert.equal(top.catalogue.total, 10);
      assert.equal(top.catalogue.pages, 1); assert.equal(top.catalogue.titles.length, 10);
      assert.deepEqual(top.catalogue.titles.map(title => title.id), Array.from({ length: 10 }, (_, index) => -10050 + index));
      const outside = await loadHubPage(db, 'top10', url('/top10/?page=2'));
      assert.equal(outside.status, 404); assert.deepEqual(outside.catalogue.titles, []);
    });

    await context.test('upcoming contains only visible future releases in ascending date order, including month-group data', async () => {
      await local.db.batch([
        { sql: "UPDATE titles SET release_date=date('now','-1 day')" },
        { sql: "UPDATE titles SET release_date=date('now','+10 days') WHERE id IN (-10001,-10002)" },
        { sql: "UPDATE titles SET release_date=date('now','+50 days') WHERE id=-10031" },
        { sql: "UPDATE titles SET release_date=date('now') WHERE id=-10003" },
        { sql: 'UPDATE titles SET release_date=NULL WHERE id=-10004' },
        { sql: "UPDATE titles SET release_date=date('now','+2 days'),hidden=1 WHERE id=-10005" },
        { sql: "UPDATE titles SET release_date=date('now','+2 days'),deleted=1 WHERE id=-10006" },
        { sql: "UPDATE titles SET release_date=date('now','+2 days'),deleted_at='2026-11-09T00:00:00Z' WHERE id=-10007" },
      ]);
      const upcoming = await loadHubPage(db, 'upcoming', url('/upcoming/'));
      assert.equal(upcoming.status, 200); assert.equal(upcoming.catalogue.total, 3);
      assert.deepEqual(upcoming.catalogue.titles.map(title => title.id), [-10001, -10002, -10031]);
      const dates = upcoming.catalogue.titles.map(title => title.release_date!);
      assert.deepEqual(dates, [...dates].sort());
      assert.equal(new Set(dates.map(date => date.slice(0, 7))).size, 2);
      const today = (await local.db.query("SELECT date('now') AS today"))[0].today as string;
      assert.ok(dates.every(date => date > today));
    });

    await context.test('live hubs exclude ungated titles, retain empty noindex pages and cache successful lists for one hour', async () => {
      await local.db.query("DELETE FROM config WHERE key IN ('dev:sample_data','dev:fixture_import')");
      const empty = await loadHubPage(db, 'collection', url('/collection/sample-picks/'), 'sample-picks');
      assert.equal(empty.status, 200); assert.equal(empty.sample, false); assert.equal(empty.catalogue.total, 0);
      assert.equal(empty.noindex, true); assert.equal(empty.cacheControl, 'public, s-maxage=3600, stale-while-revalidate=604800');
      await local.db.query('UPDATE titles SET quality_gate=1 WHERE id IN (-10001,-10002,-10005)');
      const populated = await loadHubPage(db, 'language', url('/language/en/'), 'en');
      assert.equal(populated.status, 200); assert.equal(populated.catalogue.total, 2); assert.equal(populated.noindex, false);
      assert.deepEqual(populated.catalogue.titles.map(title => title.id), [-10002, -10001]);
      const collection = await loadHubPage(db, 'collection', url('/collection/sample-picks/'), 'sample-picks');
      assert.equal(collection.catalogue.total, 2);
      const upcoming = await loadHubPage(db, 'upcoming', url('/upcoming/'));
      assert.equal(upcoming.catalogue.total, 2);
    });

    await context.test('database failure produces an explicit uncached noindex 503', async () => {
      const unavailable = { prepare() { throw new Error('Simulated hub query failure'); } } as unknown as D1Database;
      const page = await loadHubPage(unavailable, 'genre', url('/genre/drama/'), 'drama');
      assert.equal(page.status, 503); assert.equal(page.failed, true); assert.equal(page.noindex, true);
      assert.equal(page.title, 'Catalogue unavailable'); assert.equal(page.cacheControl, 'no-store');
    });
  } finally {
    await local.dispose();
    await rm(state, { recursive: true, force: true });
  }
});
