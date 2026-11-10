import test from 'node:test';
import assert from 'node:assert/strict';
import sharp from 'sharp';
import { composeOg } from '../sync/og.ts';
test('sharing cards are 1200x630 owned WebP, immutable and idempotent with escaped title text', async () => {
  const objects = new Map<string, Uint8Array>(); let downloads = 0;
  const source = { async image() { downloads++; return new Uint8Array(await sharp({ create: { width: 500, height: 750, channels: 3, background: '#354060' } }).png().toBuffer()); } };
  const store = { async head(key: string) { return objects.has(key); }, async put(key: string, bytes: Uint8Array, type: string, cache: string) { assert.equal(type, 'image/webp'); assert.match(cache, /max-age=31536000, immutable/); objects.set(key, bytes); } };
  const input = { id: 1, type: 'movie' as const, title: '<script>& "Title"', year: 2026, posterPath: '/source.jpg', siteName: 'ScreenPeek' };
  const key = await composeOg(source, store, input); const metadata = await sharp(objects.get(key)!).metadata();
  assert.equal(metadata.width, 1200); assert.equal(metadata.height, 630); assert.equal(metadata.format, 'webp');
  assert.equal(await composeOg(source, store, input), key); assert.equal(downloads, 1);
  assert.notEqual(await composeOg(source, store, { ...input, title: 'Changed' }), key);
});
