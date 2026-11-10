import { readFile, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const required = (env, key) => { const value = env[key]?.trim(); if (!value) throw new Error(`Set ${key} in secure environment settings.`); return value; };
const nonPlaceholder = value => !/^0+1?$/.test(value.replaceAll('-', ''));
function hexId(env, key) {
  const value = required(env, key);
  if (!/^[a-f0-9]{32}$/i.test(value) || !nonPlaceholder(value)) throw new Error(`${key} must be a real 32-character resource ID.`);
  return value;
}
function publicUrl(env, key, image = false) {
  const value = required(env, key);
  let url;
  try { url = new URL(value); } catch { throw new Error(`${key} must be an HTTPS URL.`); }
  const host = url.hostname.toLowerCase();
  if (url.protocol !== 'https:' || url.username || url.password || url.search || url.hash || url.port || (!image && url.pathname !== '/') ||
    /(?:^|\.)(?:localhost|test|invalid|example)$/.test(host) || /(?:^|\.)(?:example\.(?:com|org|net)|example\.workers\.dev)$/.test(host) || host.endsWith('.') ||
    /^\d+(?:\.\d+){3}$/.test(host) || host.includes(':')) throw new Error(`${key} must use the real public HTTPS hostname.`);
  if (image && (/(?:^|\.)(?:r2\.dev|r2\.cloudflarestorage\.com|workers\.dev|pages\.dev)$/.test(host) || ['image.tmdb.org', 'api.themoviedb.org', 'files.tmdb.org'].includes(host))) throw new Error('R2_PUBLIC_BASE requires an owned R2 custom domain; service/test hostnames are not production image domains.');
  return image ? url.href.replace(/\/$/, '') : url.origin;
}
/** Produces public binding metadata only. Secret values never enter the file. */
export function productionConfig(input, env) {
  const account = hexId(env, 'CLOUDFLARE_ACCOUNT_ID');
  const id = required(env, 'D1_DATABASE_ID');
  if (!/^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/i.test(id) || !nonPlaceholder(id)) throw new Error('D1_DATABASE_ID must be a real database UUID.');
  const kv = hexId(env, 'KV_NAMESPACE_ID');
  const site = publicUrl(env, 'SITE_URL'), images = publicUrl(env, 'R2_PUBLIC_BASE', true);
  const bucket = env.R2_BUCKET || 'posters';
  if (!/^[a-z0-9][a-z0-9-]{1,61}[a-z0-9]$/.test(bucket)) throw new Error('R2_BUCKET must be a valid bucket name.');
  if (!['0', '1'].includes(env.ADS_ENABLED || '0')) throw new Error('ADS_ENABLED must be 0 or 1.');
  if (Object.keys(input.vars || {}).some(key => /TOKEN|SECRET|PASSWORD|PRIVATE_KEY|ACCESS_KEY/i.test(key))) throw new Error('Use encrypted Worker secrets for credentials, not Wrangler vars.');
  const config = structuredClone(input);
  config.account_id = account;
  config.keep_vars = true;
  const db = config.d1_databases?.find(binding => binding.binding === 'DB');
  const namespace = config.kv_namespaces?.find(binding => binding.binding === 'CONFIG');
  const backups = config.r2_buckets?.find(binding => binding.binding === 'BACKUPS');
  if (backups) {
    const backupBucket = required(env, 'R2_BACKUP_BUCKET');
    if (!/^[a-z0-9][a-z0-9-]{1,61}[a-z0-9]$/.test(backupBucket) || backupBucket === bucket || env.BACKUP_BUCKET_PRIVATE !== '1') throw new Error('Configure and confirm a separate private R2 backup bucket before deployment.');
    backups.bucket_name = backupBucket;
  }
  const posters = config.r2_buckets?.find(binding => binding.binding === 'POSTERS');
  if (!db || !namespace || !posters || config.assets?.binding !== 'ASSETS') throw new Error('Build the Astro Worker with DB, CONFIG, POSTERS and ASSETS bindings first.');
  db.database_id = id; namespace.id = kv; delete namespace.preview_id; posters.bucket_name = bucket;
  config.assets.run_worker_first = false;
  config.vars = { ...config.vars, SITE_URL: site, R2_PUBLIC_BASE: images, DEPLOYMENT_ENV: 'production', ADS_ENABLED: env.ADS_ENABLED || '0',
    SITE_NAME: env.SITE_NAME || config.vars?.SITE_NAME || 'ScreenPeek', GITHUB_REPO: env.GITHUB_REPO || 'parkerlovealex/ScreenPeek' };
  if (!/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(config.vars.GITHUB_REPO)) throw new Error('GITHUB_REPO must be owner/repository.');
  return config;
}
export function phase1Complete(markdown) {
  const phase = markdown.split('## Phase 1')[1]?.split('## Phase 2')[0] || '';
  const tasks = [...phase.matchAll(/^- \[([ x])\] (1\.\d+)\b/gm)];
  return tasks.length === 38 && tasks.every(task => task[1] === 'x');
}
export async function prepareProduction(root = '.', env = process.env) {
  const path = resolve(root, 'dist/server/wrangler.json');
  const source = JSON.parse(await readFile(path, 'utf8'));
  const prepared = productionConfig(source, env);
  const manifest = JSON.parse(await readFile(resolve(root, 'dist/static-manifest.json'), 'utf8'));
  if (manifest.mode !== 'production' || manifest.sample || manifest.site !== prepared.vars.SITE_URL || manifest.files > 15000 || manifest.vars?.R2_PUBLIC_BASE !== prepared.vars.R2_PUBLIC_BASE || (manifest.vars?.ADS_ENABLED || '0') !== prepared.vars.ADS_ENABLED) throw new Error('Rebuild the production static tier from the real catalogue and matching SITE_URL before deployment.');
  await writeFile(path, JSON.stringify(prepared, null, 2) + '\n');
  return path;
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try { await prepareProduction(); process.stdout.write('Prepared production DB/CONFIG/POSTERS bindings and public site settings. No resources were created or deployed.\n'); }
  catch (error) { process.stderr.write(`${error instanceof Error ? error.message : 'Production preparation failed.'}\n`); process.exitCode = 1; }
}
