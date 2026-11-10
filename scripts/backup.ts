import { spawn } from 'node:child_process';
import { mkdtemp, readFile, rm, stat, writeFile, mkdir, readdir, unlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import { HttpD1 } from '../sync/d1.ts';
import { localBindings } from '../sync/local.ts';
import { encodeBackup, backupKey, saveBackup, PrivateBackupStore } from '../sync/backup.ts';
const local = process.argv.includes('--local'), work = await mkdtemp(resolve(tmpdir(), 'screenpeek-backup-'));
try {
  if (!local && process.env.SCREENPEEK_BACKUP_ENABLED !== '1') throw new Error('Remote backups are disabled; configure and explicitly enable the private backup job first.');
  const filename = resolve(work, 'catalogue.sql'); let config = resolve('wrangler.toml');
  let storage: PrivateBackupStore | undefined;
  if (!local) {
    storage = new PrivateBackupStore({ account: process.env.CLOUDFLARE_ACCOUNT_ID || '', bucket: process.env.R2_BACKUP_BUCKET || '', posterBucket: process.env.R2_BUCKET || 'posters', privateConfirmed: process.env.BACKUP_BUCKET_PRIVATE === '1', accessKey: process.env.R2_BACKUP_ACCESS_KEY_ID || '', secretKey: process.env.R2_BACKUP_SECRET_ACCESS_KEY || '' });
    if (!/^[a-f0-9-]{36}$/i.test(process.env.D1_DATABASE_ID || '') || !process.env.CLOUDFLARE_API_TOKEN) throw new Error('Configure the D1 export ID and scoped API token.');
    config = resolve(work, 'wrangler.json');
    await writeFile(config, JSON.stringify({ name: 'screenpeek-backup', account_id: process.env.CLOUDFLARE_ACCOUNT_ID, d1_databases: [{ binding: 'DB', database_name: 'movie-db', database_id: process.env.D1_DATABASE_ID }] }));
  }
  const bindings = local ? await localBindings() : undefined;
  const db = bindings?.db || new HttpD1({ accountId: process.env.CLOUDFLARE_ACCOUNT_ID || '', databaseId: process.env.D1_DATABASE_ID || '', token: process.env.CLOUDFLARE_API_TOKEN || '' });
  let tables: string[], settings: Record<string, unknown>[];
  try {
    const schema = await db.query<{ name: string; sql: string | null }>("SELECT name,sql FROM sqlite_schema WHERE type='table' ORDER BY name");
    const virtual = schema.filter(row => /CREATE VIRTUAL TABLE/i.test(row.sql || '')).map(row => row.name);
    tables = schema.filter(row => !/^sqlite_|^_cf_/.test(row.name) && !virtual.some(name => row.name === name || row.name.startsWith(name + '_'))).map(row => row.name);
    if (!tables.length || tables.some(name => !/^[a-zA-Z_]\w*$/.test(name))) throw new Error('Unexpected database table names; export stopped.');
    settings = await db.query('SELECT key,value FROM config');
  } finally { await bindings?.dispose(); }
  const child = spawn(process.execPath, [resolve('node_modules/wrangler/bin/wrangler.js'),'d1','export','movie-db', local ? '--local' : '--remote','--config',config,'--output',filename,'--skip-confirmation', ...tables.flatMap(table => ['--table', table])], { env: process.env, stdio: ['ignore','pipe','pipe'] });
  // Wrangler output may contain a signed export URL. Keep it out of logs.
  child.stdout?.resume(); child.stderr?.resume();
  const code = await new Promise((resolve, reject) => { child.once('error', reject); child.once('exit', resolve); });
  if (code !== 0) throw new Error('D1 export failed. Verify account permissions and database setup.');
  if ((await stat(filename)).size > 512 * 1024 * 1024) throw new Error('Export exceeds the 512 MiB backup bound.');
  const sql = await readFile(filename,'utf8') + "\n-- Derived FTS index is rebuilt because D1 export excludes virtual tables.\nCREATE VIRTUAL TABLE IF NOT EXISTS titles_fts USING fts5(title,slug,year,type,tokenize='unicode61');\nDELETE FROM titles_fts;\nINSERT INTO titles_fts(title,slug,year,type) SELECT title,slug,year,type FROM titles;\n";
  if (local) {
    const root = resolve('.cache/backups'); await mkdir(root, { recursive: true }); const name = backupKey(new Date()).split('/')[1];
    const bytes = encodeBackup(sql, settings); await writeFile(resolve(root,name), bytes, { mode: 0o600 });
    for (const old of (await readdir(root)).filter(name => /^\d{4}-.*\.json\.gz$/.test(name)).sort().reverse().slice(14)) await unlink(resolve(root,old));
    console.log(`Local private backup written (${bytes.length} compressed bytes); latest 14 retained. No remote account was used.`);
  } else { const result = await saveBackup(storage!,sql,settings); console.log(`Private backup uploaded (${result.bytes} bytes); latest ${result.retained} retained.`); }
} catch (error) { console.error(error instanceof Error ? error.message : 'Backup failed'); process.exitCode = 1; }
finally { await rm(work, { recursive: true, force: true }); }
