import { test, expect } from '@playwright/test';
test('title prefetch rules parse and reduced-motion visitors have no content animation', async ({ page }) => {
  const cdp = await page.context().newCDPSession(page);
  const rules: Array<{ errorMessage?: string }> = [];
  await cdp.send('Preload.enable');
  cdp.on('Preload.ruleSetUpdated', event => rules.push(event.ruleSet));
  await page.goto('/movies/');
  const value = JSON.parse(await page.locator('script[type="speculationrules"]').textContent() || '{}');
  expect(value.prefetch[0].where.selector_matches).toBe('a[data-poster-card]');
  expect(value.prefetch[0].eagerness).toBe('conservative');
  expect(rules.length).toBeGreaterThan(0);
  expect(rules.every(rule => !rule.errorMessage)).toBe(true);
  await page.emulateMedia({ reducedMotion: 'reduce' });
  expect(await page.locator('#content').evaluate(element => getComputedStyle(element).animationName)).toBe('none');
  await page.goto('/watch/sample-the-quiet-atlas-1-2022/');
  await expect(page.locator('script[type="speculationrules"]')).toHaveCount(0);
});
