import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { applyLocalSql, localBindings, applyLocalMigrations } from '../sync/local.ts';
import { loadTrustPage, trustMarkdown, trustSlugs } from '../src/lib/trust.ts';

test('trust Markdown escapes HTML, blocks active protocols and images, and retains ordinary Markdown', () => {
  const html = trustMarkdown('## Heading\n\n**Text** and [Contact](/contact/).\n\n<script>alert(1)</script>\n\n[Bad](javascript:alert%281%29)\n\n![Image](https://unowned.example.test/image.webp)');
  assert.match(html, /<h2>Heading<\/h2>/); assert.match(html, /<strong>Text<\/strong>/);
  assert.match(html, /href="\/contact\/"/);
  assert.doesNotMatch(html, /<script|<img|href="javascript:/);
});
test('actual D1 trust defaults load, stored edits render, and storage failures are honest', async () => {
  const state = await mkdtemp(resolve(tmpdir(), 'screenpeek-trust-'));
  const local = await localBindings(state), db = local.database as unknown as D1Database;
  try {
    await applyLocalSql(local.database, await readFile('db/schema.sql', 'utf8'));
    await applyLocalMigrations(local.database);
    for (const slug of trustSlugs) {
      const data = await loadTrustPage(db, slug);
      assert.equal(data.status, slug === '404' ? 404 : 200); assert.ok(data.html.length > 50);
    }
    assert.equal((await loadTrustPage(db, 'private-page')).status, 404);
    await local.db.batch([{ sql: "UPDATE pages SET body_md='Manual **edit**' WHERE slug='about'" }]);
    assert.match((await loadTrustPage(db, 'about')).html, /Manual <strong>edit<\/strong>/);
    assert.match((await loadTrustPage(db, 'contact')).html, /not available yet/);
    const unavailable = { prepare() { throw new Error('private failure'); } } as unknown as D1Database;
    assert.equal((await loadTrustPage(unavailable, 'privacy')).status, 503);
    assert.equal((await loadTrustPage(unavailable, '404')).status, 404);
  } finally { await local.dispose(); await rm(state, { recursive: true, force: true }); }
});
