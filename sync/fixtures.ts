/** Entirely synthetic, local-only importer source. Never a production fallback. */
import sharp from 'sharp';
import type { DiscoveryList, MediaType, TmdbPage, TmdbSummary } from './tmdb.ts';
import type { SourceDetails, SourcePerson } from './types.ts';
import type { SyncSource } from './engine.ts';

export function fixtureSource(count = 50): SyncSource & { downloads: () => number } {
  if (!Number.isInteger(count) || count < 1 || count > 50) throw new Error('Fixture count must be between 1 and 50');
  let downloads = 0;
  let pixels: Uint8Array<ArrayBuffer> | undefined;
  const people: SourcePerson[] = Array.from({ length: 3 }, (_, index) => ({
    id: 8_100_001 + index, name: `Sample Import Person ${index + 1}`,
    biography: 'Fictional person used only for local importer verification.', profile_path: `/sample-profile-${index + 1}.png`,
  }));
  const titles: SourceDetails[] = Array.from({ length: count }, (_, index) => ({
    id: 8_000_001 + index, media_type: index < 30 ? 'movie' : 'tv',
    title: `Sample Import: Lantern ${String(index + 1).padStart(2, '0')}`,
    name: `Sample Import: Lantern ${String(index + 1).padStart(2, '0')}`,
    release_date: '2026-01-12', first_air_date: '2026-01-12', popularity: 20 + index,
    overview: 'Synthetic local import verification data. This is not a real movie or television show. A fictional traveller follows a lantern through an imaginary town.',
    poster_path: `/sample-poster-${index + 1}.png`, backdrop_path: '/sample-backdrop.png',
    original_language: 'en', runtime: 100, episode_run_time: [42], status: 'Released',
    genres: [{ id: 1, name: 'Drama' }], credits: { cast: people },
    'watch/providers': { results: Object.fromEntries(['US', 'GB', 'CA', 'AU'].map(country => [country, { flatrate: [{ provider_id: 8_200_001, provider_name: 'Sample Import Provider', logo_path: '/sample-logo.png' }] }])) },
    seasons: index < 30 ? [] : [{ season_number: 1, name: 'Sample Season', episode_count: 2, air_date: '2026-01-12' }],
  }));
  const page = <T>(results: T[], requested = 1): TmdbPage<T> => ({ page: requested, total_pages: 1, results: requested === 1 ? results : [] });
  return {
    async changes(type, _start, _end, requested = 1) {
      return page(type === 'person' ? people.map(person => ({ id: person.id })) : titles.filter(title => title.media_type === type).map(title => ({ id: title.id })), requested);
    },
    async discovery(list: DiscoveryList, requested = 1) {
      const type: MediaType | undefined = list === 'trending' ? undefined : ['now_playing', 'upcoming'].includes(list) ? 'movie' : 'tv';
      return page<TmdbSummary>(titles.filter(title => !type || title.media_type === type), requested);
    },
    async details<T>(type: MediaType, id: number): Promise<T> {
      const title = titles.find(row => row.id === id && row.media_type === type);
      if (!title) throw new Error('Fixture title does not exist');
      return title as T;
    },
    async person<T>(id: number): Promise<T> {
      const person = people.find(row => row.id === id);
      if (!person) throw new Error('Fixture person does not exist');
      return person as T;
    },
    async season<T>(): Promise<T> {
      return { episodes: [1, 2].map(number => ({ episode_number: number, name: `Sample Episode ${number}`, overview: 'Synthetic local episode.', air_date: '2026-01-12', still_path: '/sample-still.png' })) } as T;
    },
    async image() {
      downloads++;
      pixels ||= new Uint8Array(await sharp({ create: { width: 500, height: 750, channels: 3, background: '#254352' } }).png().toBuffer());
      return pixels;
    },
    downloads: () => downloads,
  };
}
