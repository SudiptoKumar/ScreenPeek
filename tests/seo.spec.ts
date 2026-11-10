import { test, expect } from '@playwright/test';
import { testWorker } from './helpers/worker.ts';

test('preview canonicals and detail structured metadata remain safe across country/filter variants', async ({ page }) => {
  await page.setViewportSize({ width: 360, height: 800 });
  await page.goto('/movies/page/2/');
  await expect(page.locator('link[rel="canonical"]')).toHaveAttribute('href', 'https://example.workers.dev/movies/page/2/');
  await expect(page.locator('meta[name="robots"]')).toHaveAttribute('content', /noindex/);
  await page.goto('/movies/filter/?genre=drama');
  await expect(page.locator('link[rel="canonical"]')).toHaveAttribute('href', 'https://example.workers.dev/movies/');
  const href = await page.locator('[data-poster-card]').first().getAttribute('href');
  await page.goto(href!);
  await expect(page.locator('meta[property="og:title"]')).toHaveAttribute('content', /Sample:/);
  await expect(page.locator('meta[name="twitter:card"]')).toHaveAttribute('content', 'summary_large_image');
  const schema = JSON.parse(await page.locator('script[type="application/ld+json"]').textContent() || '[]');
  expect(schema.some((item: { '@type': string }) => item['@type'] === 'Movie')).toBe(true);
  expect(JSON.stringify(schema)).not.toMatch(/aggregateRating|"Review"/);
  const slug = href!.split('/').filter(Boolean).at(-1);
  await page.goto(`/watch/${slug}/?country=GB`);
  await expect(page.locator('link[rel="canonical"]')).toHaveAttribute('href', `https://example.workers.dev/watch/${slug}/`);
});

test('production Worker generates gated XML sitemaps and production robots while ungated details remain noindex', async ({ browser }) => {
  const worker = await testWorker({ DEPLOYMENT_ENV: 'production', SITE_URL: 'https://screenpeek.example.test', ADS_ENABLED: '0' });
  const context = await browser.newContext();
  const page = await context.newPage();
  try {
    await worker.local.db.batch([
      { sql: "DELETE FROM config WHERE key IN('dev:sample_data','dev:fixture_import')" },
      { sql: "UPDATE titles SET quality_gate=1 WHERE id=-10001 AND type='movie'" },
    ]);
    const title = (await worker.local.db.query<{ slug: string }>("SELECT slug FROM titles WHERE id=-10001 AND type='movie'"))[0];
    const index = await context.request.get(`${worker.base}/sitemap.xml`);
    expect(index.status()).toBe(200); expect(index.headers()['content-type']).toContain('application/xml');
    expect(await index.text()).toContain('https://screenpeek.example.test/sitemap-titles-1.xml');
    const map = await context.request.get(`${worker.base}/sitemap-titles-1.xml`);
    expect(map.status()).toBe(200); const body = await map.text();
    expect((body.match(/<url>/g) || []).length).toBe(1); expect(body).toContain(title.slug);
    const robots = await context.request.get(`${worker.base}/robots.txt`);
    expect(await robots.text()).toContain('Disallow: /admin/'); expect(await robots.text()).toContain('Sitemap: https://screenpeek.example.test/sitemap.xml');
    await page.goto(`${worker.base}/movie/${title.slug}/`);
    await expect(page.locator('meta[name="robots"]')).toHaveCount(0);
    const filtered = await page.goto(`${worker.base}/movies/filter/?sort=rating`);
    expect(filtered?.headers()['cache-control']).toContain('private, no-store');
    await expect(page.locator('meta[name="robots"]')).toHaveAttribute('content', /noindex/);
    await expect(page.locator('link[rel="canonical"]')).toHaveAttribute('href', 'https://screenpeek.example.test/movies/');
    const ungated = (await worker.local.db.query<{ slug: string }>("SELECT slug FROM titles WHERE id=-10002 AND type='movie'"))[0];
    await page.goto(`${worker.base}/movie/${ungated.slug}/`);
    await expect(page.locator('meta[name="robots"]')).toHaveAttribute('content', /noindex/);
    expect(body).not.toContain(ungated.slug);
    const taxonomy = await context.request.get(`${worker.base}/sitemap-taxonomy.xml`);
    expect(taxonomy.status()).toBe(200);
    await page.goto(`${worker.base}/sitemap-people.xml`);
    expect(await page.locator('parsererror').count()).toBe(0);
  } finally { await context.close(); await worker.dispose(); }
});
