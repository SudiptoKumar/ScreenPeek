import type { MediaType, TmdbSummary } from './tmdb.ts';

export interface Candidate extends TmdbSummary { type: MediaType; changed: boolean; topRated?: boolean; }
export interface ExistingTitleState extends Record<string, unknown> {
  id: number; type: MediaType; slug: string; updated_at: string;
  locked_fields?: string; hidden?: number; deleted?: number; deleted_at?: string | null;
}
export const titleKey = (type: MediaType, id: number) => `${type}:${id}`;

export interface SourcePerson {
  id: number; name: string; biography?: string; profile_path?: string | null;
  popularity?: number; character?: string; order?: number; job?: string;
}
export interface SourceProvider {
  provider_id: number; provider_name: string; logo_path?: string | null;
}
export interface SourceDetails extends TmdbSummary {
  original_title?: string; original_name?: string; overview?: string;
  release_date?: string; first_air_date?: string; runtime?: number;
  episode_run_time?: number[]; status?: string; original_language?: string;
  vote_average?: number; vote_count?: number; imdb_id?: string;
  backdrop_path?: string | null; genres?: Array<{ id: number; name: string }>;
  credits?: { cast?: SourcePerson[]; crew?: SourcePerson[] };
  created_by?: SourcePerson[];
  videos?: { results?: Array<{ key: string; site: string; type: string; official?: boolean }> };
  similar?: { results?: TmdbSummary[] };
  'watch/providers'?: { results?: Record<string, {
    flatrate?: SourceProvider[]; rent?: SourceProvider[]; buy?: SourceProvider[];
    free?: SourceProvider[]; ads?: SourceProvider[];
  }> };
  release_dates?: { results?: Array<{ iso_3166_1: string; release_dates: Array<{ release_date: string; certification: string; type: number }> }> };
  content_ratings?: { results?: Array<{ iso_3166_1: string; rating: string }> };
  seasons?: Array<{ season_number: number; name: string; episode_count: number; air_date?: string }>;
  images?: { backdrops?: Array<{ file_path: string }> };
  belongs_to_collection?: { id: number; name: string } | null;
  budget?: number; revenue?: number; production_companies?: Array<{ name: string }>;
}

export interface TransformedTitle {
  title: {
    id: number; type: MediaType; slug: string; title: string; original_title: string;
    overview: string; release_date: string | null; year: number | null;
    runtime_min: number | null; status: string; original_language: string;
    popularity: number; vote_average: number | null; vote_count: number;
    imdb_id: string | null; genres: string; similar_ids: string; trailer_key: string | null;
    quality_gate: number; updated_at: string;
  };
  genres: Array<{ slug: string; name: string }>;
  credits: Array<{ person_id: number; role: 'cast' | 'director' | 'creator'; character: string | null; ord: number }>;
  people: SourcePerson[];
  providers: Array<{ country: string; provider_id: number; provider_name: string; offer_type: 'stream' | 'rent' | 'buy' | 'free' | 'ads'; source_logo: string | null; logo_r2?: string | null }>;
  releases: Array<{ country: string; release_date: string | null; certification: string }>;
  seasons: NonNullable<SourceDetails['seasons']>;
  images: { poster: string | null; backdrop: string | null; gallery: string[] };
  collection: { id: number; name: string } | null;
  extra: { budget: number | null; revenue: number | null; studios: string[] };
}
