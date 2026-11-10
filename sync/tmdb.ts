/** All source URL knowledge stays here. Import this module from sync/ only. */
export type MediaType = 'movie' | 'tv';
export type DiscoveryList = 'trending' | 'now_playing' | 'upcoming' | 'on_the_air' | 'airing_today';
export interface TmdbPage<T> { page: number; total_pages: number; results: T[]; }
export interface TmdbSummary {
  id: number; media_type?: MediaType | 'person'; title?: string; name?: string;
  poster_path?: string | null; popularity?: number; adult?: boolean;
}
export interface TmdbChange { id: number; adult?: boolean; }
export interface TmdbClientOptions {
  token?: string;
  apiKey?: string;
  baseUrl?: string;
  imageBaseUrl?: string;
  fetch?: typeof globalThis.fetch;
  sleep?: (milliseconds: number) => Promise<void>;
  now?: () => number;
  concurrency?: number;
  maxRetries?: number;
  timeoutMs?: number;
}

export class TmdbError extends Error {
  readonly status: number;
  constructor(status: number) {
    // Do not include response bodies or URLs: they can echo authentication data.
    super(`TMDb request failed (HTTP ${status})`);
    this.name = 'TmdbError';
    this.status = status;
  }
}

export class TmdbClient {
  private readonly token: string;
  private readonly apiKey: string;
  private readonly base: URL;
  private readonly imageBase: URL;
  private readonly fetcher: typeof globalThis.fetch;
  private readonly sleep: (milliseconds: number) => Promise<void>;
  private readonly now: () => number;
  private readonly concurrency: number;
  private readonly retries: number;
  private readonly timeoutMs: number;
  private active = 0;
  private readonly waiting: Array<() => void> = [];

  constructor(options: TmdbClientOptions) {
    this.token = options.token?.trim() || '';
    this.apiKey = options.apiKey?.trim() || '';
    if (!this.token && !this.apiKey) throw new Error('Set TMDB_READ_TOKEN or TMDB_API_KEY for sync');
    this.base = this.sourceBase(options.baseUrl || 'https://api.themoviedb.org/3/');
    this.imageBase = this.sourceBase(options.imageBaseUrl || 'https://image.tmdb.org/t/p/');
    this.fetcher = options.fetch || globalThis.fetch;
    this.sleep = options.sleep || (milliseconds => new Promise(resolve => setTimeout(resolve, milliseconds)));
    this.now = options.now || Date.now;
    this.concurrency = options.concurrency ?? 5;
    this.retries = options.maxRetries ?? 4;
    this.timeoutMs = options.timeoutMs ?? 30_000;
    if (!Number.isInteger(this.concurrency) || this.concurrency < 1 || this.concurrency > 5) throw new Error('TMDb concurrency must be between 1 and 5');
    if (!Number.isInteger(this.retries) || this.retries < 0 || this.retries > 8) throw new Error('TMDb maxRetries must be between 0 and 8');
    if (!Number.isInteger(this.timeoutMs) || this.timeoutMs < 1) throw new Error('TMDb timeout must be positive');
  }

  private sourceBase(value: string) {
    const url = new URL(value.endsWith('/') ? value : `${value}/`);
    if (url.protocol !== 'https:' || url.username || url.password || url.search || url.hash) throw new Error('Source base must be an HTTPS URL without credentials or query parameters');
    return url;
  }

  private async slot<T>(operation: () => Promise<T>): Promise<T> {
    if (this.active < this.concurrency) this.active++;
    else await new Promise<void>(resolve => this.waiting.push(resolve));
    try { return await operation(); }
    finally {
      const next = this.waiting.shift();
      if (next) next(); else this.active--;
    }
  }

  private retryDelay(header: string | null, attempt: number) {
    const exponential = Math.min(30_000, 1000 * 2 ** attempt);
    if (!header) return exponential;
    const seconds = Number(header);
    const parsed = Number.isFinite(seconds) ? seconds * 1000 : Date.parse(header) - this.now();
    return Number.isFinite(parsed) ? Math.max(exponential, parsed, 0) : exponential;
  }

  private async response<T>(url: URL, authenticate: boolean, consume: (response: Response) => Promise<T>) {
    if (authenticate && !this.token) url.searchParams.set('api_key', this.apiKey);
    return this.slot(async () => {
      for (let attempt = 0; ; attempt++) {
        let response: Response;
        try {
          response = await this.fetcher(url, {
            headers: authenticate && this.token ? { Authorization: `Bearer ${this.token}`, Accept: 'application/json' } : {},
            signal: AbortSignal.timeout(this.timeoutMs),
            redirect: 'error', // Never forward a token through an unexpected redirect.
          });
        } catch {
          if (attempt >= this.retries) throw new Error('TMDb network request failed after retries');
          await this.sleep(this.retryDelay(null, attempt));
          continue;
        }
        if (response.ok) return await consume(response);
        const retryable = response.status === 429 || response.status >= 500;
        if (!retryable || attempt >= this.retries) {
          await response.body?.cancel();
          throw new TmdbError(response.status);
        }
        const delay = this.retryDelay(response.headers.get('Retry-After'), attempt);
        await response.body?.cancel();
        await this.sleep(delay);
      }
    });
  }

  private async json<T>(path: string, params: Record<string, string | number> = {}): Promise<T> {
    const url = new URL(path, this.base);
    url.searchParams.set('language', 'en-US');
    for (const [key, value] of Object.entries(params)) url.searchParams.set(key, String(value));
    return this.response(url, true, async response => {
      try { return await response.json() as T; }
      catch { throw new Error('TMDb returned invalid JSON'); }
    });
  }

  private id(id: number) {
    if (!Number.isSafeInteger(id) || id < 1) throw new Error('Source IDs must be positive integers');
    return id;
  }

  private page(page: number) {
    if (!Number.isInteger(page) || page < 1) throw new Error('Page must be a positive integer');
    return page;
  }

  changes(type: MediaType | 'person', startDate: string, endDate: string, page = 1) {
    if (!['movie', 'tv', 'person'].includes(type)) throw new Error('Unknown changes type');
    for (const date of [startDate, endDate]) {
      const parsed = Date.parse(`${date}T00:00:00.000Z`);
      if (!/^\d{4}-\d{2}-\d{2}$/.test(date) || !Number.isFinite(parsed) || new Date(parsed).toISOString().slice(0, 10) !== date) throw new Error('Changes dates must be valid YYYY-MM-DD dates');
    }
    const duration = Date.parse(endDate) - Date.parse(startDate);
    if (duration < 0 || duration > 14 * 86_400_000) throw new Error('Changes date range must be ordered and at most 14 days');
    return this.json<TmdbPage<TmdbChange>>(`${type}/changes`, { start_date: startDate, end_date: endDate, page: this.page(page) });
  }

  discovery(list: DiscoveryList, page = 1) {
    const paths: Record<DiscoveryList, string> = {
      trending: 'trending/all/day', now_playing: 'movie/now_playing', upcoming: 'movie/upcoming',
      on_the_air: 'tv/on_the_air', airing_today: 'tv/airing_today',
    };
    if (!Object.hasOwn(paths, list)) throw new Error('Unknown discovery list');
    return this.json<TmdbPage<TmdbSummary>>(paths[list], { page: this.page(page) });
  }

  details<T = Record<string, unknown>>(type: MediaType, id: number) {
    if (!['movie', 'tv'].includes(type)) throw new Error('Unknown media type');
    const append = type === 'movie'
      ? 'credits,videos,watch/providers,similar,release_dates,images'
      : 'credits,videos,watch/providers,similar,content_ratings,images';
    return this.json<T>(`${type}/${this.id(id)}`, { append_to_response: append });
  }

  person<T = Record<string, unknown>>(id: number) { return this.json<T>(`person/${this.id(id)}`); }
  season<T = Record<string, unknown>>(id: number, season: number) {
    if (!Number.isInteger(season) || season < 0) throw new Error('Season must be a non-negative integer');
    return this.json<T>(`tv/${this.id(id)}/season/${season}`);
  }

  async image(path: string, size: 'w185' | 'w300' | 'w500' = 'w500') {
    if (!/^\/[A-Za-z0-9_-]+\.(?:jpg|jpeg|png|webp)$/i.test(path)) throw new Error('Invalid source image path');
    if (!['w185', 'w300', 'w500'].includes(size)) throw new Error('Invalid source image size');
    return this.response(new URL(`${size}${path}`, this.imageBase), false, async response => {
      if (!response.headers.get('Content-Type')?.startsWith('image/')) {
        await response.body?.cancel();
        throw new Error('Source image response is not an image');
      }
      const reader = response.body?.getReader();
      if (!reader) throw new Error('Source image response is empty');
      const chunks: Uint8Array[] = [];
      let length = 0;
      for (;;) {
        const { value, done } = await reader.read();
        if (done) break;
        length += value.byteLength;
        if (length > 20 * 1024 * 1024) {
          await reader.cancel();
          throw new Error('Source image exceeds the 20 MB processing limit');
        }
        chunks.push(value);
      }
      const result = new Uint8Array(length);
      let offset = 0;
      for (const chunk of chunks) { result.set(chunk, offset); offset += chunk.byteLength; }
      return result;
    });
  }
}

export function tmdbFromEnv(environment: Record<string, string | undefined>) {
  return new TmdbClient({ token: environment.TMDB_READ_TOKEN, apiKey: environment.TMDB_API_KEY, baseUrl: environment.TMDB_BASE_URL });
}
