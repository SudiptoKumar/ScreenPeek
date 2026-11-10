import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { localBindings, applyLocalSql } from '../sync/local.ts';

const run = promisify(execFile);
const cacheControl = 'public, max-age=31536000, immutable';

test('native local D1 applies the complete multiline schema and migration with Wrangler’s SQL parser', async () => {
  const root = await mkdtemp(join(tmpdir(), 'screenpeek-local-schema-'));
  const local = await localBindings(root);
  try {
    await applyLocalSql(local.database, await readFile(new URL('../db/schema.sql', import.meta.url), 'utf8'));
    await applyLocalSql(local.database, await readFile(new URL('../db/migrations/001-sync-metadata.sql', import.meta.url), 'utf8'));
    const columns = await local.db.query<{ name: string }>('PRAGMA table_info(titles)');
    assert.ok(columns.some(column => column.name === 'gallery_r2'));
    assert.ok(columns.some(column => column.name === 'budget'));
    const tables = await local.db.query<{ name: string }>("SELECT name FROM sqlite_master WHERE type = 'table'");
    assert.ok(tables.some(table => table.name === 'sync_queue'));
    assert.ok(tables.some(table => table.name === 'titles_fts'));
    await applyLocalSql(local.database, `
      -- A quoted semicolon must not split this statement.
      INSERT INTO config (key, value)
      VALUES ('parser_probe', 'first; second');
    `);
    assert.deepEqual(await local.db.query('SELECT value FROM config WHERE key = ?', ['parser_probe']), [{ value: 'first; second' }]);
    assert.deepEqual(await local.db.query("SELECT title FROM titles_fts WHERE titles_fts MATCH 'probe'"), []);
  } finally {
    await local.dispose();
    await rm(root, { recursive: true, force: true });
  }
});

test('local D1 and R2 survive disposal/reopen with object bytes and cache metadata preserved', async () => {
  const root = await mkdtemp(join(tmpdir(), 'screenpeek-local-persist-'));
  let local: Awaited<ReturnType<typeof localBindings>> | undefined;
  try {
    local = await localBindings(root);
    await applyLocalSql(local.database, 'CREATE TABLE persistence_probe (id INTEGER PRIMARY KEY, note TEXT NOT NULL);');
    const writes = await local.db.batch([{ sql: 'INSERT INTO persistence_probe (id, note) VALUES (?, ?)', params: [7, 'persisted'] }]);
    assert.ok(writes.rowsWritten >= 1);
    assert.equal(await local.images.head('poster/probe.webp'), false);
    await local.images.put('poster/probe.webp', new Uint8Array([1, 3, 5]), 'image/webp', cacheControl);
    await local.dispose();
    local = undefined;

    local = await localBindings(root);
    assert.deepEqual(await local.db.query('SELECT id, note FROM persistence_probe WHERE id = ?', [7]), [{ id: 7, note: 'persisted' }]);
    assert.equal(await local.images.head('poster/probe.webp'), true);
    const object = await local.bucket.get('poster/probe.webp');
    assert.ok(object);
    assert.equal(object.httpMetadata?.contentType, 'image/webp');
    assert.equal(object.httpMetadata?.cacheControl, cacheControl);
    assert.deepEqual(new Uint8Array(await object.arrayBuffer()), new Uint8Array([1, 3, 5]));
  } finally {
    await local?.dispose();
    await rm(root, { recursive: true, force: true });
  }
});

test('local bindings share the same D1 persistence layout as Wrangler in both directions', async () => {
  const root = await mkdtemp(join(tmpdir(), 'screenpeek-local-wrangler-'));
  const execute = (sql: string) => run(process.execPath, [
    resolve('node_modules/wrangler/bin/wrangler.js'), 'd1', 'execute', 'movie-db',
    '--local', '--persist-to', root, '--command', sql, '--json',
  ], { env: {
    ...process.env,
    XDG_CONFIG_HOME: process.env.XDG_CONFIG_HOME || resolve('.cache/config'),
    WRANGLER_SEND_METRICS: 'false',
  } });
  let local: Awaited<ReturnType<typeof localBindings>> | undefined;
  try {
    await execute("CREATE TABLE interoperability_probe (id INTEGER PRIMARY KEY, note TEXT); INSERT INTO interoperability_probe VALUES (1, 'from Wrangler');");
    local = await localBindings(root);
    assert.deepEqual(await local.db.query('SELECT note FROM interoperability_probe WHERE id = ?', [1]), [{ note: 'from Wrangler' }]);
    await local.db.batch([{ sql: 'INSERT INTO interoperability_probe VALUES (?, ?)', params: [2, 'from local bindings'] }]);
    await local.dispose();
    local = undefined;
    const { stdout } = await execute('SELECT note FROM interoperability_probe WHERE id = 2');
    const result = JSON.parse(stdout);
    assert.deepEqual(result[0].results, [{ note: 'from local bindings' }]);
  } finally {
    await local?.dispose();
    await rm(root, { recursive: true, force: true });
  }
});
