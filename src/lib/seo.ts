import { titleOriginality } from './originality.ts';
import { listingBase, paginationLink } from './listing-path.ts';
import { mediaUrl } from './media.ts';
import type { TitlePageData } from './detail.ts';
import type { TitleCard } from './catalogue.ts';
import { titleUrl } from './catalogue.ts';
import type { PersonPageData } from './people.ts';
import type { EpisodePageData, SeasonPageData } from './seasons.ts';
import type { TrailerPageData } from './trailer.ts';

export type Schema = Record<string, unknown>;
export interface SeoEnvironment { SITE_URL?: string; DEPLOYMENT_ENV?: string; }
export function siteOrigin(value: string | undefined) {
  try { const url = new URL(value || ''); if (url.protocol === 'https:' && !url.username && !url.password && url.pathname === '/' && !url.search && !url.hash) return url.origin; } catch { /* Preview placeholder. */ }
  return 'https://example.workers.dev';
}
export const productionSeo = (env: SeoEnvironment) => env.DEPLOYMENT_ENV === 'production' && siteOrigin(env.SITE_URL) !== 'https://example.workers.dev';
export const filteredUrl = (url: URL) => ['genre', 'year', 'rating', 'sort'].some(key => url.searchParams.has(key));
export function canonicalUrl(url: URL, origin: string, page = 1) {
  const result = new URL(origin);
  const base = listingBase(url.pathname);
  result.pathname = base ? filteredUrl(url) ? base : paginationLink(new URL(base, origin), page) : url.pathname;
  if (!base && !filteredUrl(url) && Number.isSafeInteger(page) && page > 1) result.searchParams.set('page', String(page));
  return result.href;
}
const isoDate = (value: string | null | undefined) => value && /^\d{4}-\d{2}-\d{2}(?:T.*)?$/.test(value) && Number.isFinite(Date.parse(value)) ? value.slice(0, 10) : undefined;
export const schemaJson = (data: Schema[]) => JSON.stringify(data).replaceAll('<', '\\u003c').replaceAll('\u2028', '\\u2028').replaceAll('\u2029', '\\u2029');
export function breadcrumbs(items: Array<{ name: string; path: string }>, origin: string): Schema {
  return { '@context': 'https://schema.org', '@type': 'BreadcrumbList', itemListElement: items.map((item, index) => ({ '@type': 'ListItem', position: index + 1, name: item.name, item: new URL(origin + (item.path.startsWith('/') ? item.path : `/${item.path}`)).href })) };
}
export function titleSchema(data: TitlePageData, origin: string, mediaBase?: string): Schema[] {
  const title = data.title;
  if (data.status !== 200 || !title) return [];
  const image = mediaUrl(title.poster_r2, mediaBase, 500);
  const directors = data.cast.filter(person => person.role === 'director');
  const actors = data.cast.filter(person => person.role === 'cast').slice(0, 12);
  const person = (value: typeof actors[number]) => ({ '@type': 'Person', name: value.name, url: new URL(`/cast/${encodeURIComponent(value.slug)}/`, origin).href });
  return [{ '@context': 'https://schema.org', '@type': title.type === 'movie' ? 'Movie' : 'TVSeries',
    name: title.title, url: new URL(titleUrl(title), origin).href,
    ...(image ? { image } : {}), ...(isoDate(title.release_date) ? { datePublished: isoDate(title.release_date) } : {}),
    ...(title.overview?.trim() ? { description: title.overview.trim().slice(0, 500) } : {}),
    ...(data.genres.length ? { genre: data.genres.map(genre => genre.name) } : {}),
    ...(title.type === 'movie' && title.runtime_min && title.runtime_min > 0 ? { duration: `PT${title.runtime_min}M` } : {}),
    ...(actors.length ? { actor: actors.map(person) } : {}), ...(directors.length ? { director: directors.map(person) } : {}),
  }, { '@context': 'https://schema.org', '@type': 'FAQPage', mainEntity: titleOriginality(data).questions.map(item => ({ '@type': 'Question', name: item.question, acceptedAnswer: { '@type': 'Answer', text: item.answer } })) }, breadcrumbs([{ name: 'Home', path: '/' }, { name: title.type === 'movie' ? 'Movies' : 'Series', path: title.type === 'movie' ? '/movies/' : '/series/' }, { name: title.title, path: titleUrl(title) }], origin)];
}
export function personSchema(data: PersonPageData, origin: string, mediaBase?: string): Schema[] {
  if (data.status !== 200 || !data.person) return [];
  const person = data.person, path = `/cast/${encodeURIComponent(person.slug)}/`, image = mediaUrl(person.profile_r2, mediaBase, 185);
  return [{ '@context': 'https://schema.org', '@type': 'Person', name: person.name, url: new URL(path, origin).href,
    ...(person.bio?.trim() ? { description: person.bio.trim().slice(0, 500) } : {}), ...(image ? { image } : {}) }, breadcrumbs([{ name: 'Home', path: '/' }, { name: person.name, path }], origin)];
}
export function itemListSchema(titles: TitleCard[], origin: string, page = 1): Schema {
  return { '@context': 'https://schema.org', '@type': 'ItemList', itemListElement: titles.slice(0, 24).map((title, index) => ({ '@type': 'ListItem', position: (page - 1) * 24 + index + 1, name: title.title, url: new URL(titleUrl(title), origin).href })) };
}
export function episodeSchema(data: EpisodePageData, origin: string, mediaBase?: string): Schema[] {
  if (data.status !== 200 || !data.title || !data.season || !data.episode) return [];
  const { title, season, episode } = data, series = `/tv/${encodeURIComponent(title.slug)}/`, path = `${series}season/${season.season_number}/episode/${episode.episode_number}/`;
  const image = mediaUrl(episode.still_r2, mediaBase, 185);
  return [{ '@context': 'https://schema.org', '@type': 'TVEpisode', name: episode.name || `Episode ${episode.episode_number}`, episodeNumber: episode.episode_number,
    url: new URL(path, origin).href, partOfSeries: { '@type': 'TVSeries', name: title.title, url: new URL(series, origin).href },
    partOfSeason: { '@type': 'TVSeason', seasonNumber: season.season_number },
    ...(episode.overview ? { description: episode.overview.slice(0, 500) } : {}), ...(image ? { image } : {}),
    ...(isoDate(episode.air_date) ? { datePublished: isoDate(episode.air_date) } : {}),
  }, breadcrumbs([{ name: 'Home', path: '/' }, { name: title.title, path: series }, { name: season.name || `Season ${season.season_number}`, path: `${series}season/${season.season_number}/` }, { name: episode.name || `Episode ${episode.episode_number}`, path }], origin)];
}
export function trailerSchema(data: TrailerPageData, origin: string, mediaBase?: string): Schema[] {
  if (data.status !== 200 || !data.title || !data.key) return [];
  const title = data.title, thumbnail = mediaUrl(title.poster_r2, mediaBase, 185);
  return [{ '@context': 'https://schema.org', '@type': 'VideoObject', name: `${title.title} trailer`,
    url: new URL(`/trailer/${encodeURIComponent(title.slug)}/`, origin).href, embedUrl: `https://www.youtube-nocookie.com/embed/${encodeURIComponent(data.key)}`,
    ...(thumbnail ? { thumbnailUrl: thumbnail } : {}), ...(title.overview ? { description: title.overview.slice(0, 500) } : {}),
  }, breadcrumbs([{ name: 'Home', path: '/' }, { name: title.type === 'movie' ? 'Movies' : 'Series', path: title.type === 'movie' ? '/movies/' : '/series/' }, { name: title.title, path: titleUrl(title) }, { name: 'Trailer', path: `/trailer/${encodeURIComponent(title.slug)}/` }], origin)];
}
export function seasonSchema(data: SeasonPageData, origin: string): Schema[] {
  if (data.status !== 200 || !data.title || !data.season) return [];
  const { title, season } = data, series = `/tv/${encodeURIComponent(title.slug)}/`, path = `${series}season/${season.season_number}/`;
  return [{ '@context': 'https://schema.org', '@type': 'TVSeason', name: season.name || `Season ${season.season_number}`, seasonNumber: season.season_number,
    url: new URL(path, origin).href, partOfSeries: { '@type': 'TVSeries', name: title.title, url: new URL(series, origin).href },
    episode: data.episodes.map(episode => ({ '@type': 'TVEpisode', name: episode.name || `Episode ${episode.episode_number}`, episodeNumber: episode.episode_number,
      url: new URL(`${path}episode/${episode.episode_number}/`, origin).href, ...(isoDate(episode.air_date) ? { datePublished: isoDate(episode.air_date) } : {}) })),
  }, breadcrumbs([{ name: 'Home', path: '/' }, { name: title.title, path: series }, { name: season.name || `Season ${season.season_number}`, path }], origin)];
}
