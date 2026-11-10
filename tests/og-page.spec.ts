import { test, expect } from '@playwright/test';
import { testWorker } from './helpers/worker.ts';
test('gated detail points OG tags to the owned generated card with its exact dimensions', async ({ browser }) => {
  const worker = await testWorker({ ADS_ENABLED: '0', R2_PUBLIC_BASE: 'https://images.screenpeek.example.test' });
  const page = await browser.newPage();
  try {
    await worker.local.db.batch([{ sql: "UPDATE titles SET quality_gate=1,og_r2='og/fixture.webp' WHERE id=-10001 AND type='movie'" }]);
    await page.goto(worker.base + '/movie/sample-the-quiet-atlas-1-2022/');
    await expect(page.locator('meta[property="og:image"]')).toHaveAttribute('content', 'https://images.screenpeek.example.test/og/fixture.webp');
    await expect(page.locator('meta[property="og:image:width"]')).toHaveAttribute('content', '1200');
    await expect(page.locator('meta[property="og:image:height"]')).toHaveAttribute('content', '630');
  } finally { await page.close(); await worker.dispose(); }
});
