import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import { localBindings, applyLocalSql } from '../sync/local.ts';
import { TRACKING_DEFAULTS } from '../src/lib/tracking/config.ts';

// Gate G1 (schema half): migration 012 applies cleanly and idempotently,
// alters nothing that existed, and seeds the Insight config defaults.

const TR_TABLES = ['tr_alerts', 'tr_click_daily', 'tr_clicks', 'tr_conversions', 'tr_cost_daily',
  'tr_events', 'tr_export_jobs', 'tr_link_health', 'tr_link_variants', 'tr_page_daily',
  'tr_postbacks_out', 'tr_postbacks_raw', 'tr_sessions'];

async function freshDb(upto: string) {
  const state = await mkdtemp(resolve(tmpdir(), 'screenpeek-tracking-schema-'));
  const local = await localBindings(state);
  await applyLocalSql(local.database, await readFile('db/schema.sql', 'utf8'));
  const files = (await readdir('db/migrations')).filter(name => name.endsWith('.sql')).sort();
  for (const file of files) {
    if (file > upto) break;
    await applyLocalSql(local.database, await readFile(`db/migrations/${file}`, 'utf8'));
  }
  return { state, local };
}

test('G1.1/G1.2/G1.3 migration 012 is additive, idempotent, and seeds defaults', { timeout: 60_000 }, async () => {
  const { state, local } = await freshDb('011-adsterra-stats.sql');
  try {
    const before = await local.db.query<{ name: string; sql: string }>(
      "SELECT name, sql FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' ORDER BY name");
    const migration = await readFile('db/migrations/012-tracking.sql', 'utf8');
    await applyLocalSql(local.database, migration);
    await applyLocalSql(local.database, migration); // G1.1: re-run without error

    const after = await local.db.query<{ name: string; sql: string }>(
      "SELECT name, sql FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' ORDER BY name");
    const beforeMap = new Map(before.map(row => [row.name, row.sql]));
    // G1.2: every pre-existing table is still present with identical SQL.
    for (const [name, sql] of beforeMap) assert.equal(after.find(row => row.name === name)?.sql, sql, `existing table changed: ${name}`);
    const added = after.map(row => row.name).filter(name => !beforeMap.has(name)).sort();
    assert.deepEqual(added, TR_TABLES);

    // G1.3: tracking_enabled defaults to 0 and every seeded key matches the defaults map.
    const rows = await local.db.query<{ key: string; value: string }>("SELECT key, value FROM config WHERE key LIKE 'tracking_%'");
    const config = new Map(rows.map(row => [row.key, row.value]));
    assert.equal(config.get('tracking_enabled'), '0');
    for (const [key, value] of Object.entries(TRACKING_DEFAULTS)) assert.equal(config.get(key), value, `config default mismatch: ${key}`);
  } finally { await local.dispose(); await rm(state, { recursive: true, force: true }); }
});
