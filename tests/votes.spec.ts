import { test, expect } from '@playwright/test';
import { localBindings } from '../sync/local.ts';

test('a verdict reaches D1, shows percentages and cannot repeat after reload', async ({ page }) => {
  const local = await localBindings();
  const id = -900_000_001, slug = 'temporary-verdict-fixture';
  const before = new Set((await local.config.list({ prefix: 'vote:' })).keys.map(key => key.name));
  try {
    await local.db.batch([{ sql: 'INSERT INTO titles(id,type,slug,title,quality_gate) VALUES(?,?,?,?,0)', params: [id, 'movie', slug, 'Temporary vote fixture'] }]);
    await page.setViewportSize({ width: 360, height: 800 });
    await page.goto(`/movie/${slug}/`);
    const widget = page.locator('[data-verdict-widget]');
    await widget.getByRole('button', { name: /Must Watch/ }).click();
    await expect(widget.locator('[data-vote-status]')).toContainText('Vote received');
    await expect(widget.locator('[data-choice="must"] strong')).toHaveText('100%');
    await expect.poll(async () => (await local.db.query<{ count: number }>('SELECT count FROM votes WHERE title_id=? AND title_type=? AND choice=?', [id, 'movie', 'must']))[0]?.count, { timeout: 15_000 }).toBe(1);
    await page.reload();
    await expect(widget.locator('button:enabled')).toHaveCount(0);
    await expect(widget.locator('[data-vote-status]')).toContainText('You have voted');
    await expect(widget.locator('[data-choice="must"] strong')).toHaveText('100%');
    const duplicate = await page.evaluate(async ({ id }) => {
      const response = await fetch('/api/vote/', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ id, type: 'movie', choice: 'good' }) });
      return response.status;
    }, { id });
    expect(duplicate).toBe(409);
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  } finally {
    await local.db.batch([{ sql: 'DELETE FROM votes WHERE title_id=? AND title_type=?', params: [id, 'movie'] }, { sql: 'DELETE FROM titles WHERE id=? AND type=?', params: [id, 'movie'] }]);
    for (const key of (await local.config.list({ prefix: 'vote:' })).keys) if (!before.has(key.name)) await local.config.delete(key.name);
    await local.dispose();
  }
});
