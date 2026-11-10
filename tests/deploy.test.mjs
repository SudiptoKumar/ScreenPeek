import { purgeAfterDeploy, purgeSettings } from '../scripts/purge.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { productionConfig, phase1Complete, prepareProduction } from '../scripts/deploy-config.mjs';

const input = { vars: { SITE_NAME: 'ScreenPeek', ADS_ENABLED: '0', DEPLOYMENT_ENV: 'preview' }, assets: { binding: 'ASSETS', run_worker_first: true },
  d1_databases: [{ binding: 'DB', database_id: '00000000-0000-0000-0000-000000000001' }], kv_namespaces: [{ binding: 'CONFIG', id: '00000000000000000000000000000001' }], r2_buckets: [{ binding: 'POSTERS', bucket_name: 'posters' }] };
const env = { CLOUDFLARE_ACCOUNT_ID: 'a'.repeat(32), D1_DATABASE_ID: '11111111-1111-4111-8111-111111111111', KV_NAMESPACE_ID: 'b'.repeat(32), SITE_URL: 'https://screenpeek-demo.com', R2_PUBLIC_BASE: 'https://images.screenpeek-demo.com', CLOUDFLARE_API_TOKEN: 'test-only-secret', GITHUB_ACTIONS_TOKEN: 'another-test-secret' };
test('production config maps bindings and explicit indexing while excluding credentials and defaulting ads off', () => {
  const result = productionConfig(input, env);
  assert.equal(result.d1_databases[0].database_id, env.D1_DATABASE_ID);
  assert.equal(result.kv_namespaces[0].id, env.KV_NAMESPACE_ID);
  assert.equal(result.vars.DEPLOYMENT_ENV, 'production'); assert.equal(result.vars.ADS_ENABLED, '0');
  assert.equal(result.assets.run_worker_first, false);
  assert.equal(result.account_id, env.CLOUDFLARE_ACCOUNT_ID); assert.equal(result.keep_vars, true);
  assert.doesNotMatch(JSON.stringify(result), /test-only-secret|another-test-secret|CLOUDFLARE_API_TOKEN/);
  assert.equal(input.vars.DEPLOYMENT_ENV, 'preview');
});
test('missing settings preserve the original build and an incomplete checklist prevents the deployment process', async () => {
  const root = await mkdtemp(join(tmpdir(), 'screenpeek-deploy-'));
  try {
    await mkdir(join(root, 'dist/server'), { recursive: true });
    const original = JSON.stringify(input);
    await writeFile(join(root, 'dist/server/wrangler.json'), original);
    await assert.rejects(prepareProduction(root, {}), /CLOUDFLARE_ACCOUNT_ID/);
    assert.equal(await readFile(join(root, 'dist/server/wrangler.json'), 'utf8'), original);
    await writeFile(join(root, 'TASKS.md'), '## Phase 1\n- [ ] 1.1 Unverified\n## Phase 2\n');
    await assert.rejects(promisify(execFile)(process.execPath, [resolve('scripts/deploy.mjs')], { cwd: root, env: { ...process.env, SCREENPEEK_DEPLOY_ENABLED: '1' } }), error => error.code === 1 && /unverified tasks/.test(error.stderr));
  } finally { await rm(root, { recursive: true, force: true }); }
});
test('production preparation refuses placeholders, non-public URLs, service image domains and plaintext secrets', () => {
  for (const patch of [{ CLOUDFLARE_ACCOUNT_ID: '' }, { D1_DATABASE_ID: input.d1_databases[0].database_id }, { KV_NAMESPACE_ID: input.kv_namespaces[0].id }, { SITE_URL: 'https://example.workers.dev' }, { SITE_URL: 'https://site.test' }, { R2_PUBLIC_BASE: 'https://pub-test.r2.dev' }, { ADS_ENABLED: 'yes' }]) assert.throws(() => productionConfig(input, { ...env, ...patch }));
  assert.throws(() => productionConfig({ ...input, vars: { ...input.vars, API_TOKEN: 'private' } }, env));
  const checklist = '# TASKS\n## Phase 1\n' + Array.from({ length: 38 }, (_, index) => `- [x] 1.${index + 1} Task`).join('\n') + '\n## Phase 2\n- [ ] 2.1 Later';
  assert.equal(phase1Complete(checklist), true); assert.equal(phase1Complete(checklist.replace('[x]', '[ ]')), false);
});

test('production preparation rejects a preview or mismatched static snapshot before changing bindings', async () => {
  const root = await mkdtemp(join(tmpdir(), 'screenpeek-static-deploy-'));
  try {
    await mkdir(join(root, 'dist/server'), { recursive: true });
    const original = JSON.stringify(input);
    await writeFile(join(root, 'dist/server/wrangler.json'), original);
    const manifest = { mode: 'production', sample: false, site: env.SITE_URL, files: 30, vars: { R2_PUBLIC_BASE: env.R2_PUBLIC_BASE, ADS_ENABLED: '0' } };
    for (const patch of [{ mode: 'preview' }, { sample: true }, { site: 'https://different.test' }, { files: 15001 }, { vars: { R2_PUBLIC_BASE: 'https://different.test' } }]) {
      await writeFile(join(root, 'dist/static-manifest.json'), JSON.stringify({ ...manifest, ...patch }));
      await assert.rejects(prepareProduction(root, env), /Rebuild the production static tier/);
      assert.equal(await readFile(join(root, 'dist/server/wrangler.json'), 'utf8'), original);
    }
    await writeFile(join(root, 'dist/static-manifest.json'), JSON.stringify(manifest));
    await prepareProduction(root, env);
    assert.equal(JSON.parse(await readFile(join(root, 'dist/server/wrangler.json'), 'utf8')).assets.run_worker_first, false);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('post-deploy purge uses only the configured zone and refuses unconfirmed or failed purges', async () => {
  assert.throws(() => purgeSettings({}), /zone ID/);
  const settings = { CLOUDFLARE_ZONE_ID: 'c'.repeat(32), CLOUDFLARE_API_TOKEN: 'fixture-token' };
  await purgeAfterDeploy(settings, async (url, init) => {
    assert.equal(url, `https://api.cloudflare.com/client/v4/zones/${settings.CLOUDFLARE_ZONE_ID}/purge_cache`);
    assert.equal(init.method, 'POST'); assert.deepEqual(JSON.parse(init.body), { purge_everything: true });
    return Response.json({ success: true });
  });
  await assert.rejects(purgeAfterDeploy(settings, async () => Response.json({ success: false })), /did not confirm/);
  await assert.rejects(purgeAfterDeploy(settings, async () => new Response(null, { status: 503 })), /Deployment succeeded.*purge failed/);
});
