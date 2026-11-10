import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { localBindings, applyLocalSql, applyLocalMigrations } from '../sync/local.ts';
import { runSync } from '../sync/engine.ts';
import { fixtureSource } from '../sync/fixtures.ts';
import { TmdbError } from '../sync/tmdb.ts';

test('local importer: 50 titles with owned images, FTS, seasons and idempotent rerun; locks and queued overflow', { timeout: 90_000 }, async () => {
  const root = await mkdtemp(resolve(tmpdir(), 'screenpeek-engine-'));
  const local = await localBindings(root);
  try {
    await applyLocalSql(local.database, await readFile('db/schema.sql', 'utf8'));
    await applyLocalMigrations(local.database);
    const source = fixtureSource();
    const options = { db: local.db, client: source, images: local.images, now: () => new Date('2026-11-09T00:00:00Z'), environment: {} };
    const first = await runSync(options);
    assert.equal(first.status, 'ok', JSON.stringify(first));
    assert.equal(first.added, 50);
    assert.equal(first.updated, 0);
    assert.equal((await local.db.query<{ count: number }>('SELECT COUNT(*) AS count FROM titles WHERE quality_gate=1'))[0].count, 50);
    assert.equal((await local.db.query<{ count: number }>("SELECT COUNT(*) AS count FROM titles WHERE quality_gate=1 AND og_r2 LIKE 'og/%'"))[0].count, 50);
    assert.equal((await local.db.query<{ count: number }>("SELECT COUNT(*) AS count FROM titles WHERE poster_color GLOB '#[a-f0-9][a-f0-9][a-f0-9][a-f0-9][a-f0-9][a-f0-9]'"))[0].count, 50);
    assert.equal((await local.db.query<{ count: number }>("SELECT COUNT(*) AS count FROM titles_fts WHERE titles_fts MATCH 'Lantern'"))[0].count, 50);
    assert.equal((await local.db.query<{ count: number }>('SELECT COUNT(*) AS count FROM episodes'))[0].count, 40);
    const row = (await local.db.query<{ poster_r2: string }>('SELECT poster_r2 FROM titles WHERE id=8000001'))[0];
    const poster = await local.bucket.head(row.poster_r2);
    assert.equal(poster?.httpMetadata?.contentType, 'image/webp');
    assert.equal(poster?.httpMetadata?.cacheControl, 'public, max-age=31536000, immutable');
    const downloads = source.downloads();
    await local.db.batch([{ sql: `UPDATE titles SET title='Owner-edited title',locked_fields='["title"]' WHERE id=8000001` }]);
    const second = await runSync(options);
    assert.equal(second.status, 'ok', JSON.stringify(second));
    assert.equal(second.added, 0);
    assert.equal(second.updated, 50);
    assert.equal(source.downloads(), downloads, 'unchanged R2 images must not download again');
    assert.equal((await local.db.query<{ count: number }>('SELECT COUNT(*) AS count FROM titles'))[0].count, 50);
    assert.equal((await local.db.query<{ title: string }>('SELECT title FROM titles WHERE id=8000001'))[0].title, 'Owner-edited title');
    assert.equal((await local.db.query<{ count: number }>("SELECT COUNT(*) AS count FROM titles_fts WHERE titles_fts MATCH 'Owner'"))[0].count, 1);
    const capped = await runSync({ ...options, maxTitles: 1 });
    assert.equal(capped.status, 'partial');
    assert.equal((await local.db.query<{ count: number }>('SELECT COUNT(*) AS count FROM sync_queue'))[0].count, 49);
    assert.equal((await local.db.query<{ status: string }>('SELECT status FROM sync_log ORDER BY id DESC LIMIT 1'))[0].status, 'partial');
  } finally { await local.dispose(); await rm(root, { recursive: true, force: true }); }
});

test('source failures keep existing data; removed source titles are hidden and leave the retry queue', { timeout: 30_000 }, async () => {
  const root = await mkdtemp(resolve(tmpdir(), 'screenpeek-engine-failure-'));
  const local = await localBindings(root);
  try {
    await applyLocalSql(local.database, await readFile('db/schema.sql', 'utf8'));
    await applyLocalMigrations(local.database);
    const source = fixtureSource(1);
    const options = { db: local.db, client: source, images: local.images, environment: {} };
    assert.equal((await runSync(options)).added, 1);
    const unavailable = { ...source, async changes(): Promise<never> { throw new Error('Upstream failure with sensitive details'); } };
    const failed = await runSync({ ...options, client: unavailable });
    assert.equal(failed.status, 'failed');
    assert.equal(failed.errors.join().includes('sensitive details'), false);
    assert.equal((await local.db.query<{ count: number }>('SELECT COUNT(*) AS count FROM titles'))[0].count, 1);
    await local.db.batch([{ sql: "INSERT INTO sync_queue VALUES(8000001,'movie',?,?)", params: [JSON.stringify({ id: 8000001, type: 'movie', changed: true }), new Date().toISOString()] }]);
    const removed = { ...source, async details<T>(): Promise<T> { throw new TmdbError(404); } };
    const partial = await runSync({ ...options, client: removed });
    assert.equal(partial.status, 'partial');
    const row = (await local.db.query<{ hidden: number; deleted: number }>('SELECT hidden,deleted FROM titles'))[0];
    assert.deepEqual(row, { hidden: 1, deleted: 0 });
    assert.equal((await local.db.query<{ count: number }>('SELECT COUNT(*) AS count FROM sync_queue'))[0].count, 0);
  } finally { await local.dispose(); await rm(root, { recursive: true, force: true }); }
});
