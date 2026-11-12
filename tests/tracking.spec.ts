import { test, expect } from '@playwright/test';
import { readFile } from 'node:fs/promises';
import { testWorker } from './helpers/worker.ts';

const vectors = JSON.parse(await readFile('tests/fixtures/tracking-vectors.json', 'utf8')) as {
  user_agents: { name: string; ua: string }[];
};
const uaOf = (name: string) => vectors.user_agents.find(item => item.name === name)?.ua || '';

async function waitForRow(worker: Awaited<ReturnType<typeof testWorker>>, sql: string) {
  for (let i = 0; i < 28; i++) {
    const rows = await worker.local.db.query<Record<string, unknown>>(sql);
    if (rows.length) return rows[0];
    await new Promise(resolve => setTimeout(resolve, 250));
  }
  return null;
}

// Gate G1 (behaviour half): with tracking OFF (the shipped default), the
// site behaves exactly as before Insight existed.
test('G1.4/G1.5 tracking off: /go/ unchanged, click_log +1, zero tr_clicks, no beacon, no sp_ cookies', async () => {
  const worker = await testWorker({ ADS_ENABLED: '0' }, 8790);
  try {
    await worker.local.db.batch([
      { sql: "INSERT INTO links(slug,name,destination,type,enabled) VALUES('insight-probe','Probe','https://example.com/landing','other',1)" },
    ]);
    const res = await fetch(worker.base + '/go/insight-probe/', { redirect: 'manual' });
    expect(res.status).toBe(302);
    expect(res.headers.get('location')).toBe('https://example.com/landing');
    // The existing aggregate counter flushes in the background.
    let clicks = 0;
    for (let i = 0; i < 24 && clicks === 0; i++) {
      await new Promise(resolve => setTimeout(resolve, 250));
      clicks = (await worker.local.db.query<{ count: number }>("SELECT COALESCE(SUM(count),0) AS count FROM click_log WHERE slug='insight-probe'"))[0].count;
    }
    expect(clicks).toBe(1);
    const raw = (await worker.local.db.query<{ count: number }>('SELECT COUNT(*) AS count FROM tr_clicks'))[0].count;
    expect(raw).toBe(0);
    const home = await fetch(worker.base + '/');
    const html = await home.text();
    expect(html).not.toContain('/api/beacon');
    expect(html).not.toContain('sp-beacon');
    const cookies = home.headers.get('set-cookie') || '';
    expect(cookies).not.toContain('sp_vid');
    expect(cookies).not.toContain('sp_sid');
  } finally { await worker.dispose(); }
});

test('G3.1-G3.6 tracking on: full click row, click id passed, iPhone model empty, latency budget', async () => {
  const worker = await testWorker({ ADS_ENABLED: '0' }, 8790);
  try {
    await worker.local.db.batch([
      { sql: "UPDATE config SET value='1' WHERE key='tracking_enabled'" },
      { sql: "INSERT INTO links(slug,name,destination,type,enabled) VALUES('gate3','Gate 3','https://example.com/offer','smartlink',1)" },
    ]);
    const desktop = await fetch(worker.base + '/go/gate3/?utm_source=google&utm_medium=cpc&sub1=abc&sp_page=/movie/dune&sp_title=Dune', {
      redirect: 'manual',
      headers: { 'User-Agent': uaOf('windows_chrome_desktop'), 'CF-Connecting-IP': '203.0.113.87' },
    });
    expect(desktop.status).toBe(302);
    const location = desktop.headers.get('location') || '';
    const clickId = new URL(location).searchParams.get('sp_cid');
    expect(clickId).toBeTruthy(); // G3.5: click id passed to the destination
    const row = await waitForRow(worker, `SELECT * FROM tr_clicks WHERE click_id='${clickId}'`);
    expect(row).toBeTruthy();
    expect(row?.browser).toBe('Chrome'); // G3.1
    expect(row?.device_type).toBe('desktop');
    expect(row?.route_reason).toBe('default');
    expect(row?.utm_source).toBe('google'); // G3.3
    expect(row?.sub1).toBe('abc');
    expect(row?.sp_page).toBe('/movie/dune');
    expect(row?.sp_title).toBe('Dune');
    expect(row?.ip).toBe('203.0.113.0'); // masked by default
    expect(row?.dest_host).toBe('example.com');

    const iphone = await fetch(worker.base + '/go/gate3/', { redirect: 'manual', headers: { 'User-Agent': uaOf('iphone_safari_frozen') } });
    const iphoneId = new URL(iphone.headers.get('location') || '').searchParams.get('sp_cid');
    const iphoneRow = await waitForRow(worker, `SELECT * FROM tr_clicks WHERE click_id='${iphoneId}'`);
    expect(iphoneRow?.device_model).toBe(''); // G3.2: never guessed
    expect(iphoneRow?.browser).toBe('Safari');

    // G3.6: median added latency of capture on vs off stays under 10 ms.
    const median = async (enabled: string) => {
      await worker.local.db.batch([{ sql: `UPDATE config SET value='${enabled}' WHERE key='tracking_enabled'` }]);
      await fetch(worker.base + '/go/gate3/', { redirect: 'manual' }); // warm-up
      const times: number[] = [];
      for (let i = 0; i < 10; i++) {
        const start = performance.now();
        await fetch(worker.base + '/go/gate3/', { redirect: 'manual' });
        times.push(performance.now() - start);
      }
      return times.sort((a, b) => a - b)[5];
    };
    const offMedian = await median('0');
    const onMedian = await median('1');
    expect(onMedian - offMedian).toBeLessThan(10);
  } finally { await worker.dispose(); }
});
