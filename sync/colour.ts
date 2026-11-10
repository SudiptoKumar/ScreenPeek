import sharp from 'sharp';
import type { ImageStore } from './posters.ts';
import type { TmdbClient } from './tmdb.ts';
export async function posterColour(source: Pick<TmdbClient, 'image'>, store: ImageStore, key: string, sourcePath: string | null) {
  const owned = store.get ? await store.get(key) : null;
  const bytes = owned || (sourcePath ? await source.image(sourcePath, 'w185') : null);
  if (!bytes) return null;
  const stats = await sharp(bytes, { limitInputPixels: 40_000_000 }).rotate().removeAlpha().stats();
  return '#' + [stats.dominant.r, stats.dominant.g, stats.dominant.b].map(value => Math.max(0, Math.min(255, value)).toString(16).padStart(2, '0')).join('');
}
