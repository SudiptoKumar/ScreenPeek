import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import { localBindings, applyLocalSql } from '../sync/local.ts';
import { AdminError, verifyAccess, authenticateAdmin, permitted } from '../src/lib/admin/access.ts';
import { adminForm, applyAdminAction } from '../src/lib/admin/actions.ts';
import { deliverChange } from '../src/lib/admin/changes.ts';
import { exportAdminBackup } from '../src/lib/admin/data.ts';
import { homeTitles } from '../src/lib/catalogue.ts';
import { accessFixture } from './helpers/access.ts';
import type { AdminIdentity } from '../src/lib/admin/access.ts';

test('Access verifies RSA signature, issuer, audience, time and email; spoofed headers and algorithm changes fail closed', async () => {
  const fixture = accessFixture(), env = { CF_ACCESS_TEAM_DOMAIN: fixture.team, CF_ACCESS_AUD: fixture.aud };
  const fetcher = (async (input: RequestInfo | URL) => { assert.equal(String(input), fixture.certUrl); return Response.json({ keys: [fixture.jwk] }); }) as typeof fetch;
  const request = (token?: string, email = 'owner@example.test') => new Request('https://site.test/admin/', { headers: { 'Cf-Access-Authenticated-User-Email': email, ...(token ? { 'Cf-Access-Jwt-Assertion': token } : {}) } });
  assert.equal(await verifyAccess(request(), env, fetcher), null);
  assert.equal(await verifyAccess(request(fixture.token('owner@example.test')), env, fetcher), 'owner@example.test');
  for (const claims of [{ iss: 'https://other.cloudflareaccess.com' }, { aud: ['other'] }, { exp: 1 }, { nbf: Math.floor(Date.now() / 1000) + 600 }, { email: 'other@example.test' }]) assert.equal(await verifyAccess(request(fixture.token('owner@example.test', claims)), env, fetcher), null);
  assert.equal(await verifyAccess(request(fixture.token('owner@example.test', {}, { alg: 'none' })), env, fetcher), null);
  const forged = fixture.token('owner@example.test').split('.'); forged[1] = Buffer.from(JSON.stringify({ iss: `https://${fixture.team}`, aud: fixture.aud, exp: Math.floor(Date.now() / 1000) + 3600, email: 'other@example.test' })).toString('base64url');
  assert.equal(await verifyAccess(request(forged.join('.'), 'other@example.test'), env, fetcher), null);
  await assert.rejects(verifyAccess(request(), {}, fetcher), (error: unknown) => error instanceof AdminError && error.status === 503);
  assert.equal(permitted({ email: '', role: 'viewer', modules: {} }, 'links', true), false);
  assert.equal(permitted({ email: '', role: 'ads', modules: {} }, 'settings'), false);
  assert.equal(permitted({ email: '', role: 'editor', modules: { links: false } }, 'links'), false);
  assert.equal(permitted({ email: '', role: 'owner', modules: { links: false } }, 'links'), false);
});

test('native admin writes audit atomically, mirror exact ad code, reject stale edits and preserve role boundaries', async () => {
  const state = await mkdtemp(resolve(tmpdir(), 'screenpeek-admin-'));
  const local = await localBindings(state), fixture = accessFixture();
  const env = { DB: local.database as unknown as D1Database, CONFIG: local.config as unknown as KVNamespace, CF_ACCESS_TEAM_DOMAIN: fixture.team, CF_ACCESS_AUD: fixture.aud };
  const owner: AdminIdentity = { email: 'owner@example.test', role: 'owner', modules: {} };
  try {
    await applyLocalSql(local.database, await readFile('db/schema.sql', 'utf8'));
    for (const file of (await readdir('db/migrations')).filter(file => file.endsWith('.sql')).sort()) await applyLocalSql(local.database, await readFile(`db/migrations/${file}`, 'utf8'));
    await local.db.batch([{ sql: "INSERT INTO admin_users(email,role) VALUES('owner@example.test','owner')" }]);
    const fetcher = (async () => Response.json({ keys: [fixture.jwk] })) as typeof fetch;
    assert.equal((await authenticateAdmin(new Request('https://site.test/admin/', { headers: fixture.headers(owner.email) }), env, fetcher))?.role, 'owner');
    await assert.rejects(authenticateAdmin(new Request('https://site.test/admin/', { headers: fixture.headers('unknown@example.test') }), env, fetcher), (error: unknown) => error instanceof AdminError && error.status === 403);
    const form = new URLSearchParams({ slug: 'sample', name: 'Sample', type: 'affiliate', destination: 'https://example.test/offer', enabled: '1', country_GB: 'https://uk.example.test/', revision: '-1' });
    const result = await applyAdminAction(env, owner, 'links', form);
    assert.match(result.message, /pending/);
    assert.equal((await env.CONFIG.get<{ slug: string }>('link:sample', 'json'))?.slug, 'sample');
    assert.deepEqual(await local.db.query('SELECT actor,entity,entity_id FROM admin_log'), [{ actor: owner.email, entity: 'link', entity_id: 'sample' }]);
    await assert.rejects(applyAdminAction(env, owner, 'links', form), (error: unknown) => error instanceof AdminError && error.status === 409);
    assert.equal((await local.db.query<{ count: number }>('SELECT COUNT(*) AS count FROM admin_log'))[0].count, 1);
    await assert.rejects(applyAdminAction(env, { ...owner, role: 'viewer' }, 'links', form), (error: unknown) => error instanceof AdminError && error.status === 403);
    const code = '\n<div>Owner test</div><script>window.example="literal";</script>\n';
    await applyAdminAction(env, owner, 'ads', new URLSearchParams({ page_type: 'detail', placement: 'native', code, enabled: '1', revision: '-1' }));
    assert.equal((await env.CONFIG.get<{ code: string }>('ad:detail:native', 'json'))?.code, code);
    await applyAdminAction(env, { ...owner, email: 'ads@example.test', role: 'ads' }, 'ads', new URLSearchParams({ key: 'ads_enabled', value: '1', revision: '0' }));
    assert.equal(await env.CONFIG.get('config:ads_enabled'), '1');
    await assert.rejects(applyAdminAction(env, { ...owner, role: 'ads' }, 'settings', new URLSearchParams({ key: 'maintenance', value: '1', revision: '0' })), (error: unknown) => error instanceof AdminError && error.status === 403);
    const delivery = (await local.db.query<{ id: number }>('SELECT id FROM admin_delivery ORDER BY id LIMIT 1'))[0].id;
    let purges = 0;
    assert.deepEqual(await deliverChange({ ...env, CLOUDFLARE_ZONE_ID: 'a'.repeat(32), CLOUDFLARE_API_TOKEN: 'test-only-placeholder' }, delivery, (async (input, init) => {
      assert.equal(String(input), `https://api.cloudflare.com/client/v4/zones/${'a'.repeat(32)}/purge_cache`);
      assert.equal(init?.redirect, 'manual'); assert.deepEqual(JSON.parse(String(init?.body)), { purge_everything: true }); purges++;
      return Response.json({ success: true });
    }) as typeof fetch), { kv: true, purge: true });
    assert.equal(purges, 1);
    const backup = await exportAdminBackup(env, owner);
    assert.equal(backup.format, 'screenpeek-config'); assert.equal((backup.data.ad_slots[0] as { code: string }).code, code);
    await local.db.batch([
      { sql: "INSERT INTO titles(id,type,slug,title,original_language,genres) VALUES(7,'movie','pinned-title','Pinned title','en','[\"test-genre\"]')" },
      { sql: "INSERT INTO titles(id,type,slug,title,popularity) VALUES(8,'movie','popular-title','Popular title',999)" },
      { sql: "INSERT INTO genres(slug,name,title_count) VALUES('test-genre','Test genre',1)" },
      { sql: "INSERT INTO languages(slug,name,title_count) VALUES('en','English',1)" },
      { sql: "INSERT INTO title_genres(title_id,title_type,genre_slug) VALUES(7,'movie','test-genre')" },
    ]);
    await applyAdminAction(env, owner, 'content', new URLSearchParams({ id: '7', type: 'movie', pinned: '1', revision: '0' }));
    assert.equal((await homeTitles(env.DB, true)).trending[0].id, 7);
    await applyAdminAction(env, owner, 'content', new URLSearchParams({ id: '7', type: 'movie', hidden: '1', revision: '1' }));
    assert.equal((await homeTitles(env.DB, true)).trending[0].id, 8);
    assert.equal((await local.db.query<{ title_count: number }>("SELECT title_count FROM genres WHERE slug='test-genre'"))[0].title_count, 0);
    await assert.rejects(applyAdminAction(env, owner, 'content', new URLSearchParams({ id: '7', type: 'movie', revision: '1' })), (error: unknown) => error instanceof AdminError && error.status === 409);
    const dispatch = await applyAdminAction({ ...env, GITHUB_REPO: 'fixture/ScreenPeek', GITHUB_ACTIONS_TOKEN: 'test-only-placeholder' }, owner, 'sync', new URLSearchParams({ action: 'run-sync' }), (async (input, init) => {
      assert.equal(String(input), 'https://api.github.com/repos/fixture/ScreenPeek/actions/workflows/nightly.yml/dispatches');
      assert.deepEqual(JSON.parse(String(init?.body)), { ref: 'main', inputs: { ids: '', deploy: false } });
      return new Response(null, { status: 204 });
    }) as typeof fetch);
    assert.match(dispatch.jobUrl || '', /actions\/workflows\/nightly\.yml$/);
    await applyLocalSql(local.database, "CREATE TRIGGER fail_admin_audit BEFORE INSERT ON admin_log BEGIN SELECT RAISE(ABORT,'test audit failure'); END;");
    const broken = new URLSearchParams(form); broken.set('slug', 'must-rollback');
    await assert.rejects(applyAdminAction(env, owner, 'links', broken));
    assert.deepEqual(await local.db.query("SELECT slug FROM links WHERE slug='must-rollback'"), []);
  } finally { await local.dispose(); await rm(state, { recursive: true, force: true }); }
});

test('admin forms reject cross-site, oversized, duplicated and unsupported inputs', async () => {
  const request = (body: string, origin = 'https://site.test') => new Request('https://site.test/admin/links/', { method: 'POST', headers: { Origin: origin, 'Content-Type': 'application/x-www-form-urlencoded' }, body });
  await assert.rejects(adminForm(request('name=test', 'https://evil.test')), (error: unknown) => error instanceof AdminError && error.status === 403);
  await assert.rejects(adminForm(request('name=test', 'null')), (error: unknown) => error instanceof AdminError && error.status === 403);
  await assert.rejects(adminForm(request('name=one&name=two')));
  await assert.rejects(adminForm(request('name=' + 'x'.repeat(256_000))), (error: unknown) => error instanceof AdminError && error.status === 413);
  assert.equal((await adminForm(request('name=Movie+System'))).get('name'), 'Movie System');
});
