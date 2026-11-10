import { listFilterOptions, parseListFilters, sampleMode } from './catalogue.ts';
import type { CataloguePage, ListFilters, TitleCard } from './catalogue.ts';

export function searchText(value: string) {
  if (value.length > 100) throw new Error('Search query must be at most 100 characters');
  return value.trim().replace(/\s+/g, ' ');
}
export function matchQuery(value: string) {
  const terms = searchText(value).match(/[\p{L}\p{N}]+/gu)?.slice(0, 8) || [];
  return terms.map(term => `"${term}"*`).join(' AND ');
}

export async function searchTitles(db: D1Database, query: string, options: {
  filters?: ListFilters; suggestions?: boolean; includeUngated?: boolean;
} = {}): Promise<CataloguePage> {
  const text = searchText(query);
  const match = text.length >= 2 ? matchQuery(text) : '';
  const filters = options.filters || {};
  const page = Number.isSafeInteger(filters.page) && (filters.page || 0) > 0 ? filters.page! : 1;
  if (!match) return { titles: [], total: 0, page, pages: 1 };
  const clauses = ['titles_fts MATCH ?', 't.hidden=0', 't.deleted=0', 't.deleted_at IS NULL'];
  const values: Array<string | number> = [match];
  if (!options.includeUngated) clauses.push('t.quality_gate=1');
  if (filters.type) { clauses.push('t.type=?'); values.push(filters.type); }
  if (filters.genre) { clauses.push('EXISTS(SELECT 1 FROM title_genres g WHERE g.title_id=t.id AND g.title_type=t.type AND g.genre_slug=?)'); values.push(filters.genre); }
  if (filters.year !== undefined) { clauses.push('t.year=?'); values.push(filters.year); }
  if (filters.minRating !== undefined) { clauses.push('t.vote_average>=?'); values.push(filters.minRating); }
  const from = `FROM titles_fts JOIN titles t ON t.slug=titles_fts.slug AND t.type=titles_fts.type WHERE ${clauses.join(' AND ')}`;
  const total = options.suggestions ? 0 : (await db.prepare(`SELECT COUNT(*) AS total ${from}`).bind(...values).first<{ total: number }>())?.total || 0;
  const pages = Math.max(1, Math.ceil(total / 24));
  if (!options.suggestions && page > pages) return { titles: [], total, page, pages };
  const orders = { popular: 't.popularity DESC', newest: 't.added_at DESC', rating: 't.vote_average DESC,t.vote_count DESC', release: 't.release_date DESC' };
  const order = filters.sort ? orders[filters.sort] : 'bm25(titles_fts),t.popularity DESC';
  const titles = (await db.prepare(`SELECT t.id,t.type,t.slug,t.title,t.year,t.poster_r2,t.poster_color,t.vote_average,t.views,t.updated_at,t.release_date ${from}
    ORDER BY ${order},t.id DESC,t.type LIMIT ? OFFSET ?`).bind(...values, options.suggestions ? 8 : 24, options.suggestions ? 0 : (page - 1) * 24).all<TitleCard>()).results;
  return { titles, total: options.suggestions ? titles.length : total, page: options.suggestions ? 1 : page, pages: options.suggestions ? 1 : pages };
}

export async function loadSearchPage(db: D1Database, url: URL) {
  let sample = false, failed = false, invalid = false, query = '';
  const type = url.searchParams.get('type');
  const filters = parseListFilters(url, type === 'movie' || type === 'tv' ? type : undefined);
  // Relevance is the default for search; catalogue's default popularity is not.
  if (!url.searchParams.get('sort')) filters.sort = undefined;
  let catalogue: CataloguePage = { titles: [], total: 0, page: filters.page || 1, pages: 1 };
  let options: Awaited<ReturnType<typeof listFilterOptions>> = { genres: [], years: [] };
  try { query = searchText(url.searchParams.get('q') || ''); } catch { invalid = true; }
  try {
    sample = await sampleMode(db);
    options = await listFilterOptions(db);
    if (!invalid) catalogue = await searchTitles(db, query, { filters, includeUngated: sample });
  } catch { failed = true; }
  const status = failed ? 503 : invalid ? 400 : catalogue.page > catalogue.pages ? 404 : 200;
  return { query, filters, options, catalogue, sample, failed, invalid, status, noindex: true, cacheControl: 'no-store' };
}
export type SearchPageData = Awaited<ReturnType<typeof loadSearchPage>>;
