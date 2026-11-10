import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import { localBindings, applyLocalSql } from '../sync/local.ts';
import { AdminError } from '../src/lib/admin/access.ts';
import type { AdminIdentity } from '../src/lib/admin/access.ts';
import { applyAdminAction } from '../src/lib/admin/actions.ts';
import { dispatchJob, purgeCache } from '../src/lib/admin/changes.ts';
import { globalSearch } from '../src/lib/admin/tools.ts';
import { previewCountryOf, requestCountry } from '../src/lib/geo.ts';
import { cachedCatalogue } from '../src/lib/catalogue-cache.ts';

const owner: AdminIdentity = { email: 'owner@example.test', role: 'owner', modules: {} };
const noNet = (async () => Response.json({ success: false })) as typeof fetch;

async function fixture() {
  const state = await mkdtemp(resolve(tmpdir(), 'screenpeek-tools-'));
  const local = await localBindings(state);
  const env = {
    DB: local.database as unknown as D1Database, CONFIG: local.config as unknown as KVNamespace,
    GITHUB_REPO: 'owner/repo', GITHUB_ACTIONS_TOKEN: 'gh-token',
    CLOUDFLARE_ZONE_ID: 'a'.repeat(32), CLOUDFLARE_API_TOKEN: 'cf-token',
  };
  await applyLocalSql(local.database, await readFile('db/schema.sql', 'utf8'));
  for (const file of (await readdir('db/migrations')).filter(name => name.endsWith('.sql')).sort()) await applyLocalSql(local.database, await readFile(`db/migrations/${file}`, 'utf8'));
  await local.db.batch([
    { sql: "INSERT INTO titles(id,type,slug,title,popularity) VALUES(1,'movie','test-film','Test Film',50),(2,'tv','test-show','Test Show',40)" },
    { sql: "INSERT INTO people(id,slug,name,popularity) VALUES(1,'test-person','Test Person',10)" },
    { sql: "INSERT INTO links(slug,name,type,destination,enabled) VALUES('test-link','Test Link','smartlink','https://example.com/',1)" },
    { sql: "INSERT INTO pages(slug,title,body_md) VALUES('test-page','Test Page','Body')" },
    { sql: "INSERT INTO redirects(from_path,to_target,type) VALUES('/old-test/','/movies/',301)" },
  ]);
  return { state, env, dispose: local.dispose };
}

test('global admin search finds every entity group, escapes wildcards and hides trashed rows', async () => {
  const { state, env, dispose } = await fixture();
  try {
    const all = await globalSearch(env.DB, 'test');
    assert.equal(all.titles.length, 2);
    assert.equal(all.people.length, 1);
    assert.equal(all.links.length, 1);
    assert.equal(all.pages.length, 1);
    assert.equal(all.redirects.length, 1);
    assert.equal((await globalSearch(env.DB, 'Test Film')).titles[0]?.slug, 'test-film');
    assert.equal((await globalSearch(env.DB, 'test%')).titles.length, 0);
    assert.equal((await globalSearch(env.DB, 't')).titles.length, 0);
    await env.DB.prepare("UPDATE titles SET deleted_at=datetime('now') WHERE id=2").run();
    assert.equal((await globalSearch(env.DB, 'test')).titles.length, 1);
  } finally { await dispose(); await rm(state, { recursive: true, force: true }); }
});

test('run-any-job dispatches the backup workflow with an audit trail and fails honestly', async () => {
  const { state, env, dispose } = await fixture();
  try {
    const seen: string[] = [];
    const accepted = (async (input: RequestInfo | URL) => { seen.push(String(input)); return new Response(null, { status: 204 }); }) as typeof fetch;
    const url = await dispatchJob(env, owner, 'backup', accepted);
    assert.equal(url, 'https://github.com/owner/repo/actions/workflows/backup.yml');
    assert.ok(seen[0]?.endsWith('/actions/workflows/backup.yml/dispatches'));
    const logged = await env.DB.prepare("SELECT after FROM admin_log WHERE entity='job' AND entity_id='backup.yml'").first<{ after: string }>();
    assert.ok(logged?.after.includes('dispatch accepted'));
    const refused = (async () => new Response('no', { status: 403 })) as typeof fetch;
    await assert.rejects(dispatchJob(env, owner, 'backup', refused), (error: unknown) => error instanceof AdminError && error.status === 502);
    await assert.rejects(dispatchJob(env, owner, 'bogus', accepted), (error: unknown) => error instanceof AdminError);
    await assert.rejects(dispatchJob({ ...env, GITHUB_ACTIONS_TOKEN: '' }, owner, 'backup', accepted), (error: unknown) => error instanceof AdminError && error.status === 503);
    const nightly = await dispatchJob(env, owner, 'nightly', accepted);
    assert.equal(nightly, 'https://github.com/owner/repo/actions/workflows/nightly.yml');
  } finally { await dispose(); await rm(state, { recursive: true, force: true }); }
});

test('cache purge validates the target, honours the provider success flag and logs the actor', async () => {
  const { state, env, dispose } = await fixture();
  try {
    const bodies: string[] = [];
    const okFetch = (async (_input: RequestInfo | URL, init?: RequestInit) => { bodies.push(String(init?.body || '')); return Response.json({ success: true }); }) as typeof fetch;
    assert.match(await purgeCache(env, owner, '', okFetch), /Full cache purge accepted/);
    assert.ok(bodies[0]?.includes('purge_everything'));
    assert.match(await purgeCache(env, owner, 'https://site.test/movie/test-film/', okFetch), /for that URL/);
    assert.ok(bodies[1]?.includes('https://site.test/movie/test-film/'));
    const failFetch = (async () => Response.json({ success: false })) as typeof fetch;
    await assert.rejects(purgeCache(env, owner, '', failFetch), (error: unknown) => error instanceof AdminError && error.status === 502);
    await assert.rejects(purgeCache(env, owner, 'not a url', okFetch), (error: unknown) => error instanceof AdminError);
    await assert.rejects(purgeCache({ ...env, CLOUDFLARE_API_TOKEN: '' }, owner, '', okFetch), (error: unknown) => error instanceof AdminError && error.status === 503);
    const rows = await env.DB.prepare("SELECT COUNT(*) AS count FROM admin_log WHERE entity='cache'").first<{ count: number }>();
    assert.equal(rows?.count, 3);
  } finally { await dispose(); await rm(state, { recursive: true, force: true }); }
});

test('cache TTL settings validate ranges and persist through the settings action', async () => {
  const { state, env, dispose } = await fixture();
  try {
    const save = (key: string, value: string, revision = '-1') => applyAdminAction(env, owner, 'settings', new URLSearchParams({ key, value, revision }), noNet);
    await save('cache_ttl_list', '7200');
    assert.equal((await env.DB.prepare("SELECT value FROM config WHERE key='cache_ttl_list'").first<{ value: string }>())?.value, '7200');
    await assert.rejects(save('cache_ttl_list', '30'), (error: unknown) => error instanceof AdminError);
    await assert.rejects(save('cache_ttl_list', 'abc'), (error: unknown) => error instanceof AdminError);
    await assert.rejects(save('cache_ttl_detail', '100'), (error: unknown) => error instanceof AdminError);
    await save('cache_ttl_detail', '172800');
    assert.equal((await env.DB.prepare("SELECT value FROM config WHERE key='cache_ttl_detail'").first<{ value: string }>())?.value, '172800');
  } finally { await dispose(); await rm(state, { recursive: true, force: true }); }
});

test('preview country cookie wins over the visitor country and is ignored when invalid', () => {
  const withPreview = new Request('https://site.test/watch/test-film/?country=US', { headers: { Cookie: 'country=CA; sp_preview_country=GB' } });
  assert.equal(requestCountry(withPreview), 'GB');
  assert.equal(previewCountryOf(withPreview), 'GB');
  const invalid = new Request('https://site.test/watch/test-film/?country=CA', { headers: { Cookie: 'sp_preview_country=XX' } });
  assert.equal(requestCountry(invalid), 'CA');
  assert.equal(previewCountryOf(new Request('https://site.test/')), null);
});

test('catalogue cache applies owner TTLs per page class and leaves uncacheable responses untouched', async () => {
  const store = new Map<string, Response>();
  const cache = {
    match: async (request: Request) => store.get(request.url)?.clone(),
    put: async (request: Request, response: Response) => { store.set(request.url, response.clone()); },
  } as unknown as Cache;
  const page = (control: string) => async () => new Response('<html>ok</html>', { headers: { 'Content-Type': 'text/html', 'Cache-Control': control } });
  const ttls = { list: 600, detail: 900 };
  const list = await cachedCatalogue(new Request('https://site.test/genre/action/'), cache, page('public, s-maxage=3600, stale-while-revalidate=604800'), ttls);
  assert.equal(list.headers.get('Cache-Control'), 'public, s-maxage=600, stale-while-revalidate=604800');
  let renders = 0;
  const counting = async () => { renders++; return new Response('<html>ok</html>', { headers: { 'Content-Type': 'text/html', 'Cache-Control': 'public, s-maxage=86400, stale-while-revalidate=604800' } }); };
  const detail = await cachedCatalogue(new Request('https://site.test/movie/test-film/'), cache, counting, ttls);
  assert.equal(detail.headers.get('Cache-Control'), 'public, s-maxage=900, stale-while-revalidate=604800');
  const hit = await cachedCatalogue(new Request('https://site.test/movie/test-film/'), cache, counting, ttls);
  assert.equal(hit.headers.get('Cache-Control'), 'public, s-maxage=900, stale-while-revalidate=604800');
  assert.equal(renders, 1);
  const plain = await cachedCatalogue(new Request('https://site.test/movies/'), cache, page('public, s-maxage=3600, stale-while-revalidate=604800'));
  assert.equal(plain.headers.get('Cache-Control'), 'public, s-maxage=3600, stale-while-revalidate=604800');
  const fresh = new Map<string, Response>();
  const freshCache = { match: async (request: Request) => fresh.get(request.url)?.clone(), put: async (request: Request, response: Response) => { fresh.set(request.url, response.clone()); } } as unknown as Cache;
  const uncacheable = await cachedCatalogue(new Request('https://site.test/new/'), freshCache, page('no-store'), ttls);
  assert.equal(uncacheable.headers.get('Cache-Control'), 'no-store');
  assert.equal(fresh.size, 0);
});
