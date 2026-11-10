import test from 'node:test';
import assert from 'node:assert/strict';
import { cp, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import { localBindings } from '../sync/local.ts';
import { fileBudget, renderStatic, snapshotCatalogue } from '../scripts/static-build.ts';
import { testWorker } from './helpers/worker.ts';
import { listingBase, paginationLink } from '../src/lib/listing-path.ts';
import { cachedCatalogue } from '../src/lib/catalogue-cache.ts';
import { cachedWatch } from '../src/lib/watch-cache.ts';

test('static budget rejects excess files; path pagination preserves dynamic filters', () => {
  fileBudget(14999, 1); assert.throws(() => fileBudget(14999, 2), /15001 > 15000/);
  assert.equal(paginationLink(new URL('https://site.test/movies/'), 2), '/movies/page/2/');
  assert.equal(paginationLink(new URL('https://site.test/movies/page/2/'), 1), '/movies/');
  assert.equal(paginationLink(new URL('https://site.test/movies/filter/?genre=drama'), 2), '/movies/filter/?genre=drama&page=2');
  assert.equal(listingBase('/admin/page/2/'), null);
});
test('country cache isolates cookies, excludes errors, and keeps public responses private', async () => {
  const entries = new Map<string, Response>(); let calls = 0;
  const cache = { async match(key: Request) { return entries.get(key.url)?.clone(); }, async put(key: Request, response: Response) { assert.equal(response.headers.has('set-cookie'), false); entries.set(key.url, response); } } as unknown as Cache;
  const render = async (country: string, status = 200) => { calls++; return new Response(country, { status, headers: { 'Content-Type': 'text/html', 'Set-Cookie': `country=${country}` } }); };
  for (const country of ['US', 'GB', 'US']) {
    const response = await cachedWatch(new Request(`https://site.test/watch/title/?country=${country}`), cache, () => render(country));
    assert.equal(await response.text(), country);
  }
  assert.equal(calls, 2); assert.equal(entries.size, 2);
  const hit = await cachedWatch(new Request('https://site.test/watch/title/', { headers: { Cookie: 'country=GB' } }), cache, () => render('wrong'));
  assert.match(hit.headers.get('cache-control')!, /private/); assert.match(hit.headers.get('set-cookie')!, /country=GB/);
  await cachedWatch(new Request('https://site.test/watch/missing/'), cache, () => render('missing', 404));
  assert.equal(entries.size, 2);
});
test('native D1 snapshot and assets-first Worker serve only chosen gated titles statically; long tail and filters render', async () => {
  const root = await mkdtemp(resolve(tmpdir(), 'screenpeek-static-test-'));
  const client = resolve(root, 'client'), snapshot = await localBindings(resolve(root, 'snapshot'));
  await cp('dist/client', client, { recursive: true, filter: path => !path.endsWith('.html') });
  let titles: string[] = [];
  const worker = await testWorker({ ADS_ENABLED: '0', DEPLOYMENT_ENV: 'production', SITE_URL: 'https://screenpeek.example.test' }, 8794, {}, { assetsFirst: true, client, beforeStart: async local => {
    await local.db.batch([
      { sql: "DELETE FROM config WHERE key LIKE 'dev:%'" },
      { sql: "UPDATE config SET value='2' WHERE key='static_top_n'" },
      { sql: "UPDATE titles SET quality_gate=1,popularity=100000-id,overview='Full source overview' WHERE type='movie'" },
      { sql: "INSERT INTO admin_users(email,role) VALUES('private-owner@example.test','owner')" },
    ]);
    const inventory = await snapshotCatalogue(local.db, snapshot);
    assert.equal(inventory.selected, 2); assert.equal(inventory.cards, 30);
    assert.equal((await snapshot.db.query('SELECT COUNT(*) n FROM admin_users'))[0].n, 0);
    assert.equal((await snapshot.db.query("SELECT COUNT(*) n FROM titles WHERE overview='Full source overview'"))[0].n, 2);
    assert.ok(inventory.paths.includes('/movies/')); assert.equal(inventory.paths.some(path => path.startsWith('/watch/')), false);
    titles = inventory.paths.filter(path => path.startsWith('/movie/'));
    await snapshot.dispose();
    const files = await renderStatic({ state: resolve(root, 'snapshot'), client, paths: inventory.paths, vars: { ADS_ENABLED: '0', DEPLOYMENT_ENV: 'preview' } });
    assert.ok(files < 15000);
  } });
  try {
    const staticResponse = await fetch(worker.base + titles[0]);
    assert.equal(staticResponse.status, 200); assert.equal(staticResponse.headers.get('X-Test-Worker'), null);
    assert.match(await staticResponse.text(), /Full source overview/);
    const slug = titles[0].split('/')[2];
    await worker.local.db.batch([{ sql: "UPDATE titles SET overview='Changed after build' WHERE slug=?", params: [slug] }]);
    assert.doesNotMatch(await (await fetch(worker.base + titles[0])).text(), /Changed after build/);
    const tail = (await worker.local.db.query('SELECT slug FROM titles WHERE type=? AND slug NOT IN (?,?) LIMIT 1', ['movie', ...titles.map(path => path.split('/')[2])]))[0];
    const dynamic = await fetch(`${worker.base}/movie/${tail.slug}/`);
    assert.equal(dynamic.status, 200); assert.equal(dynamic.headers.get('X-Test-Worker'), 'invoked');
    assert.match(dynamic.headers.get('Cache-Control')!, /s-maxage=86400/);
    await dynamic.body?.cancel();
    await worker.local.db.batch([{ sql: "UPDATE titles SET overview='New live tail overview' WHERE slug=?", params: [String(tail.slug)] }]);
    assert.doesNotMatch(await (await fetch(`${worker.base}/movie/${tail.slug}/`)).text(), /New live tail overview/);
    const top = (await worker.local.db.query('SELECT id,type FROM titles WHERE slug=?', [slug]))[0];
    await worker.local.db.batch([{ sql: "INSERT INTO providers(title_id,title_type,country,provider_id,provider_name,offer_type) VALUES(?,?,'US',12345,'US provider before edit','stream'),(?,?,'GB',12345,'GB provider before edit','stream')", params: [Number(top.id), String(top.type), Number(top.id), String(top.type)] }]);
    const us = await fetch(`${worker.base}/watch/${slug}/?country=US`);
    assert.match(await us.text(), /US provider before edit/); assert.match(us.headers.get('Set-Cookie')!, /country=US/);
    await worker.local.db.batch([{ sql: "UPDATE providers SET provider_name='GB provider after edit' WHERE title_id=? AND title_type=? AND country='GB' AND provider_id=12345", params: [Number(top.id), String(top.type)] }]);
    const gb = await fetch(`${worker.base}/watch/${slug}/?country=GB`);
    assert.match(await gb.text(), /GB provider after edit/); assert.match(gb.headers.get('Set-Cookie')!, /country=GB/);
    await worker.local.db.batch([{ sql: "UPDATE providers SET provider_name='US provider after edit' WHERE title_id=? AND title_type=? AND country='US' AND provider_id=12345", params: [Number(top.id), String(top.type)] }]);
    const usHit = await fetch(`${worker.base}/watch/${slug}/`, { headers: { Cookie: 'country=US' } });
    assert.match(await usHit.text(), /US provider before edit/); assert.match(usHit.headers.get('Cache-Control')!, /private, no-store/);
    const page2 = await fetch(`${worker.base}/movies/page/2/`);
    assert.equal(page2.status, 200); assert.match(await page2.text(), /Page 2 of 2/);
    const filtered = await fetch(`${worker.base}/movies/filter/?genre=drama`);
    assert.equal(filtered.status, 200); assert.equal(filtered.headers.get('X-Test-Worker'), 'invoked'); assert.match(await filtered.text(), /noindex/);
    const jump = await fetch(`${worker.base}/movies/filter/?page=2`, { redirect: 'manual' });
    assert.equal(jump.status, 301); assert.equal(jump.headers.get('location'), '/movies/page/2/');
    await worker.local.db.batch([{ sql: "INSERT INTO config(key,value) VALUES('dev:fixture_import','1')" }]);
    const refused = await localBindings(resolve(root, 'refused'));
    try { await assert.rejects(snapshotCatalogue(worker.local.db, refused, true), /refuse sample/); } finally { await refused.dispose(); }
  } finally { await snapshot.dispose(); await worker.dispose(); await rm(root, { recursive: true, force: true }); }
});

test('long-tail Cache API stores public HTML and bypasses private, filtered and non-GET requests', async () => {
  const entries = new Map<string, Response>(); let calls = 0;
  const cache = { async match(key: Request) { return entries.get(key.url)?.clone(); }, async put(key: Request, response: Response) { entries.set(key.url, response); } } as unknown as Cache;
  const render = async (control = 'public, s-maxage=86400') => { calls++; return new Response('catalogue', { headers: { 'Content-Type': 'text/html', 'Cache-Control': control } }); };
  const request = new Request('https://site.test/movie/title/');
  await cachedCatalogue(request, cache, render);
  const hit = await cachedCatalogue(request, cache, render);
  assert.match(hit.headers.get('Cache-Control')!, /^public, s-maxage=86400/);
  assert.equal(calls, 1); assert.equal(entries.size, 1);
  await cachedCatalogue(new Request('https://site.test/movie/private/'), cache, () => render('private, no-store'));
  await cachedCatalogue(new Request('https://site.test/movies/filter/?genre=drama'), cache, render);
  await cachedCatalogue(new Request('https://site.test/movie/title/', { method: 'POST' }), cache, render);
  assert.equal(calls, 4); assert.equal(entries.size, 1);
});

test('maintenance inventory can deploy an empty static tier without starting a render Worker', async () => {
  const client = await mkdtemp(resolve(tmpdir(), 'screenpeek-empty-static-'));
  try {
    await writeFile(resolve(client, 'asset.txt'), 'asset');
    assert.equal(await renderStatic({ client, paths: [], state: 'unused', config: '/no-config-needed.json' }), 1);
  } finally { await rm(client, { recursive: true, force: true }); }
});
