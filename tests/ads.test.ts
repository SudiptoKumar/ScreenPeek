import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { createAdResolver, adActive } from '../src/lib/ads.ts';
import { applyLocalSql, localBindings, applyLocalMigrations } from '../sync/local.ts';

test('ad schedules fail closed and preview/watch exclusions do not even read storage', async () => {
  const slot = { page_type: 'detail', placement: 'native', code: '<p>Test advertisement</p>', enabled: 1 } as const;
  const now = new Date('2026-11-09T00:00:00Z');
  assert.equal(adActive(slot, now), true);
  assert.equal(adActive({ ...slot, starts_at: 'invalid' }, now), false);
  assert.equal(adActive({ ...slot, starts_at: '2026-11-10T00:00:00Z' }, now), false);
  assert.equal(adActive({ ...slot, ends_at: now.toISOString() }, now), false);
  assert.equal(adActive({ ...slot, code: ' ' }, now), false);
  const db = { prepare() { throw new Error('Storage must not be consulted'); } } as unknown as D1Database;
  const kv = { get() { throw new Error('Storage must not be consulted'); } } as unknown as KVNamespace;
  assert.equal(await createAdResolver({ DB: db, CONFIG: kv, ADS_ENABLED: '0' }, true).resolve('detail', 'native'), null);
  assert.equal(await createAdResolver({ DB: db, CONFIG: kv, ADS_ENABLED: '1' }).resolve('watch', 'popunder'), null);
  assert.equal(await createAdResolver({ DB: db, CONFIG: kv, ADS_ENABLED: '1' }).resolve('trailer', 'native'), null);
});

test('actual D1/KV resolves only its own slot; disabled mirrors and untrusted test mode cannot fall through', async () => {
  const state = await mkdtemp(resolve(tmpdir(), 'screenpeek-ads-'));
  const local = await localBindings(state);
  const env = { DB: local.database as unknown as D1Database, CONFIG: local.config as unknown as KVNamespace, ADS_ENABLED: '1' };
  try {
    await applyLocalSql(local.database, await readFile('db/schema.sql', 'utf8'));
    await applyLocalMigrations(local.database);
    const code = '\n<script data-test="original">window.example = "unchanged";</script>\n';
    await local.db.batch([
      { sql: "UPDATE config SET value='1' WHERE key='ads_enabled'" },
      { sql: 'INSERT INTO ad_slots(page_type,placement,code,enabled) VALUES(?,?,?,1)', params: ['detail', 'native', code] },
      { sql: 'INSERT INTO ad_slots(page_type,placement,code,enabled,test_mode) VALUES(?,?,?,1,1)', params: ['global', 'social_bar', '<p>Test social</p>'] },
    ]);
    assert.deepEqual(await createAdResolver(env).resolve('detail', 'native'), { code, capHours: 24 });
    assert.equal(await createAdResolver(env).resolve('watch', 'native'), null);
    assert.equal(await createAdResolver(env).resolve('global', 'social_bar'), null);
    assert.equal((await createAdResolver(env, true).resolve('global', 'social_bar'))?.code, '<p>Test social</p>');
    await local.config.put('ad:detail:native', JSON.stringify({ page_type: 'detail', placement: 'native', code, enabled: 0 }));
    assert.equal(await createAdResolver(env).resolve('detail', 'native'), null);
    await local.config.put('ad:detail:native', JSON.stringify({ page_type: 'watch', placement: 'native', code, enabled: 1 }));
    assert.equal(await createAdResolver(env).resolve('detail', 'native'), null);
    await local.config.delete('ad:detail:native');
    await local.config.put('config:popunder_cap_hours', '6');
    assert.equal((await createAdResolver(env).resolve('detail', 'native'))?.capHours, 6);
    await local.config.put('config:ads_enabled', '0');
    assert.equal(await createAdResolver(env, true).resolve('detail', 'native'), null);
  } finally { await local.dispose(); await rm(state, { recursive: true, force: true }); }
});
