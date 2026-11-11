import { test, expect } from '@playwright/test';

test('floating top ads push the page down and closing them restores it', async ({ page }) => {
  await page.goto('/series/');
  await expect(page.locator('body')).toHaveCSS('padding-top', '0px');
  await page.evaluate(() => {
    const first = document.createElement('div');
    first.id = 'fake-top-ad-1';
    first.style.cssText = 'position:fixed;top:0;left:0;width:100%;height:90px;z-index:9999';
    document.body.appendChild(first);
    const second = document.createElement('div');
    second.id = 'fake-top-ad-2';
    second.style.cssText = 'position:fixed;top:90px;left:0;width:100%;height:70px;z-index:9998';
    document.body.appendChild(second);
  });
  await expect(page.locator('body')).toHaveCSS('padding-top', '160px');
  await page.evaluate(() => document.getElementById('fake-top-ad-2')?.remove());
  await expect(page.locator('body')).toHaveCSS('padding-top', '90px');
  await page.evaluate(() => document.getElementById('fake-top-ad-1')?.remove());
  await expect(page.locator('body')).toHaveCSS('padding-top', '0px');
});

test('a full-screen overlay is not treated as a top bar', async ({ page }) => {
  await page.goto('/series/');
  await page.evaluate(() => {
    const overlay = document.createElement('div');
    overlay.id = 'fake-vignette';
    overlay.style.cssText = 'position:fixed;top:0;left:0;width:100%;height:100%;z-index:9999';
    document.body.appendChild(overlay);
  });
  await page.waitForTimeout(600);
  await expect(page.locator('body')).toHaveCSS('padding-top', '0px');
  await page.evaluate(() => document.getElementById('fake-vignette')?.remove());
});
