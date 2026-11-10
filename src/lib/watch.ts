import { loadTitlePage } from './detail.ts';
import type { WatchProvider } from './detail.ts';
import { linkActive, providerLinkSlug, readLink } from './links.ts';
import { requestCountry } from './geo.ts';

export interface ProviderRow extends WatchProvider { href: string | null; }
export async function loadWatchPage(db: D1Database, kv: KVNamespace, slug: string, request: Request) {
  const country = requestCountry(request);
  let type: 'movie' | 'tv' = 'movie', failed = false;
  try {
    const row = await db.prepare('SELECT type FROM titles WHERE slug=?').bind(slug).first<{ type: 'movie' | 'tv' }>();
    if (row) type = row.type;
  } catch { failed = true; }
  const data = await loadTitlePage(db, slug, type, country);
  let providers: ProviderRow[] = [], availableCountries: string[] = [];
  if (data.status === 200 && data.title) {
    try {
      availableCountries = (await db.prepare('SELECT DISTINCT country FROM providers WHERE title_id=? AND title_type=? ORDER BY country').bind(data.title.id, type).all<{ country: string }>()).results.map(row => row.country).filter(value => ['US', 'GB', 'CA', 'AU'].includes(value));
      const cache = new Map<number, string | null>();
      for (const provider of data.providers) {
        if (!cache.has(provider.provider_id)) {
          const key = providerLinkSlug(provider.provider_id);
          const link = await readLink(kv, db, key);
          cache.set(provider.provider_id, link && linkActive(link) ? `/go/${key}/` : null);
        }
        providers.push({ ...provider, href: cache.get(provider.provider_id) || null });
      }
    } catch { failed = true; }
  }
  const status = failed ? 503 : data.status;
  return { ...data, providers, availableCountries, country, status, failed: failed || data.failed,
    noindex: data.noindex || status !== 200,
    // Country is visitor-selected; do not share a cached response across cookies.
    cacheControl: 'private, no-store' };
}
export type WatchPageData = Awaited<ReturnType<typeof loadWatchPage>>;
