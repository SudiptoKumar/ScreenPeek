import { test, expect } from '@playwright/test';
import { testWorker } from './helpers/worker.ts';
test('detail shows three distinct country providers and a remainder linking to Watch', async ({ browser }) => {
  const worker = await testWorker({ ADS_ENABLED: '0' }); const page = await browser.newPage();
  try {
    await worker.local.db.batch([{ sql: "DELETE FROM providers WHERE title_id=-10001 AND title_type='movie'" }, { sql: "INSERT INTO providers(title_id,title_type,country,provider_id,provider_name,offer_type) VALUES(-10001,'movie','US',1,'Provider One','stream'),(-10001,'movie','US',1,'Provider One','rent'),(-10001,'movie','US',2,'Provider Two','stream'),(-10001,'movie','US',3,'Provider Three','stream'),(-10001,'movie','US',4,'Provider Four','stream'),(-10001,'movie','GB',5,'UK Only','stream')" }]);
    await page.goto(worker.base + '/movie/sample-the-quiet-atlas-1-2022/');
    const strip = page.locator('.streaming-strip'); await expect(strip.locator('a')).toHaveCount(4);
    await expect(strip).toContainText('+1 more'); await expect(strip).not.toContainText('UK Only');
    for (const link of await strip.locator('a').all()) await expect(link).toHaveAttribute('href', '/watch/sample-the-quiet-atlas-1-2022/');
    await expect(page.locator('.provider-credit')).toContainText('JustWatch');
  } finally { await page.close(); await worker.dispose(); }
});
