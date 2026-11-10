import { loadTitlePage } from './detail.ts';
export const validTrailerKey = (key: unknown): key is string => typeof key === 'string' && /^[A-Za-z0-9_-]{11}$/.test(key);

export async function loadTrailerPage(db: D1Database, slug: string) {
  let type: 'movie' | 'tv' = 'movie', failed = false;
  try {
    const row = await db.prepare('SELECT type FROM titles WHERE slug=?').bind(slug).first<{ type: 'movie' | 'tv' }>();
    if (row) type = row.type;
  } catch { failed = true; }
  const data = await loadTitlePage(db, slug, type);
  const storedKey = data.title?.trailer_key;
  const key = validTrailerKey(storedKey) ? storedKey : null;
  const status = failed ? 503 : data.status;
  return { ...data, key, failed: failed || data.failed, status, noindex: data.noindex || !key || failed,
    cacheControl: status === 200 ? data.cacheControl : 'no-store' };
}
export type TrailerPageData = Awaited<ReturnType<typeof loadTrailerPage>>;
