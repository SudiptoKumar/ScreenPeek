import { manualTitles } from './home-config.ts';
export interface TitleCard {
  id: number; type: 'movie' | 'tv'; slug: string; title: string; year: number | null;
  poster_r2: string | null; poster_color: string | null; vote_average: number | null;
  views: number; updated_at: string; release_date: string | null;
}
export interface ListFilters {
  type?: 'movie' | 'tv'; page?: number; genre?: string; year?: number;
  minRating?: number; sort?: 'popular' | 'newest' | 'rating' | 'release';
  includeUngated?: boolean;
  collection?: string; language?: string; mode?: 'new' | 'top10' | 'upcoming';
}
export interface CataloguePage { titles: TitleCard[]; total: number; page: number; pages: number; }
const fields = 't.id,t.type,t.slug,t.title,t.year,t.poster_r2,t.poster_color,t.vote_average,t.views,t.updated_at,t.release_date';
const visible = 't.hidden=0 AND t.deleted=0 AND t.deleted_at IS NULL';
const validSorts = ['popular', 'newest', 'rating', 'release'] as const;

export function parseListFilters(url: URL, type?: 'movie' | 'tv'): ListFilters {
  const requested = Number(url.searchParams.get('page') || /\/page\/([1-9]\d*)\/$/.exec(url.pathname)?.[1] || 1);
  const year = Number(url.searchParams.get('year'));
  const rating = Number(url.searchParams.get('rating'));
  const genre = url.searchParams.get('genre') || '';
  const sort = url.searchParams.get('sort');
  return {
    type, page: Number.isSafeInteger(requested) && requested > 0 ? requested : 1,
    year: Number.isInteger(year) && year >= 1888 && year <= 2200 ? year : undefined,
    minRating: Boolean(url.searchParams.get('rating')?.trim()) && Number.isFinite(rating) && rating >= 0 && rating <= 10 ? rating : undefined,
    genre: /^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(genre) ? genre : undefined,
    sort: validSorts.includes(sort as typeof validSorts[number]) ? sort as ListFilters['sort'] : 'popular',
  };
}

export async function sampleMode(db: D1Database) {
  const row = await db.prepare("SELECT COUNT(*) AS count FROM config WHERE key IN ('dev:sample_data','dev:fixture_import') AND value NOT IN ('','0')").first<{ count: number }>();
  return Boolean(row?.count);
}

export async function listTitles(db: D1Database, filters: ListFilters = {}): Promise<CataloguePage> {
  if (filters.mode === 'top10') {
    const section=await db.prepare("SELECT key,label,ord,source,pins FROM homepage_sections WHERE key='top10' AND deleted_at IS NULL AND (starts_at IS NULL OR datetime(starts_at)<=datetime('now')) AND (ends_at IS NULL OR datetime(ends_at)>datetime('now'))").first<import('./home-config.ts').HomeSection>();
    if(section?.source==='manual'){const titles=await manualTitles(db,section,!!filters.includeUngated);const page=filters.page||1;return {titles:page===1?titles:[],total:titles.length,page,pages:1};}
  }
  const clauses = [visible];
  const values: Array<string | number> = [];
  if (!filters.includeUngated) clauses.push('t.quality_gate=1');
  if (filters.type) { clauses.push('t.type=?'); values.push(filters.type); }
  if (filters.genre) {
    clauses.push('EXISTS(SELECT 1 FROM title_genres g WHERE g.title_id=t.id AND g.title_type=t.type AND g.genre_slug=?)');
    values.push(filters.genre);
  }
  if (filters.collection) {
    clauses.push('EXISTS(SELECT 1 FROM collection_titles c WHERE c.title_id=t.id AND c.title_type=t.type AND c.collection_slug=?)');
    values.push(filters.collection);
  }
  if (filters.language) { clauses.push('t.original_language=?'); values.push(filters.language); }
  if (filters.mode === 'upcoming') clauses.push("t.release_date>date('now')");
  if (filters.year !== undefined) { clauses.push('t.year=?'); values.push(filters.year); }
  if (filters.minRating !== undefined) { clauses.push('t.vote_average>=?'); values.push(filters.minRating); }
  const orders = { popular: 't.popularity DESC', newest: 't.added_at DESC', rating: 't.vote_average DESC,t.vote_count DESC', release: 't.release_date DESC' };
  const order = filters.mode === 'new' ? orders.newest : filters.mode === 'upcoming' ? 't.release_date ASC' : filters.mode === 'top10' ? orders.popular : orders[filters.sort || 'popular'] || orders.popular;
  const where = clauses.join(' AND ');
  const count = await db.prepare(`SELECT COUNT(*) AS total FROM titles t WHERE ${where}`).bind(...values).first<{ total: number }>();
  const total = filters.mode === 'top10' ? Math.min(10, count?.total || 0) : count?.total || 0;
  const pages = Math.max(1, Math.ceil(total / 24));
  const page = Number.isSafeInteger(filters.page) && (filters.page || 0) > 0 ? filters.page! : 1;
  if (page > pages) return { titles: [], total, page, pages };
  const result = await db.prepare(`SELECT ${fields} FROM titles t WHERE ${where} ORDER BY ${order},t.id DESC,t.type LIMIT ? OFFSET ?`).bind(...values, filters.mode === 'top10' ? 10 : 24, (page - 1) * 24).all<TitleCard>();
  return { titles: result.results, total, page, pages };
}

export async function listFilterOptions(db: D1Database) {
  const [genres, years] = await Promise.all([
    db.prepare(`SELECT g.slug,COALESCE(NULLIF(o.display_name,''),g.name) name FROM genres g LEFT JOIN taxonomy_overrides o ON o.kind='genre' AND o.slug=g.slug AND o.deleted_at IS NULL WHERE g.title_count>0 AND COALESCE(o.hidden,0)=0 ORDER BY COALESCE(o.ord,0),name`).all<{ slug: string; name: string }>(),
    db.prepare('SELECT DISTINCT year FROM titles t WHERE year IS NOT NULL AND ' + visible + ' ORDER BY year DESC').all<{ year: number }>(),
  ]);
  return { genres: genres.results, years: years.results.map(row => row.year) };
}

export async function homeTitles(db: D1Database, includeUngated = false) {
  const where = visible + (includeUngated ? '' : ' AND t.quality_gate=1');
  const query = async (condition: string, order: string, limit: number) =>
    (await db.prepare(`SELECT ${fields} FROM titles t WHERE ${where} ${condition} ORDER BY ${order},t.id DESC LIMIT ?`).bind(limit).all<TitleCard>()).results;
  const [trending, top10, movies, series, upcoming, genres] = await Promise.all([
    query('', "CASE WHEN t.pinned=1 AND (t.pin_starts_at IS NULL OR datetime(t.pin_starts_at)<=datetime('now')) AND (t.pin_ends_at IS NULL OR datetime(t.pin_ends_at)>datetime('now')) THEN 1 ELSE 0 END DESC,t.popularity DESC", 6), query('', 't.popularity DESC', 10),
    query("AND t.type='movie'", 't.added_at DESC', 6), query("AND t.type='tv'", 't.added_at DESC', 6),
    query("AND t.release_date>date('now')", 't.release_date ASC', 6),
    db.prepare(`SELECT g.slug,COALESCE(NULLIF(o.display_name,''),g.name) name,g.title_count FROM genres g LEFT JOIN taxonomy_overrides o ON o.kind='genre' AND o.slug=g.slug AND o.deleted_at IS NULL WHERE g.title_count>0 AND COALESCE(o.hidden,0)=0 ORDER BY COALESCE(o.ord,0),g.title_count DESC,name LIMIT 12`).all<{ slug: string; name: string; title_count: number }>(),
  ]);
  // 6+6+6+6 poster cards maximum; Top10 is a text-only ranked list.
  return { trending, top10, movies, series, upcoming, genres: genres.results };
}

export function titleUrl(title: Pick<TitleCard, 'type' | 'slug'>) {
  return `/${title.type === 'movie' ? 'movie' : 'tv'}/${encodeURIComponent(title.slug)}/`;
}
