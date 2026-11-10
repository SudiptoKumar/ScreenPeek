import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { createSeedSql, createRemovalSql, manifest } from '../db/seed.mjs';

test('actual local D1: repeatable sample seed, FTS, safe removal and collision refusal', { timeout: 180_000 }, () => {
  mkdirSync('.cache', { recursive: true });
  const state = mkdtempSync(resolve('.cache/d1-test-'));
  const seedPath = resolve(state, 'seed.sql');
  const marker = manifest.configKey.replaceAll("'", "''");
  const run = (args, expectSuccess = true) => {
    const result = spawnSync(process.execPath, ['scripts/tool.mjs', 'wrangler', 'd1', 'execute', 'DB', '--local', '--persist-to', state, '--json', ...args], {
      cwd: process.cwd(), encoding: 'utf8', maxBuffer: 8 * 1024 * 1024,
    });
    if (expectSuccess) assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`);
    else assert.notEqual(result.status, 0, 'A conflicting reserved ID must refuse the seed');
    if (!expectSuccess) return;
    const output = JSON.parse(result.stdout);
    assert.ok(output.every(entry => entry.success !== false));
    return output;
  };
  const query = command => run(['--command', command]).at(-1).results;
  try {
    assert.equal(createSeedSql(), createSeedSql(), 'Seed SQL must be deterministic');
    assert.equal(readFileSync('db/remove-seed.sql', 'utf8'), createRemovalSql(), 'Removal SQL must match its manifest');
    run(['--file', 'db/schema.sql']);
    query("INSERT INTO titles(id,type,slug,title,overview) VALUES(9000001,'movie','unrelated-local-title','Unrelated local title','Owner data must survive fixture cleanup'); INSERT INTO titles_fts(title,slug,year,type) VALUES('Unrelated local title','unrelated-local-title',2026,'movie');");
    writeFileSync(seedPath, createSeedSql());
    run(['--file', seedPath]);
    run(['--file', seedPath]);
    assert.deepEqual(query('SELECT type,count(*) AS count FROM titles WHERE id<0 GROUP BY type ORDER BY type'), [{ type: 'movie', count: 30 }, { type: 'tv', count: 20 }]);
    assert.equal(query('SELECT count(*) AS count FROM titles')[0].count, 51);
    assert.equal(query("SELECT count(*) AS count FROM titles_fts WHERE titles_fts MATCH 'Sample'")[0].count, 50);
    assert.equal(query('SELECT count(*) AS count FROM people')[0].count, 12);
    assert.equal(query('SELECT count(*) AS count FROM seasons')[0].count, 40);
    assert.equal(query('SELECT count(*) AS count FROM episodes')[0].count, 120);
    assert.equal(query('SELECT count(DISTINCT country) AS count FROM providers')[0].count, 4);
    assert.ok(query('SELECT count(*) AS count FROM titles t WHERE id<0 AND NOT EXISTS(SELECT 1 FROM providers p WHERE p.title_id=t.id AND p.title_type=t.type)')[0].count > 0);
    assert.equal(query('SELECT count(*) AS count FROM titles WHERE quality_gate<>0 OR poster_r2 IS NOT NULL')[0].count, 0);
    assert.equal(query('SELECT count(*) AS count FROM links')[0].count, 0);
    assert.equal(query('SELECT count(*) AS count FROM admin_users')[0].count, 0);
    query("UPDATE titles SET title='Sample: Owner-edited fixture' WHERE id=-10001 AND type='movie'");
    run(['--file', seedPath]);
    assert.equal(query("SELECT title FROM titles WHERE id=-10001 AND type='movie'")[0].title, 'Sample: Owner-edited fixture');
    assert.equal(query("SELECT count(*) AS count FROM titles_fts WHERE titles_fts MATCH 'Owner'")[0].count, 1);
    run(['--file', 'db/remove-seed.sql']);
    assert.equal(query('SELECT count(*) AS count FROM titles')[0].count, 1);
    assert.equal(query('SELECT count(*) AS count FROM titles_fts')[0].count, 1);
    assert.equal(query('SELECT slug FROM titles')[0].slug, 'unrelated-local-title');
    for (const table of ['people', 'credits', 'seasons', 'episodes', 'providers']) assert.equal(query(`SELECT count(*) AS count FROM ${table}`)[0].count, 0);
    assert.equal(query(`SELECT count(*) AS count FROM config WHERE key='${marker}'`)[0].count, 0);
    run(['--file', seedPath]);
    assert.equal(query('SELECT count(*) AS count FROM titles WHERE id<0')[0].count, 50);
    run(['--file', 'db/remove-seed.sql']);
    query("INSERT INTO titles(id,type,slug,title) VALUES(-10001,'movie','reserved-id-collision','Local custom negative ID')");
    run(['--file', seedPath], false);
    assert.equal(query('SELECT count(*) AS count FROM titles WHERE id<0')[0].count, 1);
    assert.equal(query("SELECT title FROM titles WHERE id=-10001")[0].title, 'Local custom negative ID');
    assert.equal(query(`SELECT count(*) AS count FROM config WHERE key='${marker}'`)[0].count, 0);
  } finally {
    rmSync(state, { recursive: true, force: true });
  }
});
