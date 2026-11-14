/** Build-time catalogue snapshot and HTML rendering. Never imported by the site. */
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { cp, mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { applyLocalSql, localBindings } from '../sync/local.ts';
import { HttpD1 } from '../sync/d1.ts';
import type { SqlClient } from '../sync/storage.ts';

const lightFields = 'id,type,slug,title,year,poster_r2,poster_color,vote_average,vote_count,views,updated_at,release_date,popularity,added_at,original_language,genres,quality_gate,pinned,pin_starts_at,pin_ends_at';
const visible = 'hidden=0 AND deleted=0 AND deleted_at IS NULL';
export const STATIC_FILE_LIMIT = 15_000;
export async function countFiles(root: string): Promise<number> {
  let count = 0;
  for (const item of await readdir(root, { withFileTypes: true })) count += item.isDirectory() ? await countFiles(resolve(root, item.name)) : 1;
  return count;
}
export function fileBudget(existing: number, planned = 0) {
  if (existing + planned > STATIC_FILE_LIMIT) throw new Error(`Static file budget exceeded: ${existing + planned} > ${STATIC_FILE_LIMIT}. Lower static_top_n or the number of hubs.`);
}
async function insertRows(db: SqlClient, table: string, rows: Record<string, unknown>[]) {
  if (!rows.length) return;
  const keys = Object.keys(rows[0]);
  if (keys.some(key => !/^[a-z_][a-z0-9_]*$/.test(key))) throw new Error('Invalid snapshot column');
  // One JSON binding avoids the D1 100-parameter limit. Small chunks bound bodies.
  for (let start = 0; start < rows.length; start += 50) await db.batch([{
    sql: `INSERT OR REPLACE INTO ${table} (${keys.join(',')}) SELECT ${keys.map(key => `json_extract(value,'$.${key}')`).join(',')} FROM json_each(?)`,
    params: [JSON.stringify(rows.slice(start, start + 50))],
  }]);
}
async function copyRows(source: SqlClient, target: SqlClient, table: string, fields = '*', where = '1', params: Array<string | number> = [], limit = 250_000) {
  let cursor = Number.MIN_SAFE_INTEGER, count = 0;
  while (true) {
    const rows = await source.query(`SELECT rowid AS __cursor,${fields} FROM ${table} WHERE (${where}) AND rowid>? ORDER BY rowid LIMIT 500`, [...params, cursor]);
    if (!rows.length) return count;
    cursor = Number(rows.at(-1)!.__cursor); count += rows.length;
    if (count > limit) throw new Error(`Snapshot ${table} exceeds its ${limit}-row safety bound; review the build budget.`);
    await insertRows(target, table, rows.map(({ __cursor: _, ...row }) => row));
  }
}
export async function snapshotCatalogue(source: SqlClient, target: Awaited<ReturnType<typeof localBindings>>, production = false) {
  await applyLocalSql(target.database, await readFile('db/schema.sql', 'utf8'));
  for (const file of (await readdir('db/migrations')).filter(name => name.endsWith('.sql')).sort()) await applyLocalSql(target.database, await readFile(`db/migrations/${file}`, 'utf8'));
  const sample = Boolean((await source.query("SELECT key FROM config WHERE key IN ('dev:sample_data','dev:fixture_import') AND value NOT IN ('','0')")).length);
  if (production && sample) throw new Error('Production static builds refuse sample/fixture data.');
  const setting = (await source.query("SELECT value FROM config WHERE key='static_top_n'"))[0]?.value ?? '3000';
  const topN = Number(setting);
  if (!/^\d+$/.test(String(setting)) || !Number.isSafeInteger(topN) || topN < 0 || topN > STATIC_FILE_LIMIT) throw new Error('static_top_n must be 0–15000.');
  const cards = await copyRows(source, target.db, 'titles', lightFields, `${visible}${sample ? '' : ' AND quality_gate=1'}`);
  const top = await source.query(`SELECT id,type,slug FROM titles WHERE ${visible} AND quality_gate=1 ORDER BY popularity DESC,id DESC,type LIMIT ?`, [topN]);
  for (let offset = 0; offset < top.length; offset += 50) {
    const selected = top.slice(offset, offset + 50);
    const pairs = JSON.stringify(selected.map(row => [row.id, row.type]));
    const parents = "(title_id,title_type) IN (SELECT json_extract(value,'$[0]'),json_extract(value,'$[1]') FROM json_each(?))";
    await insertRows(target.db, 'titles', await source.query("SELECT * FROM titles WHERE (id,type) IN (SELECT json_extract(value,'$[0]'),json_extract(value,'$[1]') FROM json_each(?))", [pairs]));
    for (const table of ['credits', 'providers', 'ratings_ext', 'releases']) await copyRows(source, target.db, table, '*', parents, [pairs], 100_000);
    await copyRows(source, target.db, 'seasons', '*', "title_id IN (SELECT json_extract(value,'$[0]') FROM json_each(?) WHERE json_extract(value,'$[1]')='tv')", [pairs], 100_000);
    await copyRows(source, target.db, 'people', '*', `id IN (SELECT person_id FROM credits WHERE ${parents})`, [pairs], 100_000);
  }
  for (const table of ['genres', 'collections', 'languages', 'taxonomy_overrides', 'seo_overrides', 'config', 'links', 'ad_slots', 'pages', 'redirects', 'homepage_sections']) await copyRows(source, target.db, table, '*', '1', [], 15_000);
  await copyRows(source, target.db, 'collection_titles', '*', `EXISTS(SELECT 1 FROM titles t WHERE t.id=collection_titles.title_id AND t.type=collection_titles.title_type AND ${visible}${sample ? '' : ' AND quality_gate=1'})`, [], 1_000_000);
  await target.db.batch([{ sql: "INSERT OR IGNORE INTO title_genres(title_id,title_type,genre_slug) SELECT t.id,t.type,j.value FROM titles t,json_each(t.genres) j WHERE j.type='text'" }]);
  const paths = ['/', '/movies/', '/series/', '/new/', '/top10/', '/upcoming/', '/about/', '/privacy/', '/dmca/', '/contact/'];
  for (const [kind, table] of [['genre', 'genres'], ['collection', 'collections'], ['language', 'languages']]) {
    const rows = await target.db.query(`SELECT slug FROM ${table} WHERE title_count>0 ${kind === 'collection' ? "AND deleted_at IS NULL AND (starts_at IS NULL OR datetime(starts_at)<=datetime('now')) AND (ends_at IS NULL OR datetime(ends_at)>datetime('now'))" : ''} AND NOT EXISTS(SELECT 1 FROM taxonomy_overrides o WHERE o.kind=? AND o.slug=${table}.slug AND o.hidden=1 AND o.deleted_at IS NULL)`, [kind]);
    for (const row of rows) {
      const slug = String(row.slug);
      if (!/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(slug)) throw new Error('Invalid taxonomy slug in static inventory');
      paths.push(`/${kind}/${slug}/`);
    }
  }
  for (const row of top) {
    const slug = String(row.slug);
    if (!/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(slug)) throw new Error('Invalid title slug in static inventory');
    paths.push(`/${row.type === 'tv' ? 'tv' : 'movie'}/${slug}/`);
  }
  const redirected = new Set((await target.db.query('SELECT from_path FROM redirects WHERE type=301 AND deleted_at IS NULL')).map(row => String(row.from_path)));
  const maintenance = (await source.query("SELECT value FROM config WHERE key='maintenance'"))[0]?.value === '1';
  return { paths: maintenance ? [] : [...new Set(paths)].filter(path => !redirected.has(path)), sample, topN, selected: top.length, cards };
}
export async function renderStatic(options: { state: string; paths: string[]; client?: string; config?: string; vars?: Record<string, string>; port?: number }) {
  const client = resolve(options.client || 'dist/client');
  const initialFiles = await countFiles(client);
  fileBudget(initialFiles, options.paths.length);
  if (!options.paths.length) return initialFiles;
  const work = await mkdtemp(resolve(tmpdir(), 'screenpeek-render-'));
  let child: ReturnType<typeof spawn> | undefined;
  try {
    const originalPath = resolve(options.config || 'dist/server/wrangler.json');
    const original = JSON.parse(await readFile(originalPath, 'utf8'));
    const configPath = resolve(work, 'wrangler.json');
    await writeFile(configPath, JSON.stringify({ ...original, main: resolve(dirname(originalPath), original.main), assets: { ...original.assets, directory: client, run_worker_first: true }, vars: { ...original.vars, ...options.vars } }));
    const port = options.port || 8795, base = `http://127.0.0.1:${port}`;
    child = spawn(process.execPath, [resolve('node_modules/wrangler/bin/wrangler.js'), 'dev', '--config', configPath, '--local', '--ip', '127.0.0.1', '--port', String(port), '--persist-to', resolve(options.state)], {
      env: { ...process.env, XDG_CONFIG_HOME: resolve('.cache/config'), WRANGLER_SEND_METRICS: 'false' }, stdio: ['ignore', 'pipe', 'pipe'],
    });
    let output = '';
    child.stdout?.on('data', chunk => { output = (output + chunk).slice(-3000); });
    child.stderr?.on('data', chunk => { output = (output + chunk).slice(-3000); });
    const deadline = Date.now() + 30_000;
    while (true) {
      if (child.exitCode !== null) throw new Error(`Static render Worker exited: ${output}`);
      try { const response = await fetch(`${base}/robots.txt`, { signal: AbortSignal.timeout(1000) }); await response.body?.cancel(); if (response.ok) break; } catch { /* Startup pending. */ }
      if (Date.now() > deadline) throw new Error(`Static render Worker startup timed out: ${output}`);
      await new Promise(resolve => setTimeout(resolve, 100));
    }
    let index = 0;
    await Promise.all(Array.from({ length: Math.min(4, options.paths.length) }, async () => {
      while (index < options.paths.length) {
        const path = options.paths[index++];
        if (!/^\/(?:[a-z0-9-]+\/)*$/.test(path) || /^\/(?:admin|api|go|watch|search|mylist)\//.test(path)) throw new Error('Unsafe static inventory path');
        const response = await fetch(base + path, { redirect: 'error', signal: AbortSignal.timeout(30_000) });
        if (response.status !== 200 || !response.headers.get('content-type')?.includes('text/html') || response.headers.has('set-cookie')) throw new Error(`Refusing to freeze ${path}: HTTP ${response.status}, non-HTML or visitor cookie.`);
        const filename = resolve(work, 'html', `.${path}`, 'index.html');
        await mkdir(dirname(filename), { recursive: true });
        await writeFile(filename, await response.text());
      }
    }));
    const stopped = once(child, 'exit'); child.kill('SIGTERM'); await stopped; child = undefined;
    if (options.paths.length) await cp(resolve(work, 'html'), client, { recursive: true });
    const files = await countFiles(client); fileBudget(files);
    return files;
  } finally {
    if (child && child.exitCode === null) { const stopped = once(child, 'exit'); child.kill('SIGTERM'); await stopped; }
    await rm(work, { recursive: true, force: true });
  }
}
export async function buildStatic(env = process.env) {
  const state = await mkdtemp(resolve(tmpdir(), 'screenpeek-snapshot-'));
  let source: Awaited<ReturnType<typeof localBindings>> | undefined;
  const target = await localBindings(state);
  try {
    const remote = env.STATIC_SOURCE_REMOTE === '1';
    const production = env.DEPLOYMENT_ENV === 'production';
    if (production && !remote) throw new Error('Production builds require the read-only remote catalogue snapshot.');
    let db: SqlClient;
    if (remote) db = new HttpD1({ accountId: env.CLOUDFLARE_ACCOUNT_ID || '', databaseId: env.D1_DATABASE_ID || '', token: env.CLOUDFLARE_API_TOKEN || '' });
    else { source = await localBindings(); db = source.db; }
    const inventory = await snapshotCatalogue(db, target, production);
    await source?.dispose(); source = undefined;
    await target.dispose();
    const vars = Object.fromEntries(['SITE_URL', 'SITE_NAME', 'R2_PUBLIC_BASE', 'ADS_ENABLED', 'DEPLOYMENT_ENV'].filter(key => env[key] !== undefined).map(key => [key, env[key]!]));
    const files = await renderStatic({ state, paths: inventory.paths, vars });
    const manifest = { ...inventory, files, vars, site: new URL(env.SITE_URL || 'https://example.workers.dev').origin, mode: production ? 'production' : 'preview', builtAt: new Date().toISOString() };
    await writeFile('dist/static-manifest.json', JSON.stringify(manifest, null, 2) + '\n');
    console.log(`Static tier: ${inventory.paths.length} HTML pages (${inventory.selected}/${inventory.topN} gated titles), ${files}/${STATIC_FILE_LIMIT} total assets. ${inventory.sample ? 'SAMPLE / NOINDEX.' : ''}`);
    return manifest;
  } finally { await source?.dispose(); await target.dispose(); await rm(state, { recursive: true, force: true }); }
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) await buildStatic();
