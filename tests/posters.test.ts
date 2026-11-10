import test from 'node:test';
import assert from 'node:assert/strict';
import sharp from 'sharp';
import { immutableCache, processImage } from '../sync/posters.ts';
import type { ImageStore } from '../sync/posters.ts';

function memoryStore() {
  const objects = new Map<string, { bytes: Uint8Array; contentType: string; cacheControl: string }>();
  let writes = 0;
  const store: ImageStore = {
    async head(key) { return objects.has(key); },
    async put(key, bytes, contentType, cacheControl) { writes++; objects.set(key, { bytes, contentType, cacheControl }); },
  };
  return { store, objects, writes: () => writes };
}
const generatedImage = () => sharp({ create: { width: 500, height: 750, channels: 3, background: '#294253' } }).png().toBuffer();

test('poster copies produce both owned WebP sizes with immutable metadata; unchanged reruns never download or upload', async () => {
  const storage = memoryStore();
  let downloads = 0;
  const source = { async image() { downloads++; return new Uint8Array(await generatedImage()); } };
  const options = { kind: 'poster' as const, id: 42, mediaType: 'movie' as const, path: '/original-poster.jpg' };
  const first = await processImage(source, storage.store, options);
  assert.equal(first.warning, null);
  for (const width of [185, 500]) {
    const object = storage.objects.get(first.keys[String(width)])!;
    const metadata = await sharp(object.bytes).metadata();
    assert.equal(metadata.width, width);
    assert.equal(metadata.format, 'webp');
    assert.equal(object.contentType, 'image/webp');
    assert.equal(object.cacheControl, immutableCache);
  }
  const repeated = await processImage(source, storage.store, options);
  assert.deepEqual(repeated, first);
  assert.equal(downloads, 1);
  assert.equal(storage.writes(), 2);
  const changed = await processImage(source, storage.store, { ...options, path: '/replacement-poster.jpg' });
  assert.notEqual(changed.keys['185'], first.keys['185']);
  assert.ok(storage.objects.has(first.keys['185']), 'old immutable objects remain usable');
  const tv = await processImage(source, storage.store, { ...options, mediaType: 'tv' });
  assert.notEqual(tv.keys['185'], first.keys['185'], 'overlapping movie and TV IDs cannot overwrite each other');
});

test('profiles use w185 and backdrops use w300, with only missing variants uploaded', async () => {
  const storage = memoryStore();
  const source = { async image() { return new Uint8Array(await generatedImage()); } };
  const profile = await processImage(source, storage.store, { kind: 'profile', id: 10, path: '/profile.jpg' });
  const backdrop = await processImage(source, storage.store, { kind: 'backdrop', id: 10, mediaType: 'movie', path: '/backdrop.jpg' });
  assert.deepEqual(Object.keys(profile.keys), ['185']);
  assert.deepEqual(Object.keys(backdrop.keys), ['300']);
  assert.equal((await sharp(storage.objects.get(profile.keys['185'])!.bytes).metadata()).width, 185);
  assert.equal((await sharp(storage.objects.get(backdrop.keys['300'])!.bytes).metadata()).width, 300);
  const options = { kind: 'poster' as const, id: 10, path: '/poster.jpg' };
  const poster = await processImage(source, storage.store, options);
  storage.objects.delete(poster.keys['500']);
  const before = storage.writes();
  await processImage(source, storage.store, options);
  assert.equal(storage.writes(), before + 1);
});

test('missing, corrupt or failed images return no hotlink and do not fail the catalogue run', async () => {
  const storage = memoryStore();
  const missing = await processImage({ async image() { throw new Error('must not request'); } }, storage.store, { kind: 'poster', id: 1, path: null });
  assert.deepEqual(missing.keys, {});
  assert.equal(missing.warning, null);
  const broken = await processImage({ async image() { return new Uint8Array([1, 2, 3]); } }, storage.store, { kind: 'poster', id: 1, path: '/bad.jpg' });
  assert.deepEqual(broken.keys, {});
  assert.match(broken.warning!, /placeholder/);
  const failed = await processImage({ async image() { throw new Error('failure with secret-like text'); } }, storage.store, { kind: 'poster', id: 1, path: '/failed.jpg' });
  assert.equal(failed.warning?.includes('secret-like'), false);
  assert.equal(storage.writes(), 0);
});
