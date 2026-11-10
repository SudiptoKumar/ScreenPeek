import { parseListFilters, sampleMode, listTitles, listFilterOptions } from './catalogue';
import type { CataloguePage } from './catalogue';

/** Resolve response metadata before Astro starts rendering nested components. */
export async function loadCataloguePage(db: D1Database, url: URL, type: 'movie' | 'tv') {
  const label = type === 'movie' ? 'Movies' : 'Series';
  const filters = parseListFilters(url, type);
  let sample = false, failed = false;
  let catalogue: CataloguePage = { titles: [], total: 0, page: filters.page || 1, pages: 1 };
  let options: Awaited<ReturnType<typeof listFilterOptions>> = { genres: [], years: [] };
  try {
    sample = await sampleMode(db);
    [catalogue, options] = await Promise.all([
      listTitles(db, { ...filters, includeUngated: sample }), listFilterOptions(db),
    ]);
  } catch { failed = true; }
  const missing = !failed && catalogue.page > catalogue.pages;
  const filtered = ['genre', 'year', 'rating', 'sort'].some(key => url.searchParams.has(key));
  const status: 200 | 404 | 503 = failed ? 503 : missing ? 404 : 200;
  const cacheControl = sample || failed || missing || filtered ? filtered ? 'private, no-store' : 'no-store' : 'public, s-maxage=3600, stale-while-revalidate=604800';
  const pageTitle = failed ? 'Catalogue unavailable' : missing ? 'Page not found' : `${label}${catalogue.page > 1 ? ` — Page ${catalogue.page}` : ''}`;
  return { type, label, filters, catalogue, options, sample, failed, missing, filtered, status, cacheControl, pageTitle };
}

export type CataloguePageData = Awaited<ReturnType<typeof loadCataloguePage>>;
