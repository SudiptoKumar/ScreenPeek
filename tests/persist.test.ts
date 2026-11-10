import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, rm } from 'node:fs/promises';
import { resolve } from 'node:path';
import { applyLocalSql, localBindings } from '../sync/local.ts';
import { persistPerson, persistTitle, refreshCounts } from '../sync/persist.ts';
import { transformPerson, transformTitle } from '../sync/transform.ts';
import type { SourceDetails } from '../sync/types.ts';

const now = new Date('2026-11-09T08:30:00.000Z');
const later = new Date('2026-11-10T08:30:00.000Z');
const source = (id: number, extra: Partial<SourceDetails> = {}): SourceDetails => ({
  id, title: 'Reliable Source', release_date: '2026-01-15',
  overview: 'A fictional story for a local persistence test. '.repeat(3),
  original_language: 'en', popularity: 20, poster_path: '/poster.jpg',
  genres: [{ id: 1, name: 'Adventure' }, { id: 2, name: 'Drama' }],
  credits: { cast: [{ id: 101, name: 'Sample Actor One' }, { id: 102, name: 'Sample Actor Two' }, { id: 103, name: 'Sample Actor Three' }], crew: [{ id: 104, name: 'Sample Director', job: 'Director' }] },
  'watch/providers': { results: { US: { flatrate: [{ provider_id: 51, provider_name: 'Sample Service' }] } } },
  belongs_to_collection: { id: 78, name: 'Test Collection' },
  production_companies: [{ name: 'Sample Studio' }], budget: 100, revenue: 200,
  ...extra,
});
const transform = (input: SourceDetails, date = now) => transformTitle(input, 'movie', { now: date, usedSlugs: new Set() });
const media = { poster: 'poster/movie_5001_hash_w185.webp', backdrop: 'backdrop/movie_5001_hash_w300.webp', gallery: ['backdrop/movie_5001_hash_w300.webp'] };

test('actual local D1 persists atomically, preserves edits and prevents deleted/blocklisted resurrection', { timeout: 60_000 }, async () => {
  await mkdir('.cache', { recursive: true });
  const state = await mkdtemp(resolve('.cache/persist-test-'));
  const bindings = await localBindings(state);
  const { db } = bindings;
  try {
    await applyLocalSql(bindings.database, await readFile('db/schema.sql', 'utf8'));
    await applyLocalSql(bindings.database, await readFile('db/migrations/001-sync-metadata.sql', 'utf8'));
    const initial = transform(source(5001));
    initial.providers[0].logo_r2 = 'logo/51_hash_w185.webp';
    assert.ok((await persistTitle(db, initial, media)).rowsWritten > 0);
    await persistTitle(db, initial, media);
    const counts = (await db.query('SELECT (SELECT count(*) FROM titles) AS titles,(SELECT count(*) FROM credits) AS credits,(SELECT count(*) FROM providers) AS providers,(SELECT count(*) FROM titles_fts) AS fts,(SELECT count(*) FROM title_genres) AS genres,(SELECT count(*) FROM collection_titles) AS collections'))[0];
    assert.deepEqual(counts, { titles: 1, credits: 4, providers: 1, fts: 1, genres: 2, collections: 1 });
    assert.equal((await db.query('SELECT quality_gate FROM titles WHERE id=5001'))[0].quality_gate, 1);
    await refreshCounts(db);
    assert.equal((await db.query("SELECT title_count FROM genres WHERE slug='adventure'"))[0].title_count, 1);
    assert.equal((await db.query("SELECT title_count FROM languages WHERE slug='en'"))[0].title_count, 1);
    assert.equal((await db.query("SELECT title_count FROM collections WHERE slug='test-collection'"))[0].title_count, 1);
    await db.batch([
      { sql: `UPDATE titles SET title='Owner Title',overview=?,genres='["manual-genre"]',original_language='fr',poster_r2='poster/manual.webp',hidden=1,pinned=1,views=42,locked_fields='["title","overview","genres","original_language","poster_r2"]' WHERE id=5001`, params: ['Manual overview that must survive sync. '.repeat(4)] },
      { sql: "INSERT INTO titles(id,type,slug,title) VALUES(9001,'movie','new-source-2026','Unrelated collision title')" },
      { sql: "INSERT INTO collections(slug,name) VALUES('manual-picks','Owner picks')" },
      { sql: "INSERT INTO collection_titles(collection_slug,title_id,title_type,source) VALUES('manual-picks',5001,'movie','manual')" },
    ]);
    const changed = transform(source(5001, {
      title: 'New Source', overview: 'Short source text', genres: [{ id: 3, name: 'Comedy' }],
      belongs_to_collection: { id: 79, name: 'New Collection' },
    }), later);
    changed.providers[0].provider_name = 'Renamed Sample Service';
    changed.providers[0].logo_r2 = null;
    await persistTitle(db, changed, { poster: null, backdrop: null, gallery: [] });
    const stored = (await db.query('SELECT * FROM titles WHERE id=5001'))[0];
    assert.equal(stored.slug, 'reliable-source-2026');
    assert.equal(stored.added_at, now.toISOString());
    assert.equal(stored.updated_at, later.toISOString());
    assert.equal(stored.title, 'Owner Title');
    assert.equal(stored.overview, 'Manual overview that must survive sync. '.repeat(4));
    assert.equal(stored.poster_r2, 'poster/manual.webp');
    assert.equal(stored.original_language, 'fr');
    assert.equal(stored.genres, '["manual-genre"]');
    assert.equal(stored.hidden, 1); assert.equal(stored.pinned, 1); assert.equal(stored.views, 42);
    assert.equal(stored.quality_gate, 1, 'Gate uses stored locked values, not discarded source text/images');
    assert.deepEqual(await db.query('SELECT genre_slug FROM title_genres WHERE title_id=5001'), [{ genre_slug: 'manual-genre' }]);
    assert.deepEqual(await db.query('SELECT provider_name,logo_r2 FROM providers WHERE title_id=5001'), [{ provider_name: 'Renamed Sample Service', logo_r2: 'logo/51_hash_w185.webp' }]);
    assert.deepEqual(await db.query('SELECT collection_slug,source FROM collection_titles WHERE title_id=5001 ORDER BY collection_slug'), [{ collection_slug: 'manual-picks', source: 'manual' }, { collection_slug: 'new-collection', source: 'tmdb' }]);
    assert.equal((await db.query("SELECT count(*) AS count FROM titles_fts WHERE titles_fts MATCH 'Owner'"))[0].count, 1);
    assert.equal((await db.query("SELECT count(*) AS count FROM titles_fts WHERE titles_fts MATCH 'title:Reliable'"))[0].count, 0, 'Old title text is removed; the permanent slug is intentionally unchanged');
    await refreshCounts(db);
    assert.equal((await db.query("SELECT title_count FROM genres WHERE slug='manual-genre'"))[0].title_count, 0, 'Hidden titles are excluded from public counts');

    await db.query('UPDATE titles SET deleted=1 WHERE id=5001');
    const deleted = (await db.query('SELECT * FROM titles WHERE id=5001'))[0];
    await persistTitle(db, changed, media);
    assert.deepEqual((await db.query('SELECT * FROM titles WHERE id=5001'))[0], deleted);
    await db.query("INSERT INTO blocklist(tmdb_id,type) VALUES(5002,'movie')");
    await persistTitle(db, transform(source(5002, { title: 'Blocked new title' })), media);
    assert.equal((await db.query('SELECT count(*) AS count FROM titles WHERE id=5002'))[0].count, 0);
    const soft = transform(source(5003, { title: 'Soft deleted title' }));
    await persistTitle(db, soft, media);
    await db.query("UPDATE titles SET deleted_at='2026-11-09T10:00:00Z' WHERE id=5003");
    const trashed = (await db.query('SELECT * FROM titles WHERE id=5003'))[0];
    await persistTitle(db, transform(source(5003, { title: 'Must not replace trash' }), later), media);
    assert.deepEqual((await db.query('SELECT * FROM titles WHERE id=5003'))[0], trashed);

    const person = transformPerson({ id: 101, name: 'Sample Actor One', biography: 'Source bio', popularity: 20 }, { now, usedSlugs: new Set() });
    await persistPerson(db, person, 'profile/101_old.webp');
    await db.query(`UPDATE people SET name='Owner Name',bio='Owner bio',profile_r2='profile/manual.webp',locked_fields='["name","bio","profile_r2"]' WHERE id=101`);
    await persistPerson(db, transformPerson({ id: 101, name: 'Changed Source Name', biography: 'New source bio', popularity: 40 }, { now: later, usedSlugs: new Set() }), null);
    const storedPerson = (await db.query('SELECT * FROM people WHERE id=101'))[0];
    assert.equal(storedPerson.name, 'Owner Name'); assert.equal(storedPerson.bio, 'Owner bio');
    assert.equal(storedPerson.profile_r2, 'profile/manual.webp'); assert.equal(storedPerson.slug, person.slug);
    assert.equal(storedPerson.popularity, 40);
    await db.query("UPDATE people SET deleted_at='2026-11-09T10:00:00Z' WHERE id=101");
    const deletedPerson = (await db.query('SELECT * FROM people WHERE id=101'))[0];
    await persistPerson(db, person, null);
    assert.deepEqual((await db.query('SELECT * FROM people WHERE id=101'))[0], deletedPerson);
    await db.query("INSERT INTO blocklist(tmdb_id,type) VALUES(102,'person')");
    await persistPerson(db, transformPerson({ id: 102, name: 'Blocked person' }, { now, usedSlugs: new Set() }), null);
    assert.equal((await db.query('SELECT count(*) AS count FROM people WHERE id=102'))[0].count, 0);

    const tvSource = source(6001, { name: 'Sample TV', first_air_date: '2026-01-15', seasons: [
      { season_number: 1, name: 'Season One', episode_count: 2, air_date: '2026-01-15' },
      { season_number: 2, name: 'Season Two', episode_count: 1, air_date: '2026-03-15' },
    ] });
    const tv = transformTitle(tvSource, 'tv', { now, usedSlugs: new Set() });
    await persistTitle(db, tv, media);
    await persistTitle(db, tv, media);
    assert.equal((await db.query('SELECT count(*) AS count FROM seasons WHERE title_id=6001'))[0].count, 2);
    await db.query("INSERT INTO episodes(title_id,season_number,episode_number,name) VALUES(6001,2,1,'Removed season episode')");
    tv.seasons = tv.seasons.filter(season => season.season_number === 1);
    await persistTitle(db, tv, media);
    assert.equal((await db.query('SELECT count(*) AS count FROM seasons WHERE title_id=6001'))[0].count, 1);
    assert.equal((await db.query('SELECT count(*) AS count FROM episodes WHERE title_id=6001'))[0].count, 0);
    await db.query("INSERT INTO blocklist(tmdb_id,type) VALUES(6001,'tv')");
    const blockedExisting = (await db.query('SELECT * FROM titles WHERE id=6001'))[0];
    tv.title.title = 'Must not replace blocked existing title';
    await persistTitle(db, tv, { poster: null, backdrop: null, gallery: [] });
    assert.deepEqual((await db.query('SELECT * FROM titles WHERE id=6001'))[0], blockedExisting);

    await assert.rejects(db.batch([{ sql: 'UPDATE titles SET hidden=0 WHERE id=5001' }, { sql: 'INSERT INTO nonexistent_table VALUES(1)' }]));
    assert.equal((await db.query('SELECT hidden FROM titles WHERE id=5001'))[0].hidden, 1, 'Native local D1 batch rolls back all writes on failure');
  } finally {
    await bindings.dispose();
    await rm(state, { recursive: true, force: true });
  }
});
