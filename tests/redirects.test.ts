import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import { applyLocalSql, localBindings, applyLocalMigrations } from '../sync/local.ts';
import { ClickBuffer } from '../src/lib/counters.ts';
import { resolveDestination } from '../src/lib/links.ts';
import { handleGo } from '../functions/go/[slug].ts';

test('managed rules prefer country then device, ignore Phase2 splits, and reject unsafe targets', () => {
  const link = { slug: 'sample', name: 'Sample', type: 'affiliate', destination: 'https://default.example.test', enabled: 1,
    rules: JSON.stringify({ byCountry: { GB: 'https://gb.example.test' }, byDevice: { mobile: 'https://mobile.example.test' }, split: [{ url: 'https://split.example.test', pct: 100 }] }) };
  assert.equal(resolveDestination(link, 'GB', 'mobile'), 'https://gb.example.test/');
  assert.equal(resolveDestination(link, 'US', 'mobile'), 'https://mobile.example.test/');
  assert.equal(resolveDestination(link, 'US', 'desktop'), 'https://default.example.test/');
  assert.equal(resolveDestination({ ...link, rules: '{invalid' }, 'GB', 'mobile'), 'https://default.example.test/');
  assert.equal(resolveDestination({ ...link, enabled: 0 }, 'GB', 'mobile'), null);
});

test('actual D1 batches approximate clicks; safe redirects do not wait for logging and have no open URL parameter', { timeout: 15_000 }, async () => {
  const state = await mkdtemp(resolve(tmpdir(), 'screenpeek-go-'));
  const local = await localBindings(state);
  const db = local.database as unknown as D1Database;
  const kv = { async get() { return null; } } as unknown as KVNamespace;
  try {
    await applyLocalSql(local.database, await readFile('db/schema.sql', 'utf8'));
    await applyLocalMigrations(local.database);
    await local.db.batch([{ sql: "INSERT INTO links(slug,name,destination,type) VALUES('sample','Sample','https://default.example.test','affiliate')" }]);
    const buffer = new ClickBuffer(db);
    for (let i = 0; i < 100; i++) buffer.record({ slug: 'sample', day: '2026-11-09', country: 'US', device: 'desktop' });
    assert.equal(buffer.size(), 1);
    assert.equal((await local.db.query<{ count: number }>('SELECT COUNT(*) AS count FROM click_log'))[0].count, 0);
    assert.equal(await buffer.flush(), true);
    assert.equal((await local.db.query<{ count: number }>('SELECT count FROM click_log'))[0].count, 100);
    const tasks: Promise<unknown>[] = [];
    const context = { waitUntil(promise: Promise<unknown>) { tasks.push(promise); } };
    const response = await handleGo(new Request('https://site.test/go/sample?url=https://evil.example.test'), { DB: db, CONFIG: kv }, context, 'sample');
    assert.equal(response.status, 302); assert.equal(response.headers.get('location'), 'https://default.example.test/');
    assert.equal(response.headers.get('cache-control'), 'no-store');
    assert.equal((await local.db.query<{ clicks_total: number }>("SELECT clicks_total FROM links WHERE slug='sample'"))[0].clicks_total, 100);
    await Promise.all(tasks);
    assert.equal((await local.db.query<{ clicks_total: number }>("SELECT clicks_total FROM links WHERE slug='sample'"))[0].clicks_total, 101);
    assert.equal((await handleGo(new Request('https://site.test/go/missing'), { DB: db, CONFIG: kv }, context, 'missing')).headers.get('location'), '/');
    assert.equal((await handleGo(new Request('https://site.test/go/sample', { headers: { Purpose: 'prefetch' } }), { DB: db, CONFIG: kv }, context, 'sample')).status, 204);
    const unavailable = { prepare() { throw new Error('private failure'); } } as unknown as D1Database;
    assert.equal((await handleGo(new Request('https://site.test/go/sample'), { DB: unavailable, CONFIG: kv }, context, 'sample')).headers.get('location'), '/');
    const validKv = { async get() { return { slug: 'sample', name: 'Sample', destination: 'https://default.example.test', enabled: 1, type: 'affiliate', rules: '{}' }; } } as unknown as KVNamespace;
    const loggingFailure = await handleGo(new Request('https://site.test/go/sample'), { DB: unavailable, CONFIG: validKv }, context, 'sample');
    assert.equal(loggingFailure.headers.get('location'), 'https://default.example.test/');
    await Promise.all(tasks);
  } finally { await local.dispose(); await rm(state, { recursive: true, force: true }); }
});
