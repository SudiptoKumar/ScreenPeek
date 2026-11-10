import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import { applyLocalSql, localBindings, applyLocalMigrations } from '../sync/local.ts';
import { VoteBuffer } from '../src/lib/votes.ts';
import { handleVote } from '../functions/api/vote.ts';

const post = (data: unknown, headers: Record<string, string> = {}) => new Request('https://site.test/api/vote/', {
  method: 'POST', headers: { Origin: 'https://site.test', 'Content-Type': 'application/json', 'CF-Connecting-IP': '192.0.2.8', ...headers }, body: JSON.stringify(data),
});
test('vote API rejects malformed, oversized and cross-site requests before storage', async () => {
  const env = { DB: {} as D1Database, CONFIG: {} as KVNamespace }, context = { waitUntil() {} };
  assert.equal((await handleVote(post({ id: 1, type: 'movie', choice: 'good' }, { Origin: 'https://other.test' }), env, context)).status, 403);
  assert.equal((await handleVote(post({ id: 1, type: 'movie', choice: 'other' }), env, context)).status, 400);
  assert.equal((await handleVote(post({ id: 0, type: 'movie', choice: 'good' }), env, context)).status, 400);
  assert.equal((await handleVote(post({ id: 1, type: 'bad', choice: 'good' }), env, context)).status, 400);
  assert.equal((await handleVote(post({ text: 'x'.repeat(600) }), env, context)).status, 413);
  assert.equal((await handleVote(post({}, { 'Content-Type': 'text/plain' }), env, context)).status, 415);
  assert.equal((await handleVote(new Request('https://site.test/api/vote/', { method: 'DELETE' }), env, context)).status, 405);
});

test('actual D1/KV aggregates votes, guards IP/title/day, separates media types, and excludes hidden titles', { timeout: 20_000 }, async () => {
  const state = await mkdtemp(resolve(tmpdir(), 'screenpeek-votes-'));
  const local = await localBindings(state);
  const db = local.database as unknown as D1Database, config = local.config as unknown as KVNamespace;
  const tasks: Promise<unknown>[] = [], context = { waitUntil(promise: Promise<unknown>) { tasks.push(promise); } };
  try {
    await applyLocalSql(local.database, await readFile('db/schema.sql', 'utf8'));
    await applyLocalMigrations(local.database);
    await local.db.batch([
      { sql: "INSERT INTO titles(id,type,slug,title) VALUES(42,'movie','test-movie','Test movie'),(42,'tv','test-tv','Test TV')" },
      { sql: "INSERT INTO titles(id,type,slug,title,hidden) VALUES(43,'movie','hidden','Hidden',1)" },
    ]);
    const buffer = new VoteBuffer(db);
    for (let index = 0; index < 100; index++) buffer.record({ id: 42, type: 'movie', choice: 'must' });
    assert.equal((await local.db.query<{ count: number }>('SELECT COUNT(*) AS count FROM votes'))[0].count, 0);
    assert.equal(await buffer.flush(), true);
    assert.equal((await local.db.query<{ count: number }>("SELECT count FROM votes WHERE title_type='movie'"))[0].count, 100);
    const response = await handleVote(post({ id: 42, type: 'movie', choice: 'good' }), { DB: db, CONFIG: config }, context);
    assert.equal(response.status, 202);
    assert.deepEqual(await response.json(), { accepted: true, counts: { must: 100, good: 1, average: 0, skip: 0 }, approximate: true });
    assert.equal((await local.db.query<{ count: number }>("SELECT COUNT(*) AS count FROM votes WHERE choice='good'"))[0].count, 0);
    assert.equal((await handleVote(post({ id: 42, type: 'movie', choice: 'skip' }), { DB: db, CONFIG: config }, context)).status, 409);
    assert.equal((await handleVote(post({ id: 42, type: 'tv', choice: 'average' }), { DB: db, CONFIG: config }, context)).status, 202);
    assert.equal((await handleVote(post({ id: 43, type: 'movie', choice: 'must' }), { DB: db, CONFIG: config }, context)).status, 404);
    assert.equal((await handleVote(post({ id: 44, type: 'movie', choice: 'must' }), { DB: db, CONFIG: config }, context)).status, 404);
    await Promise.all(tasks);
    const result = await handleVote(new Request('https://site.test/api/vote/?id=42&type=movie'), { DB: db, CONFIG: config }, context);
    assert.deepEqual(await result.json(), { counts: { must: 100, good: 1, average: 0, skip: 0 }, approximate: true });
    assert.equal((await local.db.query<{ count: number }>("SELECT count FROM votes WHERE title_type='tv'"))[0].count, 1);
    const markers = await local.config.list({ prefix: 'vote:' });
    assert.equal(markers.keys.length, 2);
    assert.ok(markers.keys.every(value => /^vote:\d{4}-\d{2}-\d{2}:[a-f0-9]{64}$/.test(value.name)));
    buffer.record({ id: 43, type: 'movie', choice: 'good' });
    await buffer.flush();
    assert.equal((await local.db.query<{ count: number }>('SELECT COUNT(*) AS count FROM votes WHERE title_id=43'))[0].count, 0);
  } finally { await Promise.all(tasks); await local.dispose(); await rm(state, { recursive: true, force: true }); }
});
