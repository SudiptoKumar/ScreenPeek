import type { MediaType } from './tmdb.ts';
import type { SourceDetails, SourcePerson, TransformedTitle } from './types.ts';

export const countries = ['US', 'GB', 'CA', 'AU'] as const;
const clean = (value: unknown) => typeof value === 'string' ? value.trim() : '';
const numeric = (value: unknown, fallback = 0) => typeof value === 'number' && Number.isFinite(value) ? value : fallback;
const validId = (id: number) => Number.isSafeInteger(id) && id > 0;
const unique = <T>(items: T[], key: (item: T) => string) => [...new Map(items.map(item => [key(item), item])).values()];

export function slugBase(value: string) {
  return value.normalize('NFKD').replace(/[\u0300-\u036f]/g, '').toLowerCase()
    .replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
}

export function titleSlug(name: string, year: number | null, type: MediaType, id: number, used: Set<string>, existing?: string) {
  if (existing) return existing; // A renamed title never changes its public URL.
  const base = `${slugBase(name) || type}${year ? `-${year}` : ''}`;
  if (!used.has(base)) return base;
  if (!used.has(`${base}-${id}`)) return `${base}-${id}`;
  // Movie/TV IDs overlap at the source; the type disambiguates that rare case.
  const collision = `${base}-${type}-${id}`;
  if (!used.has(collision)) return collision;
  let suffix = 2;
  while (used.has(`${collision}-${suffix}`)) suffix++;
  return `${collision}-${suffix}`;
}

export function personSlug(name: string, id: number, used: Set<string>, existing?: string) {
  if (existing) return existing;
  const base = slugBase(name) || 'person';
  if (!used.has(base)) return base;
  const suffix = `${base}-${id}`;
  if (!used.has(suffix)) return suffix;
  let count = 2;
  while (used.has(`${suffix}-${count}`)) count++;
  return `${suffix}-${count}`;
}

export function qualityGate(input: {
  posterR2?: string | null; overview: string; popularity: number;
  castCount: number; providerCount: number;
}, threshold = 10) {
  return Number(Boolean(input.posterR2) && input.overview.length >= 80 && input.popularity >= threshold
    && (input.castCount >= 3 || input.providerCount > 0));
}

function date(value: unknown) {
  const result = clean(value).slice(0, 10);
  const parsed = Date.parse(`${result}T00:00:00.000Z`);
  return /^\d{4}-\d{2}-\d{2}$/.test(result) && Number.isFinite(parsed)
    && new Date(parsed).toISOString().slice(0, 10) === result ? result : null;
}

export function transformPerson(source: SourcePerson, options: { now: Date; usedSlugs: Set<string>; existingSlug?: string }) {
  if (!validId(source.id) || !clean(source.name)) throw new Error('Person metadata is missing a valid ID or name');
  return {
    id: source.id, slug: personSlug(source.name, source.id, options.usedSlugs, options.existingSlug),
    name: clean(source.name), bio: clean(source.biography), popularity: Math.max(0, numeric(source.popularity)),
    updated_at: options.now.toISOString(), source_profile: source.profile_path || null,
  };
}

export function transformTitle(source: SourceDetails, type: MediaType, options: {
  now: Date; usedSlugs: Set<string>; existingSlug?: string;
  posterR2?: string | null; popularityGate?: number;
}): TransformedTitle {
  if (!source || !validId(source.id) || !['movie', 'tv'].includes(type)) throw new Error('Title metadata is missing a valid ID or type');
  if (source.adult) throw new Error('Adult titles are outside the launch catalogue');
  const name = clean(type === 'movie' ? source.title : source.name);
  if (!name) throw new Error('Title metadata is missing its name');
  const released = date(type === 'movie' ? source.release_date : source.first_air_date);
  const year = released ? Number(released.slice(0, 4)) : null;
  const genres = unique((source.genres || []).filter(genre => clean(genre.name)).map(genre => ({
    slug: slugBase(genre.name) || `genre-${genre.id}`, name: clean(genre.name),
  })), genre => genre.slug);
  const cast = unique((source.credits?.cast || []).filter(person => validId(person.id) && clean(person.name)), person => String(person.id))
    .sort((a, b) => numeric(a.order, Number.MAX_SAFE_INTEGER) - numeric(b.order, Number.MAX_SAFE_INTEGER)).slice(0, 12);
  const directors = unique((source.credits?.crew || []).filter(person => validId(person.id) && person.job === 'Director' && clean(person.name)), person => String(person.id));
  const creators = unique((source.created_by || []).filter(person => validId(person.id) && clean(person.name)), person => String(person.id));
  const credits: TransformedTitle['credits'] = [
    ...cast.map((person, ord) => ({ person_id: person.id, role: 'cast' as const, character: clean(person.character) || null, ord })),
    ...directors.map((person, ord) => ({ person_id: person.id, role: 'director' as const, character: null, ord })),
    ...creators.map((person, ord) => ({ person_id: person.id, role: 'creator' as const, character: null, ord })),
  ];
  const providers: TransformedTitle['providers'] = [];
  const offers = { flatrate: 'stream', rent: 'rent', buy: 'buy', free: 'free', ads: 'ads' } as const;
  for (const country of countries) {
    const data = source['watch/providers']?.results?.[country];
    for (const [key, offer_type] of Object.entries(offers) as Array<[keyof typeof offers, typeof offers[keyof typeof offers]]>) {
      for (const provider of data?.[key] || []) {
        if (!validId(provider.provider_id) || !clean(provider.provider_name)) continue;
        providers.push({ country, provider_id: provider.provider_id, provider_name: clean(provider.provider_name), offer_type, source_logo: provider.logo_path || null });
      }
    }
  }
  const dedupedProviders = unique(providers, provider => `${provider.country}:${provider.provider_id}:${provider.offer_type}`);
  const releases: TransformedTitle['releases'] = [];
  for (const country of countries) {
    if (type === 'movie') {
      const candidates = source.release_dates?.results?.find(row => row.iso_3166_1 === country)?.release_dates || [];
      const chosen = [...candidates].filter(row => date(row.release_date)).sort((a, b) => (a.type === 3 ? -1 : 0) - (b.type === 3 ? -1 : 0) || a.release_date.localeCompare(b.release_date))[0];
      if (chosen) releases.push({ country, release_date: date(chosen.release_date), certification: clean(chosen.certification) });
    } else {
      const rating = source.content_ratings?.results?.find(row => row.iso_3166_1 === country);
      if (rating) releases.push({ country, release_date: released, certification: clean(rating.rating) });
    }
  }
  const trailers = source.videos?.results?.filter(video => video.site === 'YouTube' && video.type === 'Trailer' && /^[A-Za-z0-9_-]{11}$/.test(video.key)) || [];
  const trailer = trailers.find(video => video.official) || trailers[0];
  const overview = clean(source.overview);
  const popularity = Math.max(0, numeric(source.popularity));
  const rating = typeof source.vote_average === 'number' && Number.isFinite(source.vote_average) && source.vote_average >= 0 && source.vote_average <= 10 ? source.vote_average : null;
  const runtime = type === 'movie' ? numeric(source.runtime) : numeric(source.episode_run_time?.[0]);
  const gallery = [...new Set((source.images?.backdrops || []).map(image => image.file_path).filter(Boolean))].slice(0, 6);
  return {
    title: {
      id: source.id, type, slug: titleSlug(name, year, type, source.id, options.usedSlugs, options.existingSlug), title: name,
      original_title: clean(type === 'movie' ? source.original_title : source.original_name) || name,
      overview, release_date: released, year, runtime_min: runtime > 0 ? Math.round(runtime) : null,
      status: clean(source.status), original_language: clean(source.original_language), popularity,
      vote_average: rating, vote_count: Math.max(0, Math.floor(numeric(source.vote_count))),
      imdb_id: clean(source.imdb_id) || null, genres: JSON.stringify(genres.map(genre => genre.slug)),
      similar_ids: JSON.stringify([...new Set((source.similar?.results || []).filter(title => validId(title.id) && title.id !== source.id).map(title => title.id))].slice(0, 12)),
      trailer_key: trailer?.key || null,
      quality_gate: qualityGate({ posterR2: options.posterR2, overview, popularity, castCount: cast.length, providerCount: dedupedProviders.length }, options.popularityGate),
      updated_at: options.now.toISOString(),
    },
    genres, credits, people: unique([...cast, ...directors, ...creators], person => String(person.id)),
    providers: dedupedProviders, releases,
    seasons: type === 'tv' ? (source.seasons || []).filter(season => Number.isSafeInteger(season.season_number) && season.season_number >= 0) : [],
    images: { poster: source.poster_path || null, backdrop: source.backdrop_path || gallery[0] || null, gallery },
    collection: source.belongs_to_collection || null,
    extra: { budget: source.budget ? numeric(source.budget) : null, revenue: source.revenue ? numeric(source.revenue) : null, studios: (source.production_companies || []).map(company => clean(company.name)).filter(Boolean) },
  };
}
