import test from 'node:test';
import assert from 'node:assert/strict';
import { chromium } from '@playwright/test';
import { performanceFixture } from './helpers/performance.ts';
test('deferred posters load on scroll and native fallback remains visible without JavaScript', async () => {
  const fixture = await performanceFixture();
  const browser = await chromium.launch({ executablePath: process.env.CHROMIUM_PATH || (process.env.CI ? undefined : '/usr/bin/chromium'), args: ['--no-sandbox', `--ignore-certificate-errors-spki-list=${fixture.spki}`] });
  try {
    const page = await browser.newPage({ viewport: { width: 360, height: 800 } });
    await page.goto(fixture.base + '/movies/');
    const deferred = page.locator('img[data-lazy-src]').last();
    assert.ok(await deferred.count());
    await deferred.scrollIntoViewIfNeeded();
    await page.waitForFunction(() => [...document.querySelectorAll('img')].some(image => image.src.includes('posters/') && image.getBoundingClientRect().top >= 0 && image.getBoundingClientRect().top < innerHeight && image.complete && image.naturalWidth > 0));
    const context = await browser.newContext({ javaScriptEnabled: false, viewport: { width: 360, height: 800 } });
    const fallback = await context.newPage(); await fallback.goto(fixture.base + '/movies/');
    const image = fallback.locator('noscript img').first(); await image.scrollIntoViewIfNeeded();
    assert.equal(await image.evaluate((value: HTMLImageElement) => getComputedStyle(value).visibility), 'visible');
    await fallback.waitForFunction(() => [...document.querySelectorAll('noscript img')].some(value => (value as HTMLImageElement).complete && (value as HTMLImageElement).naturalWidth > 0));
    await context.close();
  } finally { await browser.close(); await fixture.dispose(); }
});
