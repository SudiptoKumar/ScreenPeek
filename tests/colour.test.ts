import test from 'node:test';
import assert from 'node:assert/strict';
import sharp from 'sharp';
import { posterColour } from '../sync/colour.ts';
test('dominant colour reads owned poster bytes and returns a safe hex tint without a source request', async () => {
  const bytes = new Uint8Array(await sharp({ create: { width: 185, height: 278, channels: 3, background: '#ff0000' } }).png().toBuffer());
  const store = { async get() { return bytes; }, async head() { return true; }, async put() {} };
  const colour = await posterColour({ async image() { throw new Error('Source must not be called'); } }, store, 'poster/test.webp', '/source.jpg');
  assert.match(colour!, /^#[a-f0-9]{6}$/);
  const red = parseInt(colour!.slice(1,3),16), green = parseInt(colour!.slice(3,5),16); assert.ok(red > 240 && green < 20);
});
