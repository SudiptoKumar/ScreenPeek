import { test, expect } from '@playwright/test';

test('the Worker renders sample records from its actual local D1 binding without external content calls', async ({ page }) => {
  await page.setViewportSize({ width: 360, height: 800 });
  const externalRequests: string[] = [];
  page.on('request', request => {
    if (!['127.0.0.1', 'localhost'].includes(new URL(request.url()).hostname)) externalRequests.push(request.url());
  });
  const response = await page.goto('/');
  expect(response?.status()).toBe(200);
  await expect(page.locator('[data-poster-card]').first()).toContainText('Sample:');
  await expect(page.locator('meta[name="robots"]')).toHaveAttribute('content', /noindex/);
  expect(externalRequests).toEqual([]);
});
