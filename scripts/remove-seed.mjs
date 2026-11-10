import { localBindings, applyLocalSql } from '../sync/local.ts';
import { manifest, createRemovalSql } from '../db/seed.mjs';

const state = process.argv[2] || '.wrangler/state';
const bindings = await localBindings(state);
try {
  const owned = await bindings.db.query('SELECT value FROM config WHERE key=?', [manifest.configKey]);
  if (owned[0]?.value === JSON.stringify(manifest)) {
    const tables = new Set((await bindings.db.query("SELECT name FROM sqlite_master WHERE type='table'")).map(row => row.name));
    const cleanup = [];
    for (const table of ['title_genres', 'collection_titles', 'sync_queue']) {
      if (!tables.has(table)) continue;
      for (const title of manifest.titles) cleanup.push({ sql: `DELETE FROM ${table} WHERE title_id=? AND title_type=?`, params: [title.id, title.type] });
    }
    await bindings.db.batch(cleanup);
  }
  await applyLocalSql(bindings.database, createRemovalSql());
  const relations = await bindings.db.query("SELECT name FROM sqlite_master WHERE type='table' AND name='collection_titles'");
  if (relations.length) await bindings.db.batch([{ sql: 'UPDATE collections SET title_count=(SELECT COUNT(*) FROM collection_titles WHERE collection_slug=collections.slug)' }]);
  console.log('Removed only owned sample fixtures and dependent relations from local D1.');
} finally { await bindings.dispose(); }
