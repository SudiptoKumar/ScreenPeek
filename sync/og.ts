import sharp from 'sharp';
import { createHash } from 'node:crypto';
import { immutableCache } from './posters.ts';
import type { ImageStore } from './posters.ts';
import type { TmdbClient } from './tmdb.ts';
const xml = (value: string) => value.replace(/[&<>"']/g, char => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&apos;' })[char]!);
export async function composeOg(source: Pick<TmdbClient, 'image'>, store: ImageStore, input: { id: number; type: 'movie' | 'tv'; title: string; year: number | null; posterPath: string | null; siteName: string; posterKey?: string }) {
  const fingerprint = createHash('sha256').update(JSON.stringify({...input,posterPath:input.posterKey?null:input.posterPath})).digest('hex').slice(0, 20);
  const key = `og/${input.type}_${input.id}_${fingerprint}.webp`;
  if (await store.head(key)) return key;
  let owned = input.posterKey && store.get ? await store.get(input.posterKey.replace(/_w185\.webp$/, '_w500.webp')) : null;
  if(!owned&&input.posterKey&&store.get)owned=await store.get(input.posterKey);
  if(!owned&&!input.posterPath)throw new Error('Owned sharing-card poster is unavailable.');
  const poster = await sharp(owned || await source.image(input.posterPath!, 'w500'), { limitInputPixels: 40_000_000 }).rotate().resize(300, 450, { fit: 'cover' }).webp().toBuffer();
  const words = input.title.slice(0, 110).split(/\s+/); const lines: string[] = [''];
  for (const word of words) { const last = lines.length - 1; if ((lines[last] + ' ' + word).trim().length > 27 && lines[last]) lines.push(word); else lines[last] = (lines[last] + ' ' + word).trim(); }
  const svg = Buffer.from(`<svg width="1200" height="630" xmlns="http://www.w3.org/2000/svg"><rect width="1200" height="630" fill="#0B0B10"/><rect x="400" y="90" width="60" height="6" fill="#FF5A5F"/><g fill="#F4F4F6" font-family="sans-serif"><text x="400" y="145" font-size="26">${xml(input.siteName.slice(0, 40))}</text>${lines.slice(0, 3).map((line, index) => `<text x="400" y="${245 + index * 62}" font-size="46">${xml(line.slice(0, 28))}</text>`).join('')}<text x="400" y="470" font-size="28" fill="#B0B0BC">${input.year || 'Year TBA'} · ${input.type === 'tv' ? 'TV series' : 'Movie'}</text><text x="400" y="525" font-size="23" fill="#B0B0BC">Cast, trailers &amp; legal watch options</text></g></svg>`);
  const bytes = await sharp(svg).composite([{ input: poster, left: 55, top: 90 }]).webp({ quality: 78 }).toBuffer();
  await store.put(key, bytes, 'image/webp', immutableCache); return key;
}
