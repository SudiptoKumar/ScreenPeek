import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtemp, readFile, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import { localBindings, applyLocalSql } from '../sync/local.ts';
import { planShifts, runAutoopt } from '../src/lib/tracking/autoopt.ts';

test('G20.1 planShifts: at most 20 points, locked and under-floor variants never move', () => {
  const scores = new Map([[1, { clicks: 500, epcMinor: 900 }], [2, { clicks: 500, epcMinor: 100 }], [3, { clicks: 500, epcMinor: 50 }]]);
  const shifts = planShifts([
    { id: 1, weight: 40, locked: 0 }, { id: 2, weight: 40, locked: 0 }, { id: 3, weight: 20, locked: 0 },
  ], scores, 200);
  const best = shifts.find(shift => shift.variantId === 1);
  assert.equal(best?.after, 60); // +20 exactly
  assert.equal(shifts.reduce((sum, shift) => sum + (shift.after - shift.before), 0), 0); // total preserved
  // Locked loser keeps its weight; the movable loser funds the whole gain.
  const locked = planShifts([
    { id: 1, weight: 40, locked: 0 }, { id: 2, weight: 40, locked: 1 }, { id: 3, weight: 20, locked: 0 },
  ], scores, 200);
  assert.equal(locked.find(shift => shift.variantId === 2), undefined);
  assert.equal(locked.find(shift => shift.variantId === 1)?.after, 60);
  // Under the floor: no shifts at all.
  assert.deepEqual(planShifts([{ id: 1, weight: 50, locked: 0 }, { id: 2, weight: 50, locked: 0 }],
    new Map([[1, { clicks: 10, epcMinor: 900 }], [2, { clicks: 500, epcMinor: 100 }]]), 200), []);
});

test('G20.2 suggestion mode logs without moving weights; apply mode shifts and logs before/after', { timeout: 60_000 }, async () => {
  const state = await mkdtemp(resolve(tmpdir(), 'screenpeek-ao-'));
  const local = await localBindings(state);
  try {
    await applyLocalSql(local.database, await readFile('db/schema.sql', 'utf8'));
    for (const file of (await readdir('db/migrations')).filter(name => name.endsWith('.sql')).sort())
      await applyLocalSql(local.database, await readFile(`db/migrations/${file}`, 'utf8'));
    await local.db.batch([
      { sql: "UPDATE config SET value='1' WHERE key='tracking_enabled'" },
      { sql: "INSERT INTO links(slug,name,destination,type,enabled) VALUES('opt-link','Opt','https://example.com/base','smartlink',1)" },
      { sql: "INSERT INTO tr_link_settings(slug,autoopt) VALUES('opt-link',1)" },
      { sql: "INSERT INTO tr_link_variants(id,link_slug,dest_url,weight,active) VALUES(1,'opt-link','https://example.com/a',50,1),(2,'opt-link','https://example.com/b',50,1)" },
    ]);
    // 10 clicks per variant today (floor lowered to 5 for this test);
    // variant 1 converts at 500 minor/click, variant 2 at zero.
    const statements = [];
    for (let i = 0; i < 10; i++) {
      statements.push({ sql: `INSERT INTO tr_clicks(click_id,ts,slug,variant_id,country,device_type) VALUES('a-${i}',datetime('now'),'opt-link',1,'US','mobile')` });
      statements.push({ sql: `INSERT INTO tr_clicks(click_id,ts,slug,variant_id,country,device_type) VALUES('b-${i}',datetime('now'),'opt-link',2,'US','mobile')` });
      statements.push({ sql: `INSERT INTO tr_conversions(click_id,network,event,payout_minor,currency,status_mapped,txid) VALUES('a-${i}','net','purchase',500,'USD','approved','tx-a-${i}')` });
    }
    await local.db.batch(statements);
    await local.db.batch([{ sql: "UPDATE config SET value='5' WHERE key='tracking_autoopt_min_clicks'" }]);
    const store = new Map<string, string>();
    const env = {
      DB: local.database,
      CONFIG: {
        get: async (key: string) => store.get(key) ?? null,
        put: async (key: string, value: string) => { store.set(key, value); },
      } as unknown as KVNamespace,
    };
    const suggested = await runAutoopt(env);
    assert.equal(suggested.proposals.length, 1);
    assert.equal(suggested.proposals[0].applied, false);
    let weights = await local.db.query<{ id: number; weight: number }>('SELECT id, weight FROM tr_link_variants ORDER BY id');
    assert.deepEqual(weights, [{ id: 1, weight: 50 }, { id: 2, weight: 50 }]); // unchanged in suggestion mode
    await local.db.batch([{ sql: "UPDATE config SET value='1' WHERE key='tracking_autoopt_apply'" }]);
    const applied = await runAutoopt(env);
    assert.equal(applied.proposals[0].applied, true);
    weights = await local.db.query<{ id: number; weight: number }>('SELECT id, weight FROM tr_link_variants ORDER BY id');
    assert.deepEqual(weights, [{ id: 1, weight: 70 }, { id: 2, weight: 30 }]); // +20 toward the best EPC
    const logs = await local.db.query<{ entity: string }>("SELECT entity FROM admin_log WHERE entity='autoopt'");
    assert.equal(logs.length, 2); // both runs logged
  } finally { await local.dispose(); await rm(state, { recursive: true, force: true }); }
});
