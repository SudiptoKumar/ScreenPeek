import { listTitles, parseListFilters, sampleMode } from './catalogue.ts';
import type { CataloguePage, ListFilters } from './catalogue.ts';
export type HubKind = 'genre' | 'collection' | 'language' | 'new' | 'top10' | 'upcoming';
const lookupTables = { genre: 'genres', collection: 'collections', language: 'languages' } as const;
const labels = { new: 'New arrivals', top10: 'Top 10 this week', upcoming: 'Upcoming releases' };

export async function loadHubPage(db: D1Database, kind: HubKind, url: URL, slug?: string) {
  let sample = false, failed = false, found = true;
  let name = '', intro = '';
  let catalogue: CataloguePage = { titles: [], total: 0, page: parseListFilters(url).page || 1, pages: 1 };
  try {
    sample = await sampleMode(db);
    const filters: ListFilters = { page: catalogue.page, includeUngated: sample };
    if (kind === 'genre' || kind === 'collection' || kind === 'language') {
      const row = await db.prepare(`SELECT name FROM ${lookupTables[kind]} WHERE slug=? ${kind === 'collection' ? "AND deleted_at IS NULL AND (starts_at IS NULL OR datetime(starts_at)<=datetime('now')) AND (ends_at IS NULL OR datetime(ends_at)>datetime('now'))" : ''}`).bind(slug || '').first<{ name: string }>();
      const override = await db.prepare('SELECT display_name,intro,hidden FROM taxonomy_overrides WHERE kind=? AND slug=? AND deleted_at IS NULL').bind(kind, slug || '').first<{ display_name: string | null; intro: string | null; hidden: number }>();
      found = Boolean(row) && !override?.hidden;
      name = override?.display_name || row?.name || '';
      if (kind === 'language' && !override?.display_name && name === slug) {
        try { name = new Intl.DisplayNames(['en'], { type: 'language' }).of(slug!) || name; } catch { /* Keep the stored label. */ }
      }
      intro = override?.intro || '';
      if (kind === 'genre') filters.genre = slug;
      if (kind === 'collection') filters.collection = slug;
      if (kind === 'language') filters.language = slug;
    } else {
      name = labels[kind]; filters.mode = kind;
    }
    if (found) catalogue = await listTitles(db, filters);
  } catch { failed = true; }
  const status = failed ? 503 : !found || catalogue.page > catalogue.pages ? 404 : 200;
  const title = status !== 200 ? status === 503 ? 'Catalogue unavailable' : 'Page not found'
    : kind === 'genre' ? `${name} Movies & Shows — Best ${name} Titles to Watch`
    : kind === 'collection' ? `${name} Collection — Movies & Shows`
    : kind === 'language' ? `${name} Movies & Shows` : name;
  return { kind, slug, name, intro, title: `${title}${catalogue.page > 1 && status === 200 ? ` — Page ${catalogue.page}` : ''}`,
    catalogue, sample, failed, status,
    noindex: sample || status !== 200 || catalogue.total === 0,
    cacheControl: ['genre','year','rating','sort'].some(key => url.searchParams.has(key)) ? 'private, no-store' : sample || status !== 200 ? 'no-store' : 'public, s-maxage=3600, stale-while-revalidate=604800' };
}
export type HubPageData = Awaited<ReturnType<typeof loadHubPage>>;
