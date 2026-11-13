import { test, expect } from '@playwright/test';
import { testWorker } from './helpers/worker.ts';

// The Smartlink has exactly two designated placements — a labelled
// Sponsored button on the detail page and a sponsored row on the watch
// page — and both render only while the managed link is active.
test('smartlink placements render only while smartlink-main is active', async ({ browser }) => {
  test.setTimeout(60_000);
  const worker = await testWorker({ ADS_ENABLED: '0' });
  const context = await browser.newContext({ viewport: { width: 360, height: 800 } });
  const page = await context.newPage();
  try {
    const slug = (await worker.local.db.query<{ slug: string }>("SELECT slug FROM titles WHERE id=-10001 AND type='movie'"))[0].slug;
    await page.goto(`${worker.base}/movie/${slug}/`);
    await expect(page.locator('a[href="/go/smartlink-main/"]')).toHaveCount(0);
    await page.goto(`${worker.base}/watch/${slug}/`);
    await expect(page.locator('a[href="/go/smartlink-main/"]')).toHaveCount(0);

    await worker.local.db.batch([{ sql: "INSERT INTO links(slug,name,destination,type,enabled) VALUES('smartlink-main','Smartlink','https://example.com/offer','smartlink',1)" }]);

    await page.goto(`${worker.base}/movie/${slug}/`);
    const detailButton = page.locator('.detail-actions a[href="/go/smartlink-main/"]');
    await expect(detailButton).toHaveCount(1);
    await expect(detailButton).toContainText('Watch Now');
    await expect(detailButton).toContainText('Sponsored');
    await expect(detailButton).toHaveAttribute('rel', /sponsored/);

    await page.goto(`${worker.base}/watch/${slug}/`);
    const watchRow = page.locator('a.sponsored-row[href="/go/smartlink-main/"]');
    await expect(watchRow).toHaveCount(1);
    await expect(watchRow).toContainText('Sponsored');
    await expect(watchRow).toHaveAttribute('data-no-popunder', '');
  } finally { await context.close(); await worker.dispose(); }
});
