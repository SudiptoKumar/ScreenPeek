import { chromium } from '@playwright/test';
import type { Browser } from '@playwright/test';
import lighthouse from 'lighthouse';
import { mkdir, writeFile } from 'node:fs/promises';
import { performanceFixture } from '../tests/helpers/performance.ts';

const limit = 100_000;
// The homepage carries the editorial identity (Fraunces display font + the
// numbered Top 10 first screen) — its documented budget is 120 KB
// (2026-11-14 redesign mandate, see DESIGN.md). Every other page: 100 KB.
const limits: Record<string, number> = { '/': 120_000 };
const limitFor = (path: string) => limits[path] ?? limit;
function enforce(bytes: number, path: string) {
  const pageLimit = limitFor(path);
  if (bytes > pageLimit) throw new Error(`First-screen budget exceeded on ${path}: ${bytes} bytes > ${pageLimit} bytes.`);
}
async function measure(browser: Browser, url: string, images: string) {
  const context = await browser.newContext({ viewport: { width: 360, height: 800 }, deviceScaleFactor: 1, isMobile: true, hasTouch: true });
  try {
    const page = await context.newPage(), session = await context.newCDPSession(page);
    await session.send('Network.enable'); await session.send('Network.setCacheDisabled', { cacheDisabled: true });
    const owned = new Set([new URL(url).origin, images]);
    const requests = new Map<string, { url: string; type: string; bytes: number }>();
    const failed: string[] = [], thirdParty: string[] = [];
    session.on('Network.responseReceived', event => {
      if (owned.has(new URL(event.response.url).origin)) requests.set(event.requestId, { url: event.response.url, type: event.type, bytes: 0 });
      else thirdParty.push(event.response.url);
      if (event.response.status >= 400) failed.push(`${event.response.status}: ${event.response.url}`);
    });
    session.on('Network.loadingFinished', event => { const request = requests.get(event.requestId); if (request) request.bytes = event.encodedDataLength; });
    session.on('Network.loadingFailed', event => failed.push(event.errorText));
    const response = await page.goto(url, { waitUntil: 'networkidle' });
    if (response?.status() !== 200 || failed.length || thirdParty.length) throw new Error(`Invalid performance fixture: HTTP ${response?.status()}, failed=${failed.join(',')}, third-party=${thirdParty.join(',')}`);
    const visible = await page.evaluate(() => ({
      loadedImages: [...document.images].filter(image => image.complete && image.naturalWidth > 0).length,
      offscreenImagesLoaded: [...document.images].filter(image => image.complete && image.naturalWidth > 0 && (image.getBoundingClientRect().top >= innerHeight || image.getBoundingClientRect().left >= innerWidth)).length,
      cssFiles: document.querySelectorAll('link[rel="stylesheet"]').length,
    }));
    const resources = [...requests.values()];
    const bytes = resources.reduce((sum, item) => sum + item.bytes, 0);
    if (!bytes || resources.some(item => !item.bytes)) throw new Error('Incomplete transfer measurement');
    return { bytes, ...visible, resources };
  } finally { await context.close(); }
}

const bloat = process.argv.includes('--bloat'), reportRoot = bloat ? '.cache/performance/bloat' : '.cache/performance';
await mkdir(reportRoot, { recursive: true });
const fixture = await performanceFixture(bloat);
let browser: Browser | undefined;
try {
  browser = await chromium.launch({ executablePath: process.env.CHROMIUM_PATH || (process.env.CI ? undefined : '/usr/bin/chromium'), args: ['--no-sandbox', '--remote-debugging-port=9224', `--ignore-certificate-errors-spki-list=${fixture.spki}`] });
  const results = [];
  const paths = bloat ? [fixture.detail] : ['/', fixture.detail, '/movies/', fixture.watch];
  for (const path of paths) {
    const result = await measure(browser, fixture.base + path, fixture.images);
    results.push({ path, ...result });
    console.log(`${path}: ${(result.bytes / 1000).toFixed(2)} KB, ${result.loadedImages} loaded images (${result.offscreenImagesLoaded} off screen)`);
  }
  await writeFile(`${reportRoot}/bytes.json`, JSON.stringify({ limit, viewport: '360x800', conditions: 'Cold cache; no scroll; representative synthetic WebP fixtures on a separate owned HTTPS origin; placeholders for ads; CDP transferred bytes including headers; local Worker/static assets', images: fixture.imageBytes, results }, null, 2));
  const failures: string[] = [];
  for (const result of results) { try { enforce(result.bytes, result.path); } catch (error) { failures.push((error as Error).message); } }
  if (!bloat && !process.argv.includes('--bytes-only')) {
    for (const [name, path] of [['home', '/'], ['detail', fixture.detail], ['list', '/movies/']]) {
      const result = await lighthouse(fixture.base + path, { port: 9224, onlyCategories: ['performance'], output: ['html', 'json'], logLevel: 'error', formFactor: 'mobile', screenEmulation: { mobile: true, width: 360, height: 800, deviceScaleFactor: 1, disabled: false } });
      if (!result || result.lhr.runtimeError) throw new Error(`Lighthouse failed on ${name}: ${result?.lhr.runtimeError?.code || 'no result'}`);
      const reports = Array.isArray(result.report) ? result.report : [result.report];
      await writeFile(`${reportRoot}/${name}.html`, reports[0]); await writeFile(`${reportRoot}/${name}.json`, reports[1]);
      const score = Math.round((result.lhr.categories.performance.score || 0) * 100);
      console.log(`Lighthouse mobile ${name}: ${score}/100; LCP ${result.lhr.audits['largest-contentful-paint'].displayValue}; CLS ${result.lhr.audits['cumulative-layout-shift'].displayValue}`);
      if (score < 90) failures.push(`Lighthouse mobile ${name} ${score} < 90 target.`);
    }
  }
  if (failures.length) throw new Error(failures.join('\n'));
} catch (error) { console.error(error instanceof Error ? error.message : 'Performance gate failed'); process.exitCode = 1; }
finally { await browser?.close(); await fixture.dispose(); }
