import { createHash } from 'node:crypto';
import sharp from 'sharp';
import type { TmdbClient } from './tmdb.ts';

export interface ImageStore {
  get?(key: string): Promise<Uint8Array | null>;
  head(key: string): Promise<boolean>;
  put(key: string, bytes: Uint8Array, contentType: string, cacheControl: string): Promise<void>;
}
export const immutableCache = 'public, max-age=31536000, immutable';
export type ImageKind = 'poster' | 'profile' | 'backdrop' | 'logo' | 'still';

// Limit libvips CPU use independently of the five concurrent source requests.
sharp.concurrency(2);
sharp.cache({ memory: 32, files: 0, items: 50 });

/** Images are copy-once; a changed source path gets a new immutable object key. */
export async function processImage(
  source: Pick<TmdbClient, 'image'>,
  store: ImageStore,
  options: { kind: ImageKind; id: number; path: string | null | undefined; mediaType?: 'movie' | 'tv' },
) {
  if (!options.path) return { keys: {} as Record<string, string>, warning: null as string | null };
  if (typeof options.path !== 'string') return { keys: {} as Record<string, string>, warning: 'Invalid source image path; use the placeholder' };
  if (!Number.isSafeInteger(options.id) || options.id < 1) throw new Error('Image source ID must be positive');
  const sizes = options.kind === 'poster' ? [185, 500] : options.kind === 'backdrop' ? [300] : [185];
  const hash = createHash('sha256').update(options.path).digest('hex').slice(0, 12);
  // Source movie and TV IDs overlap. Include the media type for title imagery.
  const identity = options.mediaType ? `${options.mediaType}_${options.id}` : String(options.id);
  const entries = sizes.map(width => [String(width), `${options.kind}/${identity}_${hash}_w${width}.webp`] as const);
  try {
    const present = await Promise.all(entries.map(([, key]) => store.head(key)));
    if (present.every(Boolean)) return { keys: Object.fromEntries(entries), warning: null };
    const sourceSize = options.kind === 'poster' ? 'w500' : options.kind === 'backdrop' ? 'w300' : 'w185';
    const bytes = await source.image(options.path, sourceSize);
    const image = sharp(bytes, { limitInputPixels: 40_000_000, failOn: 'error' }).rotate();
    for (const [index, [width, key]] of entries.entries()) {
      if (present[index]) continue;
      const output = await image.clone().resize({ width: Number(width), withoutEnlargement: true }).webp({ quality: 68, effort: 4 }).toBuffer();
      await store.put(key, output, 'image/webp', immutableCache);
    }
    return { keys: Object.fromEntries(entries), warning: null };
  } catch {
    // Never hotlink as a fallback, and never fail an entire sync for one image.
    return { keys: {} as Record<string, string>, warning: `Could not copy ${options.kind} image for ${identity}; use the placeholder` };
  }
}
