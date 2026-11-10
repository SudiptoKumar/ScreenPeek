import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import { localBindings, applyLocalSql } from '../sync/local.ts';

test('migrated sample helpers maintain taxonomy relations and preserve unrelated references on removal', { timeout: 40_000 }, async () => {
  const state = await mkdtemp(resolve(tmpdir(), 'screenpeek-migrated-seed-'));
  const local = await localBindings(state);
  try {
    await applyLocalSql(local.database, await readFile('db/schema.sql', 'utf8'));
    await applyLocalSql(local.database, await readFile('db/migrations/001-sync-metadata.sql', 'utf8'));
    execFileSync(process.execPath, ['scripts/tool.mjs', 'node', 'scripts/seed-local.mjs', state], { encoding: 'utf8' });
    assert.equal((await local.db.query<{ count: number }>('SELECT COUNT(*) AS count FROM titles'))[0].count, 50);
    assert.ok((await local.db.query<{ count: number }>('SELECT COUNT(*) AS count FROM title_genres'))[0].count > 50);
    assert.equal((await local.db.query<{ count: number }>("SELECT COUNT(*) AS count FROM collection_titles WHERE collection_slug='sample-collection'"))[0].count, 6);
    await local.db.batch([
      { sql: "INSERT INTO titles(id,type,slug,title,genres) VALUES(6001,'movie','owner-title','Owner title','[\"drama\"]')" },
      { sql: "INSERT INTO title_genres VALUES(6001,'movie','drama')" },
      { sql: "INSERT INTO collections(slug,name) VALUES('owner-list','Owner list')" },
      { sql: "INSERT INTO collection_titles(collection_slug,title_id,title_type) VALUES('owner-list',6001,'movie')" },
      { sql: "INSERT INTO credits(title_id,title_type,person_id,role) VALUES(6001,'movie',-20001,'cast')" },
    ]);
    execFileSync(process.execPath, ['scripts/tool.mjs', 'node', 'scripts/remove-seed.mjs', state], { encoding: 'utf8' });
    assert.equal((await local.db.query<{ count: number }>('SELECT COUNT(*) AS count FROM titles'))[0].count, 1);
    assert.equal((await local.db.query<{ title_id: number }>('SELECT title_id FROM title_genres'))[0].title_id, 6001);
    assert.equal((await local.db.query<{ title_id: number }>('SELECT title_id FROM collection_titles'))[0].title_id, 6001);
    assert.equal((await local.db.query<{ id: number }>('SELECT id FROM people'))[0].id, -20001);
  } finally { await local.dispose(); await rm(state, { recursive: true, force: true }); }
});
