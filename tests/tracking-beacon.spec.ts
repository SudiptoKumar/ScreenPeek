import { test, expect } from '@playwright/test';
import { testWorker } from './helpers/worker.ts';

// Gates G6.2-G6.5 (real page, real browser) against the test worker.
async function waitForEvent(worker: Awaited<ReturnType<typeof testWorker>>, eventType: string) {
  for (let i = 0; i < 32; i++) {
    const rows = await worker.local.db.query<Record<string, unknown>>(`SELECT * FROM tr_events WHERE event_type='${eventType}' ORDER BY id DESC`);
    if (rows.length) return rows[0];
    await new Promise(resolve => setTimeout(resolve, 250));
  }
  return null;
}

test('G6.2/G6.3/G6.4 (T2 off) + G6.5: pageview fields land, exit records scroll + duration, T2 fields empty, page budget holds', async ({ browser }) => {
  const worker = await testWorker({ ADS_ENABLED: '0' }, 8790);
  const context = await browser.newContext({ viewport: { width: 360, height: 800 } });
  const page = await context.newPage();
  try {
    await worker.local.db.batch([{ sql: "UPDATE config SET value='1' WHERE key='tracking_enabled'" }]);
    const home = await page.goto(worker.base + '/');
    const html = await home?.text() || '';
    expect(html.length).toBeLessThan(100_000); // G6.5 first-screen budget with the beacon on
    expect(html).toContain('/sp-beacon.js');
    const pageview = await waitForEvent(worker, 'pageview');
    expect(pageview).toBeTruthy();
    expect(Number(pageview?.screen_w)).toBeGreaterThan(0); // G6.2
    expect(pageview?.browser_timezone).toBeTruthy();
    expect(pageview?.languages).toBeTruthy();
    expect(pageview?.canvas_hash).toBe(''); // G6.4: T2 off -> empty
    expect(pageview?.webgl_renderer).toBe('');
    await page.evaluate(() => window.scrollTo(0, document.body.scrollHeight));
    await page.waitForTimeout(1500);
    await page.close(); // pagehide -> exit event
    const exit = await waitForEvent(worker, 'exit');
    expect(exit).toBeTruthy();
    const sessions = await worker.local.db.query<{ max_scroll_pct: number; total_duration_s: number }>('SELECT max_scroll_pct, total_duration_s FROM tr_sessions');
    expect(sessions.length).toBeGreaterThan(0);
    expect(sessions[0].max_scroll_pct).toBe(100); // G6.3
    expect(sessions[0].total_duration_s).toBeGreaterThan(0);
  } finally { await context.close(); await worker.dispose(); }
});

test('G6.4 (T2 on + opt-in): canvas hash and WebGL renderer are collected in Chromium', async ({ browser }) => {
  const worker = await testWorker({ ADS_ENABLED: '0' }, 8790);
  const context = await browser.newContext({ viewport: { width: 360, height: 800 } });
  const page = await context.newPage();
  try {
    await worker.local.db.batch([
      { sql: "UPDATE config SET value='1' WHERE key='tracking_enabled'" },
      { sql: "UPDATE config SET value='1' WHERE key='tracking_t2_enabled'" },
    ]);
    await context.addCookies([{ name: 'sp_consent', value: '1', url: worker.base + '/' }]);
    await page.goto(worker.base + '/');
    const pageview = await waitForEvent(worker, 'pageview');
    expect(pageview).toBeTruthy();
    expect(pageview?.canvas_hash).toBeTruthy();
    expect(pageview?.webgl_renderer).toBeTruthy();
  } finally { await context.close(); await worker.dispose(); }
});
