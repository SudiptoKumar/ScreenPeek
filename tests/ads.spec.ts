import { test, expect } from '@playwright/test';
import { testWorker } from './helpers/worker.ts';

test('configured codes stay in their placements; popunder admits once and is absent from watch and utility pages', async ({ browser }) => {
  test.setTimeout(60_000);
  const worker = await testWorker({ ADS_ENABLED: '1' });
  const context = await browser.newContext({ viewport: { width: 360, height: 800 } });
  const page = await context.newPage();
  try {
    await worker.local.db.batch([{ sql: "UPDATE config SET value='1' WHERE key='ads_enabled'" }]);
    const put = async (page: string, placement: string, code: string) => worker.local.config.put(`ad:${page}:${placement}`, JSON.stringify({ page_type: page, placement, code, enabled: 1 }));
    await put('detail', 'native', '<div id="detail-test-ad">Detail test ad</div><script>document.body.dataset.displayTest="original";</script>');
    await put('global', 'social_bar', '<script>document.body.dataset.socialTest="global";</script>');
    await put('detail', 'popunder', '<script>sessionStorage.setItem("test-pop-runs",String(Number(sessionStorage.getItem("test-pop-runs")||0)+1));</script>');
    // Even an accidentally configured forbidden watch slot must never be read.
    await put('watch', 'popunder', '<script>throw Error("Watch popunder must not run")</script>');
    const triggerClick = async (p: import('@playwright/test').Page) => { await p.evaluate(() => { if (!document.getElementById('test-pop-trigger')) { const b = document.createElement('button'); b.id = 'test-pop-trigger'; b.textContent = 'Trigger'; document.querySelector('main')!.appendChild(b); } }); await p.locator('#test-pop-trigger').click(); };
    const slug = (await worker.local.db.query<{ slug: string }>("SELECT slug FROM titles WHERE id=-10001 AND type='movie'"))[0].slug;
    await page.goto(`${worker.base}/movie/${slug}/`);
    await expect(page.locator('[data-placement="native"] #detail-test-ad')).toHaveText('Detail test ad');
    await expect(page.locator('#detail-test-ad')).toHaveCount(1);
    await expect(page.locator('body')).toHaveAttribute('data-display-test', 'original');
    await expect(page.locator('body')).toHaveAttribute('data-social-test', 'global');
    expect(await page.evaluate(() => sessionStorage.getItem('test-pop-runs'))).toBeNull();
    await page.evaluate(() => { const button = document.createElement('button'); button.dataset.interstitial = ''; button.id = 'test-interstitial'; button.textContent = 'Test exclusion'; document.querySelector('main')!.appendChild(button); });
    await page.locator('#test-interstitial').click();
    expect((await context.cookies()).find(cookie => cookie.name === 'pop_shown')).toBeUndefined();
    await triggerClick(page);
    await expect.poll(() => page.evaluate(() => sessionStorage.getItem('test-pop-runs'))).toBe('1');
    expect((await context.cookies()).find(cookie => cookie.name === 'pop_shown')?.value).toBe('1');
    await page.reload();
    await triggerClick(page);
    expect(await page.evaluate(() => sessionStorage.getItem('test-pop-runs'))).toBe('1');
    const second = await context.newPage();
    await second.goto(`${worker.base}/movie/${slug}/`);
    await triggerClick(second);
    expect(await second.evaluate(() => sessionStorage.getItem('test-pop-runs'))).toBeNull();
    await second.close();
    await page.goto(`${worker.base}/watch/${slug}/`);
    await expect(page.locator('[data-popunder], [data-placement="popunder"], #detail-test-ad')).toHaveCount(0);
    await expect(page.locator('body')).toHaveAttribute('data-social-test', 'global');
    await page.goto(`${worker.base}/about/`);
    await expect(page.locator('.ad-slot,[data-popunder],[data-placement="social_bar"]')).toHaveCount(0);
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
    await context.clearCookies();
    await page.goto(`${worker.base}/movie/${slug}/`);
    await page.getByRole('link', { name: /Where to Watch/ }).first().click();
    expect((await context.cookies()).find(cookie => cookie.name === 'pop_shown')).toBeUndefined();
    expect(await page.evaluate(() => sessionStorage.getItem('test-pop-runs'))).toBe('1');
    const blocked = await browser.newContext();
    try {
      await blocked.addInitScript(() => Object.defineProperty(document, 'cookie', { get() { return ''; }, set() {} }));
      const blockedPage = await blocked.newPage();
      await blockedPage.goto(`${worker.base}/movie/${slug}/`);
      await triggerClick(blockedPage);
      expect(await blockedPage.evaluate(() => sessionStorage.getItem('test-pop-runs'))).toBeNull();
    } finally { await blocked.close(); }
  } finally { await context.close(); await worker.dispose(); }
});

test('preview pages remain placeholders and URL ad-test flags do not enable scripts', async ({ page }) => {
  await page.goto('/movies/?adtest=1');
  await expect(page.locator('[data-ad-state="filled"],[data-popunder]')).toHaveCount(0);
  await expect(page.locator('[data-ad-state="placeholder"]')).toHaveCount(3);
  await expect(page.locator('[data-placement="native"]')).toHaveCount(1);
  await expect(page.locator('[data-placement="infeed"]')).toHaveCount(1);
});
