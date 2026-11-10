import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import { localBindings, applyLocalSql, applyLocalMigrations } from '../sync/local.ts';
import { createSeedSql } from '../db/seed.mjs';
import { loadWatchPage } from '../src/lib/watch.ts';
import { countryCookie, requestCountry } from '../src/lib/geo.ts';
import { httpsDestination, linkActive } from '../src/lib/links.ts';

test('country preference is constrained and links fail closed on unsafe destinations/schedules', () => {
  assert.equal(requestCountry(new Request('https://site.test/watch/a/?country=GB', { headers: { Cookie: 'country=CA', 'CF-IPCountry': 'AU' } })), 'GB');
  assert.equal(requestCountry(new Request('https://site.test/watch/a/', { headers: { Cookie: 'country=CA', 'CF-IPCountry': 'AU' } })), 'CA');
  assert.equal(requestCountry(new Request('https://site.test/watch/a/', { headers: { 'CF-IPCountry': 'AU' } })), 'AU');
  assert.equal(requestCountry(new Request('https://site.test/watch/a/?country=unknown')), 'US');
  assert.match(countryCookie('GB'), /SameSite=Lax; Secure/);
  for (const destination of ['javascript:alert(1)', 'http://example.test', 'https://user:pass@example.test']) assert.equal(httpsDestination(destination), false);
  const link = { slug: 'test', name: 'Test', destination: 'https://example.test', type: 'affiliate', enabled: 1, rules: '{}' };
  assert.equal(linkActive(link), true);
  assert.equal(linkActive({ ...link, starts_at: '2099-01-01T00:00:00Z' }), false);
  assert.equal(linkActive({ ...link, ends_at: '2000-01-01T00:00:00Z' }), false);
});

test('watch data groups owned provider metadata by country and emits only configured go links', async () => {
  const root = await mkdtemp(resolve(tmpdir(), 'screenpeek-watch-'));
  const local = await localBindings(root);
  const db = local.database as unknown as D1Database;
  const empty = { async get() { return null; } } as unknown as KVNamespace;
  try {
    await applyLocalSql(local.database, await readFile('db/schema.sql', 'utf8'));
    await applyLocalSql(local.database, createSeedSql());
    await applyLocalMigrations(local.database);
    const title = (await local.db.query<{ slug: string }>('SELECT slug FROM titles WHERE id=-10002'))[0];
    const request = new Request('https://site.test/watch/title/?country=GB');
    const unconfigured = await loadWatchPage(db, empty, title.slug, request);
    assert.equal(unconfigured.status, 200);
    assert.ok(unconfigured.providers.every(provider => provider.country === 'GB' && provider.href === null));
    await local.db.batch([{ sql: "INSERT INTO links(slug,name,destination,type) VALUES('prov-sample-30002','Sample provider','https://provider.example.test','affiliate')" }]);
    const configured = await loadWatchPage(db, empty, title.slug, request);
    assert.equal(configured.providers[0].href, '/go/prov-sample-30002/');
    assert.equal(configured.providers[0].offer_type, 'rent');
    assert.equal(configured.cacheControl, 'private, no-store');
    assert.equal(configured.availableCountries.length, 4);
    const disabledKv = { async get() { return { slug: 'prov-sample-30002', destination: 'https://provider.example.test', enabled: 0 }; } } as unknown as KVNamespace;
    assert.equal((await loadWatchPage(db, disabledKv, title.slug, request)).providers[0].href, null);
    assert.equal((await loadWatchPage(db, empty, 'missing', request)).status, 404);
  } finally { await local.dispose(); await rm(root, { recursive: true, force: true }); }
});
