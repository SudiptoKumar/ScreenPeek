import { expect, test } from '@playwright/test';
import { testWorker } from './helpers/worker.ts';

// Gates G18/G19/G21 at the real redirect: weighted variant pick with the
// click id passed, cascade when caps fill, cap_fallback + alert event,
// and schedule blocking.
test('G18/G19/G21 variant routing: pick, cascade, cap fallback, schedule', async () => {
  test.setTimeout(120_000);
  const worker = await testWorker({ ADS_ENABLED: '0' }, 8790);
  try {
    await worker.local.db.batch([
      { sql: "UPDATE config SET value='1' WHERE key='tracking_enabled'" },
      { sql: "INSERT INTO links(slug,name,destination,type,enabled) VALUES('route-link','Route','https://example.com/base','smartlink',1)" },
      { sql: "INSERT INTO tr_link_variants(id,link_slug,dest_url,weight,chain_order,active,cap_clicks_day) VALUES(1,'route-link','https://example.com/variant-a',100,1,1,1),(2,'route-link','https://example.com/variant-b',0,2,1,1)" },
    ]);
    const go = async () => {
      const response = await fetch(worker.base + '/go/route-link/', { redirect: 'manual' });
      return response.headers.get('Location') || '';
    };
    // First click: variant A serves (weight 100), click id appended.
    const first = await go();
    expect(first).toContain('https://example.com/variant-a');
    expect(first).toContain('sp_cid=');
    // Second click: A is at its click cap (1) -> cascade to B.
    const second = await go();
    expect(second).toContain('https://example.com/variant-b');
    // Third click: both capped -> the link's own destination, cap_fallback.
    const third = await go();
    expect(third).toContain('https://example.com/base');
    const rows = await worker.local.db.query<{ route_reason: string; variant_id: number | null }>('SELECT route_reason, variant_id FROM tr_clicks ORDER BY id');
    expect(rows.map(row => row.route_reason)).toEqual(['variant:1', 'variant:2', 'cap_fallback']);
    expect(rows[0].variant_id).toBe(1);
    expect(rows[2].variant_id).toBeNull();
    const alerts = await worker.local.db.query<{ kind: string; ref: string }>('SELECT kind, ref FROM tr_alerts');
    expect(alerts.length).toBeGreaterThan(0);
    expect(alerts[0].kind).toBe('cap_hit');
    // Schedule: a variant blocked every weekday routes to 'schedule'.
    await worker.local.db.batch([
      { sql: "INSERT INTO links(slug,name,destination,type,enabled) VALUES('sched-link','Sched','https://example.com/sched-base','smartlink',1)" },
      { sql: `INSERT INTO tr_link_variants(id,link_slug,dest_url,weight,chain_order,active,schedule) VALUES(9,'sched-link','https://example.com/never',100,1,1,'{"days":[9],"tz":"UTC"}')` },
    ]);
    const scheduled = await fetch(worker.base + '/go/sched-link/', { redirect: 'manual' });
    expect(scheduled.headers.get('Location')).toContain('https://example.com/sched-base');
    const schedRows = await worker.local.db.query<{ route_reason: string }>("SELECT route_reason FROM tr_clicks WHERE slug='sched-link'");
    expect(schedRows).toEqual([{ route_reason: 'schedule' }]);
  } finally { await worker.dispose(); }
});
