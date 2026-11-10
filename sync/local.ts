import { resolve } from 'node:path';
import { Miniflare } from 'miniflare';
import { unstable_splitSqlQuery } from 'wrangler';
import type { ImageStore } from './posters.ts';
import type { SqlClient, SqlStatement, SqlValue } from './storage.ts';

/** Actual local Cloudflare bindings, sharing Wrangler's default state directory. */
export async function localBindings(root = '.wrangler/state') {
  const runtime = new Miniflare({
    cf: false,
    enableDevRegistry: false,
    telemetry: { enabled: false },
    resourcePersistencePath: resolve(root, 'v3'),
    workers: [{
      config: {
        name: 'screenpeek-local-sync',
        // The separately installed Miniflare runtime is pinned to this date.
        compatibilityDate: '2026-11-04',
        manifest: {
          mainModule: 'local-sync.mjs',
          modules: { 'local-sync.mjs': {
            type: 'esm', contents: 'export default { fetch() { return new Response("Local sync bindings"); } };',
          } },
        },
        env: {
          DB: { type: 'd1', id: '00000000-0000-0000-0000-000000000001' },
          CONFIG: { type: 'kv', id: '00000000000000000000000000000001' },
          POSTERS: { type: 'r2', name: 'posters' },
          BACKUPS: { type: 'r2', name: 'screenpeek-private-backups-local' },
        },
      },
    }],
  });
  let database: Awaited<ReturnType<Miniflare['getD1Database']>>;
  let bucket: Awaited<ReturnType<Miniflare['getR2Bucket']>>;
  let config: Awaited<ReturnType<Miniflare['getKVNamespace']>>;
  try {
    database = await runtime.getD1Database('DB');
    bucket = await runtime.getR2Bucket('POSTERS');
    config = await runtime.getKVNamespace('CONFIG');
  } catch (error) {
    await runtime.dispose();
    throw error;
  }
  const db: SqlClient = {
    async query<T extends Record<string, unknown>>(sql: string, params: SqlValue[] = []) {
      const result = await database.prepare(sql).bind(...params).all<T>();
      return result.results;
    },
    async batch(statements: SqlStatement[]) {
      if (!statements.length) return { rowsWritten: 0 };
      const results = await database.batch(statements.map(statement => database.prepare(statement.sql).bind(...(statement.params || []))));
      return { rowsWritten: results.reduce((sum, result) => sum + (result.meta.rows_written || 0), 0) };
    },
  };
  const backups = await runtime.getR2Bucket('BACKUPS');
  const images: ImageStore = {
    async get(key) { const object = await bucket.get(key); return object ? new Uint8Array(await object.arrayBuffer()) : null; },
    async head(key) { return Boolean(await bucket.head(key)); },
    async put(key, bytes, contentType, cacheControl) {
      await bucket.put(key, bytes, { httpMetadata: { contentType, cacheControl } });
    },
  };
  return { db, database, images, bucket, config, backups, dispose: () => runtime.dispose() };
}

/** D1 exec splits on newlines; Wrangler's parser preserves multiline SQL/quotes. */
export async function applyLocalSql(
  database: Awaited<ReturnType<Miniflare['getD1Database']>>,
  sql: string,
) {
  const statements = unstable_splitSqlQuery(sql);
  if (statements.length) await database.batch(statements.map(statement => database.prepare(statement)));
}

/** Apply the current additive application migrations to an initialized local D1. */
export async function applyLocalMigrations(database: Awaited<ReturnType<Miniflare['getD1Database']>>) {
  const { readFile, readdir } = await import('node:fs/promises');
  for (const file of (await readdir('db/migrations')).filter(name => name.endsWith('.sql')).sort()) await applyLocalSql(database, await readFile(`db/migrations/${file}`, 'utf8'));
}
