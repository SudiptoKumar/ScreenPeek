import { sampleMode } from './catalogue.ts';
import type { SeasonInfo } from './detail.ts';

export interface SeriesSummary {
  id: number; slug: string; title: string; year: number | null; poster_r2: string | null;
  quality_gate: number; hidden: number; deleted: number; deleted_at: string | null;
}
export interface EpisodeInfo {
  episode_number: number; name: string | null; overview: string | null;
  air_date: string | null; still_r2: string | null;
}
type EpisodeNeighbour = Pick<EpisodeInfo, 'episode_number' | 'name'>;
const number = (input: string, zero = false) => (zero ? /^(0|[1-9]\d*)$/ : /^[1-9]\d*$/).test(input) && Number.isSafeInteger(Number(input)) ? Number(input) : null;
export const seasonPath = (slug: string, season: number) => `/tv/${encodeURIComponent(slug)}/season/${season}/`;
export const episodePath = (slug: string, season: number, episode: number) => `${seasonPath(slug, season)}episode/${episode}/`;

export async function loadSeasonPage(db: D1Database, slug: string, seasonInput: string, pageInput = '1') {
  const seasonNumber = number(seasonInput, true);
  const page = number(pageInput) || 1;
  let title: SeriesSummary | null = null, season: SeasonInfo | null = null;
  let episodes: EpisodeInfo[] = [];
  let sample = false, failed = false, total = 0;
  try {
    sample = await sampleMode(db);
    title = await db.prepare("SELECT id,slug,title,year,poster_r2,quality_gate,hidden,deleted,deleted_at FROM titles WHERE slug=? AND type='tv'").bind(slug).first<SeriesSummary>();
    if (title && !title.hidden && !title.deleted && !title.deleted_at && seasonNumber !== null) {
      season = await db.prepare('SELECT season_number,name,episode_count,air_date FROM seasons WHERE title_id=? AND season_number=?').bind(title.id, seasonNumber).first<SeasonInfo>();
      if (season) {
        total = (await db.prepare('SELECT COUNT(*) AS total FROM episodes WHERE title_id=? AND season_number=?').bind(title.id, seasonNumber).first<{ total: number }>())?.total || 0;
        if (page <= Math.max(1, Math.ceil(total / 24))) episodes = (await db.prepare('SELECT episode_number,name,overview,air_date,still_r2 FROM episodes WHERE title_id=? AND season_number=? ORDER BY episode_number LIMIT 24 OFFSET ?').bind(title.id, seasonNumber, (page - 1) * 24).all<EpisodeInfo>()).results;
      }
    }
  } catch { failed = true; }
  const pages = Math.max(1, Math.ceil(total / 24));
  const status = failed ? 503 : title?.deleted ? 410 : !title || title.hidden || title.deleted_at || !season || page > pages ? 404 : 200;
  return { title, season, episodes, sample, failed, total, page, pages, status,
    noindex: sample || status !== 200 || !title?.quality_gate,
    cacheControl: sample || status !== 200 ? 'no-store' : 'public, s-maxage=86400, stale-while-revalidate=604800' };
}
export type SeasonPageData = Awaited<ReturnType<typeof loadSeasonPage>>;

export async function loadEpisodePage(db: D1Database, slug: string, seasonInput: string, episodeInput: string) {
  const parent = await loadSeasonPage(db, slug, seasonInput);
  const episodeNumber = number(episodeInput);
  let episode: EpisodeInfo | null = null;
  let previous: EpisodeNeighbour | null = null, next: EpisodeNeighbour | null = null;
  let failed = false;
  if (parent.status === 200 && parent.title && parent.season && episodeNumber !== null) {
    try {
      const params = [parent.title.id, parent.season.season_number, episodeNumber];
      episode = await db.prepare('SELECT episode_number,name,overview,air_date,still_r2 FROM episodes WHERE title_id=? AND season_number=? AND episode_number=?').bind(...params).first<EpisodeInfo>();
      if (episode) [previous, next] = await Promise.all([
        db.prepare('SELECT episode_number,name FROM episodes WHERE title_id=? AND season_number=? AND episode_number<? ORDER BY episode_number DESC LIMIT 1').bind(...params).first<EpisodeNeighbour>(),
        db.prepare('SELECT episode_number,name FROM episodes WHERE title_id=? AND season_number=? AND episode_number>? ORDER BY episode_number LIMIT 1').bind(...params).first<EpisodeNeighbour>(),
      ]);
    } catch { failed = true; }
  }
  const status = failed ? 503 : parent.status !== 200 ? parent.status : episode ? 200 : 404;
  return { ...parent, episode, previous, next, status, failed: parent.failed || failed,
    noindex: parent.noindex || status !== 200,
    cacheControl: status === 200 ? parent.cacheControl : 'no-store' };
}
export type EpisodePageData = Awaited<ReturnType<typeof loadEpisodePage>>;
