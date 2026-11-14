import type { DiscoveryList, MediaType, TmdbClient, TmdbPage } from './tmdb.ts';
import { titleKey, type Candidate, type ExistingTitleState } from './types.ts';

const day = 86_400_000;
const discoveryLists: DiscoveryList[] = ['trending', 'now_playing', 'upcoming', 'on_the_air', 'airing_today'];
const listTypes: Partial<Record<DiscoveryList, MediaType>> = {
  now_playing: 'movie', upcoming: 'movie', on_the_air: 'tv', airing_today: 'tv',
};
const validId = (id: number) => Number.isSafeInteger(id) && id > 0;
const popularity = (candidate: Candidate) => Number.isFinite(candidate.popularity) ? candidate.popularity! : 0;

function checkedNow(now: Date) {
  const timestamp = now.getTime();
  if (!Number.isFinite(timestamp)) throw new Error('Sync now must be a valid date');
  return timestamp;
}

async function pages<T>(request: (page: number) => Promise<TmdbPage<T>>, limit = Number.POSITIVE_INFINITY) {
  const results: T[] = [];
  for (let page = 1; page <= limit; page++) {
    const response = await request(page);
    if (!Array.isArray(response.results) || !Number.isSafeInteger(response.total_pages) || response.total_pages < 0 || response.page !== page) {
      throw new Error('Source returned invalid pagination');
    }
    results.push(...response.results);
    if (page >= response.total_pages) break;
  }
  return results;
}

function merge(previous: Candidate | undefined, candidate: Candidate): Candidate {
  if (!previous) return { ...candidate };
  const scores = [previous.popularity, candidate.popularity].filter((score): score is number => typeof score === 'number' && Number.isFinite(score));
  const poster = [candidate.poster_path, previous.poster_path].find(path => typeof path === 'string' && path.trim().length > 0);
  return {
    ...previous, ...candidate,
    changed: previous.changed || candidate.changed,
    adult: previous.adult === true || candidate.adult === true ? true : candidate.adult ?? previous.adult,
    popularity: scores.length ? Math.max(...scores) : undefined,
    poster_path: poster ?? candidate.poster_path ?? previous.poster_path,
  };
}

/** Collectors know source operations and result shapes; only tmdb.ts knows URLs. */
export async function collectCandidates(
  client: Pick<TmdbClient, 'changes' | 'discovery'>,
  options: { now: Date; lastSuccess?: string },
) {
  const now = checkedNow(options.now);
  const lastSuccess = options.lastSuccess === undefined ? undefined : Date.parse(options.lastSuccess);
  if (lastSuccess !== undefined && !Number.isFinite(lastSuccess)) throw new Error('Last successful sync timestamp is invalid');
  const start = Math.max(now - 14 * day, Math.min(now - day, lastSuccess ?? now - day));
  const window = { startDate: new Date(start).toISOString().slice(0, 10), endDate: new Date(now).toISOString().slice(0, 10) };
  const needsReconciliation = lastSuccess !== undefined && now - lastSuccess > 14 * day;
  // Independent feeds run together. The shared client still enforces its five-request cap.
  const [movies, tv, people, discovery, topRated, deepMovies, deepTv] = await Promise.all([
    pages(page => client.changes('movie', window.startDate, window.endDate, page)),
    pages(page => client.changes('tv', window.startDate, window.endDate, page)),
    pages(page => client.changes('person', window.startDate, window.endDate, page)),
    Promise.all(discoveryLists.map(list => pages(page => client.discovery(list, page), 3))),
    // The all-time top movies (the IMDb Top 250 idea, from TMDb's own
    // top-rated list): 13 pages ≈ 260 titles, marked so the selection
    // below always puts them first.
    pages(page => client.discovery('top_rated', page), 13),
    // The deep walk (owner's growth fix, 2026-11-14): the front lists hold
    // only a few hundred titles and were fully imported within days, after
    // which runs had almost no NEW titles to add. Discover-by-popularity
    // pages 25 deep per type (≈500 titles each) keep fresh candidates
    // flowing; deferred ones persist in the queue between runs, so the
    // walk continues where it left off instead of restarting.
    pages(page => client.discovery('discover_movie', page), 25),
    pages(page => client.discovery('discover_tv', page), 25),
  ]);
  const titles = new Map<string, Candidate>();
  const adults = new Set<string>();
  for (const [type, changes] of [['movie', movies], ['tv', tv]] as const) {
    for (const change of changes) {
      if (!validId(change.id)) continue;
      const key = titleKey(type, change.id);
      if (change.adult === true) { adults.add(key); continue; }
      titles.set(key, merge(titles.get(key), { id: change.id, type, changed: true }));
    }
  }
  for (const [index, summaries] of discovery.entries()) {
    const list = discoveryLists[index];
    for (const summary of summaries) {
      if (!validId(summary.id) || summary.media_type === 'person') continue;
      const type = listTypes[list] ?? summary.media_type;
      if (type !== 'movie' && type !== 'tv') continue;
      if (summary.media_type && summary.media_type !== type) continue;
      const key = titleKey(type, summary.id);
      if (summary.adult === true) { adults.add(key); continue; }
      titles.set(key, merge(titles.get(key), { ...summary, type, changed: false }));
    }
  }
  for (const [type, summaries] of [['movie', deepMovies], ['tv', deepTv]] as const) {
    for (const summary of summaries) {
      if (!validId(summary.id) || summary.media_type === 'person') continue;
      if (summary.media_type && summary.media_type !== type) continue;
      const key = titleKey(type, summary.id);
      if (summary.adult === true) { adults.add(key); continue; }
      titles.set(key, merge(titles.get(key), { ...summary, type, changed: false }));
    }
  }
  for (const summary of topRated) {
    if (!validId(summary.id) || summary.media_type === 'person') continue;
    const key = titleKey('movie', summary.id);
    if (summary.adult === true) { adults.add(key); continue; }
    titles.set(key, merge(titles.get(key), { ...summary, type: 'movie', changed: false, topRated: true }));
  }
  const adultPeople = new Set(people.filter(person => person.adult === true).map(person => person.id));
  const personIds = [...new Set(people.filter(person => validId(person.id) && !adultPeople.has(person.id)).map(person => person.id))].sort((a, b) => a - b);
  return {
    titles: [...titles.values()].filter(candidate => !adults.has(titleKey(candidate.type, candidate.id))).sort(identityOrder),
    personIds, window, needsReconciliation,
  };
}

function identityOrder(a: Candidate, b: Candidate) {
  return (a.type === b.type ? 0 : a.type === 'movie' ? -1 : 1) || a.id - b.id;
}

export function filterCandidates(
  candidates: readonly Candidate[],
  options: {
    existing: Map<string, ExistingTitleState>; blocklist: Set<string>; now: Date;
    freshnessHours?: number; popularityGate?: number; maxTitles?: number;
    perTypeMax?: Partial<Record<MediaType, number>>;
  },
) {
  const now = checkedNow(options.now);
  const freshness = options.freshnessHours ?? 24;
  const popularityGate = options.popularityGate ?? 10;
  const maxTitles = options.maxTitles ?? 2000;
  if (!Number.isFinite(freshness) || freshness < 0) throw new Error('Freshness hours must be non-negative');
  if (!Number.isFinite(popularityGate) || popularityGate < 0) throw new Error('Popularity gate must be non-negative');
  if (!Number.isSafeInteger(maxTitles) || maxTitles < 0 || maxTitles > 2000) throw new Error('Maximum titles must be an integer between 0 and 2000');
  const eligible: Candidate[] = [];
  const skipped: Array<{ candidate: Candidate; reason: string }> = [];
  const unique = new Map<string, Candidate>();
  for (const candidate of candidates) {
    if (!validId(candidate.id) || !['movie', 'tv'].includes(candidate.type)) {
      skipped.push({ candidate, reason: 'invalid-id-or-type' });
      continue;
    }
    const key = titleKey(candidate.type, candidate.id);
    unique.set(key, merge(unique.get(key), candidate));
  }
  for (const candidate of unique.values()) {
    const key = titleKey(candidate.type, candidate.id);
    const existing = options.existing.get(key);
    let reason: string | undefined;
    if (candidate.adult === true) reason = 'adult';
    else if (options.blocklist.has(key)) reason = 'blocklisted';
    else if (existing?.deleted || existing?.deleted_at) reason = 'deleted';
    else if (existing && !candidate.changed) {
      const updated = Date.parse(existing.updated_at);
      const age = now - updated;
      if (Number.isFinite(updated) && age >= 0 && age < freshness * 3_600_000) reason = 'fresh';
    }
    if (!reason && !existing) {
      const hasPoster = typeof candidate.poster_path === 'string' && candidate.poster_path.trim().length > 0;
      // Changes feeds contain IDs, not popularity/poster metadata. Such new IDs
      // must reach bundled details, where the final quality gate is evaluated.
      const unknownChangedMetadata = candidate.changed && candidate.poster_path === undefined && candidate.popularity === undefined;
      if (!hasPoster && popularity(candidate) < popularityGate && !unknownChangedMetadata) reason = 'below-discovery-gate';
    }
    if (reason) skipped.push({ candidate, reason });
    else eligible.push(candidate);
  }
  // Owner's extraction order (2026-11-11, corrected 2026-11-14): NEW
  // titles come before updates GLOBALLY, not just inside a tier. The old
  // order put the top-rated tier first, and since all ~260 top-rated
  // movies were already in the catalogue, every run's slots were spent
  // re-updating them while new titles never reached the selection window
  // (added stayed 0 for days). Inside the new-first order: top-rated
  // first, then movies before series, changed before unchanged, then
  // popularity. Updates take only the room new titles leave.
  eligible.sort((a, b) => Number(options.existing.has(titleKey(a.type, a.id))) - Number(options.existing.has(titleKey(b.type, b.id)))
    || Number(b.topRated === true) - Number(a.topRated === true)
    || (a.type === b.type ? 0 : a.type === 'movie' ? -1 : 1)
    || Number(b.changed) - Number(a.changed) || popularity(b) - popularity(a) || identityOrder(a, b));
  // Per-type caps pace the catalogue build (owner's 500 movies + 100
  // series per day, shaped per run): once a type hits its cap, its
  // remaining titles defer while the other type keeps filling the run.
  const selected: Candidate[] = [];
  const deferred: Candidate[] = [];
  const taken: Partial<Record<MediaType, number>> = {};
  for (const candidate of eligible) {
    const cap = options.perTypeMax?.[candidate.type];
    if (selected.length >= maxTitles || (cap !== undefined && (taken[candidate.type] ?? 0) >= cap)) { deferred.push(candidate); continue; }
    taken[candidate.type] = (taken[candidate.type] ?? 0) + 1;
    selected.push(candidate);
  }
  return { selected, deferred, skipped };
}
