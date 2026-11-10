import type { TitleCard } from './catalogue.ts';
import { sampleMode } from './catalogue.ts';

export interface TitleDetail extends TitleCard {
  overview: string | null; original_title: string | null; runtime_min: number | null;
  status: string | null; original_language: string | null; vote_count: number | null;
  backdrop_r2: string | null; gallery_r2: string; genres: string; similar_ids: string;
  studio: string | null; budget: number | null; revenue: number | null; trailer_key: string | null;
  quality_gate: number; deleted: number; deleted_at: string | null; hidden: number;
  og_r2?: string | null;
}
export interface CastMember {
  id: number; slug: string; name: string; profile_r2: string | null;
  role: 'cast' | 'director' | 'creator'; character: string | null; ord: number;
}
export interface WatchProvider {
  country: string; provider_id: number; provider_name: string; logo_r2: string | null;
  offer_type: 'stream' | 'rent' | 'buy' | 'free' | 'ads';
}
export interface SeasonInfo { season_number: number; name: string; episode_count: number; air_date: string | null; }
export interface ExternalRatings { imdb: number | null; rt: number | null; metacritic: number | null; fetched_at: string; }
export const parseJsonArray = <T = unknown>(value: string | null | undefined): T[] => {
  try { const data: unknown = JSON.parse(value || '[]'); return Array.isArray(data) ? data as T[] : []; } catch { return []; }
};
export const launchCountry = (value: string | undefined | null) => ['US', 'GB', 'CA', 'AU'].includes(value || '') ? value! : 'US';

export async function loadTitlePage(db: D1Database, slug: string, type: 'movie' | 'tv', country = 'US') {
  let sample = false, failed = false;
  let title: TitleDetail | null = null;
  let cast: CastMember[] = [], providers: WatchProvider[] = [], seasons: SeasonInfo[] = [], similar: TitleCard[] = [];
  let genres: Array<{ slug: string; name: string }> = [];
  let votes: Array<{ choice: 'must' | 'good' | 'average' | 'skip'; count: number }> = [];
  let external: ExternalRatings | null = null;
  try {
    sample = await sampleMode(db);
    title = await db.prepare('SELECT * FROM titles WHERE slug=? AND type=?').bind(slug, type).first<TitleDetail>();
    if (title && !title.deleted && !title.deleted_at && !title.hidden) {
      [cast, providers, seasons, votes] = await Promise.all([
        db.prepare(`SELECT p.id,p.slug,p.name,p.profile_r2,c.role,c.character,c.ord
          FROM credits c JOIN people p ON p.id=c.person_id
          WHERE c.title_id=? AND c.title_type=? AND p.deleted_at IS NULL ORDER BY c.ord,p.name`).bind(title.id, type).all<CastMember>().then(result => result.results),
        db.prepare('SELECT country,provider_id,provider_name,logo_r2,offer_type FROM providers WHERE title_id=? AND title_type=? AND country=? ORDER BY provider_name').bind(title.id, type, launchCountry(country)).all<WatchProvider>().then(result => result.results),
        type === 'tv' ? db.prepare('SELECT season_number,name,episode_count,air_date FROM seasons WHERE title_id=? ORDER BY season_number').bind(title.id).all<SeasonInfo>().then(result => result.results) : Promise.resolve([]),
        db.prepare('SELECT choice,count FROM votes WHERE title_id=? AND title_type=? ORDER BY choice').bind(title.id, type).all<typeof votes[number]>().then(result => result.results),
      ]);
      const slugs = parseJsonArray<string>(title.genres).filter(value => typeof value === 'string').slice(0, 20);
      if (slugs.length) genres = (await db.prepare(`SELECT slug,name FROM genres WHERE slug IN (${slugs.map(() => '?').join(',')}) ORDER BY name`).bind(...slugs).all<{ slug: string; name: string }>()).results;
      const ids = parseJsonArray<number>(title.similar_ids).filter(id => Number.isSafeInteger(id) && id !== title!.id).slice(0, 12);
      if (ids.length) similar = (await db.prepare(`SELECT id,type,slug,title,year,poster_r2,poster_color,vote_average,views,updated_at,release_date FROM titles
        WHERE type=? AND id IN (${ids.map(() => '?').join(',')}) AND hidden=0 AND deleted=0 AND deleted_at IS NULL ${sample ? '' : 'AND quality_gate=1'} ORDER BY popularity DESC LIMIT 12`).bind(type, ...ids).all<TitleCard>()).results;
      const flag = await db.prepare("SELECT value FROM config WHERE key='ratings_external'").first<{ value: string }>();
      if (flag?.value === '1') external = await db.prepare('SELECT imdb,rt,metacritic,fetched_at FROM ratings_ext WHERE title_id=? AND title_type=?').bind(title.id, type).first<ExternalRatings>();
    }
  } catch { failed = true; }
  const status = failed ? 503 : !title ? 404 : title.deleted ? 410 : title.hidden || title.deleted_at ? 404 : 200;
  return {
    title, cast, providers, seasons, votes, genres, similar, external, sample, failed, status,
    noindex: sample || status !== 200 || !title?.quality_gate,
    country: launchCountry(country),
    cacheControl: sample || status !== 200 ? 'no-store' : 'public, s-maxage=86400, stale-while-revalidate=604800',
  };
}
export type TitlePageData = Awaited<ReturnType<typeof loadTitlePage>>;
