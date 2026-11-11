import { test, expect } from '@playwright/test';

const pad = (page: import('@playwright/test').Page) =>
  page.evaluate(() => parseFloat(getComputedStyle(document.body).paddingTop));
const headerPosition = (page: import('@playwright/test').Page) =>
  page.evaluate(() => getComputedStyle(document.querySelector('.site-header')!).position);
const headerBottom = (page: import('@playwright/test').Page) =>
  page.evaluate(() => document.querySelector('.site-header')!.getBoundingClientRect().bottom);

test('floating top ads push the page down and closing them restores it', async ({ page }) => {
  await page.goto('/series/');
  await expect(page.locator('body')).toHaveCSS('padding-top', '0px');
  await page.evaluate(() => {
    const first = document.createElement('div');
    first.id = 'fake-top-ad-1';
    first.style.cssText = 'position:fixed;top:0;left:0;width:100%;height:90px;z-index:9999;background:red';
    document.body.appendChild(first);
    const second = document.createElement('div');
    second.id = 'fake-top-ad-2';
    second.style.cssText = 'position:fixed;top:90px;left:0;width:100%;height:70px;z-index:9998;background:blue';
    document.body.appendChild(second);
  });
  await expect.poll(() => pad(page)).toBeGreaterThanOrEqual(156);
  await expect.poll(() => pad(page)).toBeLessThanOrEqual(164);
  await expect.poll(() => headerPosition(page)).toBe('static');
  await page.evaluate(() => window.scrollTo(0, 900));
  await expect.poll(() => headerBottom(page)).toBeLessThanOrEqual(0);
  await page.evaluate(() => window.scrollTo(0, 0));
  await page.evaluate(() => document.getElementById('fake-top-ad-2')?.remove());
  await expect.poll(() => pad(page)).toBeGreaterThanOrEqual(86);
  await expect.poll(() => pad(page)).toBeLessThanOrEqual(94);
  await page.evaluate(() => document.getElementById('fake-top-ad-1')?.remove());
  await expect(page.locator('body')).toHaveCSS('padding-top', '0px');
  await expect.poll(() => headerPosition(page)).toBe('sticky');
});

test('a full-screen overlay is not treated as a top bar', async ({ page }) => {
  await page.goto('/series/');
  await page.evaluate(() => {
    const overlay = document.createElement('div');
    overlay.id = 'fake-vignette';
    overlay.style.cssText = 'position:fixed;top:0;left:0;width:100%;height:100%;z-index:9999;background:black';
    document.body.appendChild(overlay);
  });
  await page.waitForTimeout(600);
  await expect(page.locator('body')).toHaveCSS('padding-top', '0px');
  await page.evaluate(() => document.getElementById('fake-vignette')?.remove());
});

test('an empty leftover container does not push the page down', async ({ page }) => {
  await page.goto('/series/');
  await page.evaluate(() => {
    const shell = document.createElement('div');
    shell.id = 'fake-empty-shell';
    shell.style.cssText = 'position:fixed;top:0;left:0;width:100%;height:170px;z-index:9999';
    document.body.appendChild(shell);
  });
  await page.waitForTimeout(600);
  await expect(page.locator('body')).toHaveCSS('padding-top', '0px');
  await page.evaluate(() => document.getElementById('fake-empty-shell')?.remove());
});

test('a bar wrapped in a full-height overlay container is still detected', async ({ page }) => {
  await page.goto('/series/');
  await page.evaluate(() => {
    const wrap = document.createElement('div');
    wrap.id = 'fake-wrap';
    wrap.style.cssText = 'position:fixed;top:0;left:0;width:100%;height:100%;z-index:9999;pointer-events:none';
    const bar = document.createElement('div');
    bar.style.cssText = 'position:absolute;top:0;left:0;width:100%;height:95px;background:green;pointer-events:auto';
    const img = document.createElement('img');
    img.src = '/tmdb.svg';
    img.style.cssText = 'width:60px;height:40px';
    bar.appendChild(img);
    wrap.appendChild(bar);
    document.body.appendChild(wrap);
  });
  await expect.poll(() => pad(page)).toBeGreaterThanOrEqual(91);
  await expect.poll(() => pad(page)).toBeLessThanOrEqual(99);
  await page.evaluate(() => document.getElementById('fake-wrap')?.remove());
  await expect(page.locator('body')).toHaveCSS('padding-top', '0px');
});

test('the page follows the ad while it slides in, not after it', async ({ page }) => {
  await page.goto('/series/');
  await expect(page.locator('body')).toHaveCSS('padding-top', '0px');
  await page.evaluate(() => {
    const bar = document.createElement('div');
    bar.id = 'fake-sliding-ad';
    bar.style.cssText = 'position:fixed;top:0;left:0;width:100%;height:0px;z-index:9999;background:purple';
    document.body.appendChild(bar);
    let h = 0;
    const timer = setInterval(() => {
      h += 10;
      bar.style.height = `${h}px`;
      if (h >= 100) clearInterval(timer);
    }, 60);
  });
  // Mid-animation the padding must already be part-way, not 0 and not final.
  await page.waitForTimeout(330);
  const mid = await pad(page);
  expect(mid).toBeGreaterThan(15);
  expect(mid).toBeLessThan(95);
  await expect.poll(() => pad(page)).toBeGreaterThanOrEqual(96);
  await expect.poll(() => pad(page)).toBeLessThanOrEqual(104);
  await page.evaluate(() => document.getElementById('fake-sliding-ad')?.remove());
  await expect(page.locator('body')).toHaveCSS('padding-top', '0px');
});
