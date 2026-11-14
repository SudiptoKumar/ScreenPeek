import { purgeExpiredTrash } from './trash.ts';
import { posterColour } from './colour.ts';
import { composeOg } from './og.ts';
import type { MediaType, TmdbClient } from './tmdb.ts';
import type { Candidate, ExistingTitleState, SourcePerson } from './types.ts';
import { titleKey } from './types.ts';
import type { SqlClient, SqlStatement } from './storage.ts';
import type { ImageStore } from './posters.ts';
import { processImage } from './posters.ts';
import { collectCandidates, filterCandidates } from './collectors.ts';
import { prepareCandidates } from './prepare.ts';
import { transformPerson } from './transform.ts';
import { persistPerson, persistTitle, refreshCounts } from './persist.ts';
import { startSyncLog, finishSyncLog } from './log.ts';
import type { SyncSummary } from './log.ts';
import { notifyFailure } from './notify.ts';

export type SyncSource = Pick<TmdbClient, 'changes' | 'discovery' | 'details' | 'person' | 'season' | 'image'>;
interface PersonState extends Record<string, unknown> {
  id: number; slug: string; bio: string | null; profile_r2: string | null;
  locked_fields: string; deleted_at: string | null;
}
interface TitleState extends ExistingTitleState {
  poster_r2: string | null; poster_color: string | null; backdrop_r2: string | null; gallery_r2: string;
}
interface SeasonPayload { episodes?: Array<{ episode_number: number; name?: string; overview?: string; air_date?: string; still_path?: string | null }>; }
const parseArray = (value: string) => { try { const parsed: unknown = JSON.parse(value); return Array.isArray(parsed) ? parsed : []; } catch { return []; } };

export async function runSync(options: {
  db: SqlClient; client: SyncSource; images: ImageStore;
  environment?: Record<string, string | undefined>; source?: 'cron' | 'manual';
  now?: () => Date; targets?: Candidate[]; personIds?: number[];
  maxTitles?: number; writeBudget?: number; maxDurationMs?: number;
}) {
  const { db, client, images } = options;
  const clock = options.now || (() => new Date());
  const start = performance.now();
  const now = clock();
  const summary: SyncSummary = { status: 'failed', source: options.source || 'cron', startedAt: now.toISOString(), finishedAt: now.toISOString(), added: 0, updated: 0, errors: [] };
  let logId: number | undefined;
  let rowsWritten = 0;
  let budget = Math.min(options.writeBudget ?? 50_000, 80_000);
  let dailyRowsBase = 0;
  const writeDay = now.toISOString().slice(0, 10);
  const duration = options.maxDurationMs ?? 12 * 60_000;
  const warn = (message: string) => { if (summary.errors.length < 100) summary.errors.push(message); };
  const batch = async (statements: SqlStatement[]) => { rowsWritten += (await db.batch(statements)).rowsWritten; };
  try {
    if (!Number.isInteger(budget) || budget < 1 || !Number.isFinite(duration) || duration <= 0) throw new Error('Invalid sync resource budget');
    logId = await startSyncLog(db, summary.startedAt, summary.source);
    const config = Object.fromEntries((await db.query<{ key: string; value: string }>('SELECT key,value FROM config')).map(row => [row.key, row.value]));
    const threshold = Number(config.sync_popularity_gate || 10);
    const existing = new Map((await db.query<TitleState>('SELECT id,type,slug,updated_at,locked_fields,hidden,deleted,deleted_at,poster_r2,poster_color,backdrop_r2,gallery_r2 FROM titles')).map(row => [titleKey(row.type, row.id), row]));
    const people = new Map((await db.query<PersonState>('SELECT id,slug,bio,profile_r2,locked_fields,deleted_at FROM people')).map(row => [row.id, row]));
    const blockedRows = await db.query<{ tmdb_id: number; type: string }>('SELECT tmdb_id,type FROM blocklist');
    const blocked = new Set(blockedRows.map(row => `${row.type}:${row.tmdb_id}`));
    // The changes window advances on any COMPLETED run (ok or partial):
    // a partial run still collected its window, and everything it could
    // not process is preserved in sync_queue. Keying the window to 'ok'
    // only deadlocked the sync — every run re-collected the same growing
    // window, deferred the same titles again, and stayed partial forever.
    // A failed run collected nothing reliably, so it never advances it.
    const last = await db.query<{ finished_at: string }>("SELECT finished_at FROM sync_log WHERE status IN ('ok','partial') AND finished_at IS NOT NULL ORDER BY id DESC LIMIT 1");
    const collected = options.targets || options.personIds ? { titles: options.targets || [], personIds: options.personIds || [], needsReconciliation: false }
      : await collectCandidates(client, { now, lastSuccess: last[0]?.finished_at });
    if (collected.needsReconciliation) warn('Changes recovery window exceeded 14 days; run manual reconciliation.');
    const queue = await db.query<{ candidate: string }>('SELECT candidate FROM sync_queue ORDER BY queued_at,title_type,title_id');
    const queued: Candidate[] = [];
    for (const row of queue) {
      try {
        const candidate = JSON.parse(row.candidate) as Candidate;
        if (Number.isSafeInteger(candidate.id) && candidate.id > 0 && ['movie', 'tv'].includes(candidate.type)) queued.push({ ...candidate, changed: true });
      } catch { warn('An invalid queued candidate was ignored.'); }
    }
    const manual = Boolean(options.targets || options.personIds);
    // Daily write governor: D1's free plan allows 100,000 written rows a
    // day (UTC) across the whole system (sync, money checker, panel).
    // Scheduled runs share a soft ceiling of 95,000 (owner, 2026-11-14:
    // use the full budget for catalogue growth; 5,000 rows stay reserved
    // so visitor tracking, the panel and the money checker can never be
    // starved by the sync). Tracked in the sync_write_day config counter.
    // Runs with an explicit budget (tests) skip the cap; every run still
    // records what it wrote.
    if (options.writeBudget === undefined) {
      try {
        const saved = JSON.parse(config.sync_write_day || '{}') as { day?: string; rows?: number };
        if (saved.day === writeDay && Number.isFinite(saved.rows)) dailyRowsBase = Math.max(0, Math.floor(saved.rows!));
      } catch { /* A corrupt counter must never block the sync. */ }
      if (!manual) budget = Math.min(budget, Math.max(1_000, 95_000 - dailyRowsBase));
    }
    // Owner's catalogue build (2026-11-11): add 500 movies + 100 series a
    // day until the catalogue holds 5,000 complete movies and 2,000
    // complete series; past a goal, that type drops to a small
    // latest-only trickle. The per-run shaping (63 movies + 13 series x
    // 8 runs) is set by the sync_movie_cap / sync_series_cap config keys
    // in production; the code defaults stay generous so a bare database
    // (or a bulk local import) is never paced by accident.
    // "Complete" = the poster is stored (poster_r2 set). Manual targeted
    // imports bypass the caps, like they bypass the popularity gate.
    let perTypeMax: Partial<Record<MediaType, number>> | undefined;
    // Series persist cap for this run (the config series cap). Selection
    // prepares up to 4x this many series so the ones dropped by the
    // 16-episode rule are backfilled from the same run's pool instead of
    // wasting the slots; the persist loop enforces the cap itself.
    let seriesPersistCap = Number.POSITIVE_INFINITY;
    if (!manual) {
      const cap = (value: string | undefined, fallback: number) => { const parsed = Number(value); return Number.isFinite(parsed) && parsed >= 0 ? Math.floor(parsed) : fallback; };
      const completeMovies = [...existing.values()].filter(row => row.type === 'movie' && row.poster_r2).length;
      const completeSeries = [...existing.values()].filter(row => row.type === 'tv' && row.poster_r2).length;
      const movieGoal = cap(config.sync_movie_goal, 5000);
      const seriesGoal = cap(config.sync_series_goal, 2000);
      const movieCap = completeMovies >= movieGoal ? 25 : cap(config.sync_movie_cap, 125);
      const seriesCap = completeSeries >= seriesGoal ? 10 : cap(config.sync_series_cap, 25);
      seriesPersistCap = seriesCap;
      perTypeMax = { movie: movieCap, tv: seriesCap * 4 };
      console.info(`Sync targets: complete movies ${completeMovies}/${movieGoal} (per-run cap ${movieCap}), complete series ${completeSeries}/${seriesGoal} (per-run cap ${seriesCap}).`);
    }
    // A targeted (manual) import must import exactly the requested titles.
    // Merging the deferred queue in would rank the targets behind thousands
    // of queued candidates and they would never reach the selection window.
    // Queue rows themselves stay untouched in the database for cron runs.
    const filtered = filterCandidates(manual ? collected.titles : [...queued, ...collected.titles], { existing, blocklist: blocked, now,
      freshnessHours: 24 * 7,
      maxTitles: options.maxTitles ?? Math.min(2000, Number(config.sync_max_titles || 2000)), popularityGate: manual ? 0 : threshold, perTypeMax });
    const usedSlugs = new Set([...existing.values()].map(row => row.slug));
    const usedPeopleSlugs = new Set([...people.values()].map(row => row.slug));
    // Prepare gets the first half of the run's clock; the persist phase
    // keeps the second half. Without a deadline, preparing a large
    // selection consumed the whole budget and zero titles were stored.
    const work = await prepareCandidates(client, filtered.selected, { existing, now, usedSlugs, popularityGate: threshold, forceImport: manual, deadlineMs: start + Math.floor(duration / 2) });
    console.info(`Sync timing: prepare took ${Math.round(performance.now() - start)}ms for ${work.prepared.length} titles (${filtered.selected.length} selected).`);
    // Owner rule (2026-11-11, corrected 2026-11-12): the cap is PER
    // SEASON, not per series — a series is extracted only while every
    // season has at most 16 episodes. (The original total-episodes
    // reading blocked exactly the web series the owner wants: Stranger
    // Things has 42 episodes in total but seasons of 8–9; Breaking Bad
    // 62 in total, seasons of 7–16; Money Heist seasons of 9–13. Long
    // broadcast serials run 20–24 episodes per season and stay out.)
    // Season 0 (Specials) never counts toward the cap. Over-cap series
    // are dropped for good — the queue row is deleted so they are not
    // re-selected on later runs. Series already in the catalogue are
    // untouched; this gates intake only.
    {
      const kept: typeof work.prepared = [];
      let droppedSeries = 0;
      for (const item of work.prepared) {
        if (item.candidate.type === 'tv') {
          const longestSeason = item.data.seasons
            .filter(season => (season.season_number ?? 0) >= 1)
            .reduce((max, season) => Math.max(max, season.episode_count || 0), 0);
          if (longestSeason > 16) {
            droppedSeries++;
            await batch([
              { sql: 'DELETE FROM sync_queue WHERE title_id=? AND title_type=?', params: [item.candidate.id, item.candidate.type] },
              { sql: 'INSERT OR IGNORE INTO blocklist(tmdb_id,type,reason) VALUES(?,?,?)', params: [item.candidate.id, item.candidate.type, 'season over 16 episodes (owner rule)'] },
            ]);
            continue;
          }
        }
        kept.push(item);
      }
      if (droppedSeries) console.info(`Sync: dropped ${droppedSeries} series with a season over the 16-episode limit.`);
      work.prepared = kept;
    }
    // Interleave series into the movie stream 5:1, so a run that runs
    // out of clock still lands some of both (the owner's daily 500 + 100
    // shape). Relative order inside each type is preserved, so top-rated
    // movies still lead the movie stream.
    {
      const movies = work.prepared.filter(item => item.candidate.type === 'movie');
      const series = work.prepared.filter(item => item.candidate.type === 'tv');
      if (movies.length && series.length) {
        const interleaved: typeof work.prepared = [];
        let mi = 0, si = 0;
        while (mi < movies.length || si < series.length) {
          for (let k = 0; k < 5 && mi < movies.length; k++) interleaved.push(movies[mi++]);
          if (si < series.length) interleaved.push(series[si++]);
        }
        work.prepared = interleaved;
      }
    }
    const changedPeople = new Set([...collected.personIds, ...(options.personIds || [])]);
    const processedPeople = new Set<number>();
    const providerLogos = new Map<number, string | null>();
    const deferred = [...filtered.deferred, ...work.remaining];
    for (const failure of work.failures) {
      warn(`${failure.candidate.type}:${failure.candidate.id}: ${failure.message}`);
      if (failure.status === 404) {
        await batch([
          { sql: 'UPDATE titles SET hidden=1 WHERE id=? AND type=?', params: [failure.candidate.id, failure.candidate.type] },
          { sql: 'DELETE FROM sync_queue WHERE title_id=? AND title_type=?', params: [failure.candidate.id, failure.candidate.type] },
        ]);
      } else deferred.push(failure.candidate);
    }
    // Remove stale/blocked queued work too; owner deletes must not be
    // resurrected. Only rows actually sitting in the queue are deleted,
    // in batches — one request per skipped candidate burned minutes of
    // every run on no-ops (most skipped candidates were never queued).
    {
      const queuedKeys = new Set(queued.map(candidate => titleKey(candidate.type, candidate.id)));
      const seen = new Set<string>();
      const statements: SqlStatement[] = [];
      for (const candidate of [...filtered.skipped.map(row => row.candidate), ...work.skipped.map(row => row.candidate)]) {
        const key = titleKey(candidate.type, candidate.id);
        if (!queuedKeys.has(key) || seen.has(key)) continue;
        seen.add(key);
        statements.push({ sql: 'DELETE FROM sync_queue WHERE title_id=? AND title_type=?', params: [candidate.id, candidate.type] });
      }
      for (let offset = 0; offset < statements.length; offset += 100) await batch(statements.slice(offset, offset + 100));
    }
    async function syncPerson(person: SourcePerson, allowCreditFallback = true) {
      if (processedPeople.has(person.id) || blocked.has(`person:${person.id}`) || people.get(person.id)?.deleted_at) return;
      processedPeople.add(person.id);
      const previous = people.get(person.id);
      if (previous && previous.bio && !changedPeople.has(person.id)) return;
      let details = person;
      try { details = await client.person<SourcePerson>(person.id); }
      catch {
        warn(`Person ${person.id}: details unavailable${allowCreditFallback ? '; kept credit metadata' : ''}.`);
        if (!allowCreditFallback) return;
      }
      if (details.id !== person.id) { warn(`Person ${person.id}: mismatched detail ID.`); return; }
      const data = transformPerson(details, { now, usedSlugs: usedPeopleSlugs, existingSlug: previous?.slug });
      usedPeopleSlugs.add(data.slug);
      let profile = previous?.profile_r2 || null;
      if (!parseArray(previous?.locked_fields || '[]').includes('profile_r2')) {
        const result = await processImage(client, images, { kind: 'profile', id: person.id, path: data.source_profile });
        if (result.warning) warn(result.warning);
        profile = result.keys['185'] || null;
      }
      rowsWritten += (await persistPerson(db, data, profile)).rowsWritten;
    }
    for (const id of options.personIds || []) {
      try { await syncPerson({ id, name: '' }, false); }
      catch { warn(`Person ${id}: import failed validation.`); }
    }
    let persistedSeries = 0;
    for (const [index, prepared] of work.prepared.entries()) {
      if (rowsWritten >= budget || performance.now() - start >= duration) {
        deferred.push(...work.prepared.slice(index).map(item => item.candidate));
        warn('Sync write/time budget reached; remaining work is deferred.');
        break;
      }
      const { candidate, data } = prepared;
      if (candidate.type === 'tv' && persistedSeries >= seriesPersistCap) { deferred.push(candidate); continue; }
      const previous = existing.get(titleKey(candidate.type, candidate.id));
      const overTime = () => performance.now() - start >= duration;
      const titleStart = performance.now();
      console.info(`Sync timing: starting ${candidate.type}:${candidate.id} people=${data.people.length} seasons=${data.seasons.length} at ${Math.round(titleStart - start)}ms.`);
      try {
        // People are fetched in parallel (owner's 400/day pace,
        // 2026-11-14): one-by-one, a new title's cast cost ~25s of
        // sequential detail + photo fetches and the run's clock — not
        // the write budget — became the ceiling (41 added using only
        // 9.5k of 95k rows). syncPerson registers each person before
        // its first await, so parallel calls never double-fetch.
        await Promise.all(data.people.map(async person => { if (overTime()) throw new Error('Sync deadline reached'); await syncPerson(person); }));
        data.credits = data.credits.filter(credit => !blocked.has(`person:${credit.person_id}`) && !people.get(credit.person_id)?.deleted_at);
        const locks = parseArray(previous?.locked_fields || '[]');
        if(locks.length)console.info(`Kept manual edit fields for ${candidate.type}:${candidate.id}: ${locks.filter(field=>typeof field==='string'&&/^[a-z_]{1,40}$/.test(field)).join(', ')}`);
        const poster = locks.includes('poster_r2') ? { keys: { '185': previous?.poster_r2 || '' }, warning: null }
          : await processImage(client, images, { kind: 'poster', id: candidate.id, mediaType: candidate.type, path: data.images.poster });
        if (poster.warning) warn(poster.warning);
        const backdrop = locks.includes('backdrop_r2') ? { keys: { '300': previous?.backdrop_r2 || '' }, warning: null }
          : await processImage(client, images, { kind: 'backdrop', id: candidate.id, mediaType: candidate.type, path: data.images.backdrop });
        if (backdrop.warning) warn(backdrop.warning);
        for (const provider of data.providers) {
          if (!providerLogos.has(provider.provider_id)) {
            const logo = await processImage(client, images, { kind: 'logo', id: provider.provider_id, path: provider.source_logo });
            if (logo.warning) warn(logo.warning);
            providerLogos.set(provider.provider_id, logo.keys['185'] || null);
          }
          provider.logo_r2 = providerLogos.get(provider.provider_id) || null;
        }
        let colour: string | null | undefined;
        if (poster.keys['185'] && !locks.includes('poster_color') && (previous?.poster_r2 !== poster.keys['185'] || !previous?.poster_color)) {
          try { colour = await posterColour(client, images, poster.keys['185'], locks.includes('poster_r2') ? null : data.images.poster); } catch { warn(`${candidate.type}:${candidate.id}: poster colour extraction failed.`); }
        }
        const gallery = backdrop.keys['300'] ? [backdrop.keys['300']] : [];
        rowsWritten += (await persistTitle(db, data, { poster: poster.keys['185'] || null, backdrop: backdrop.keys['300'] || null, gallery, posterColor: colour }, { popularityGate: threshold })).rowsWritten;
        const storedTitle = (await db.query<{ id: number; type: 'movie' | 'tv'; title: string; year: number | null; quality_gate: number; updated_at: string; locked_fields: string }>('SELECT id,type,title,year,quality_gate,updated_at,locked_fields FROM titles WHERE id=? AND type=? AND hidden=0 AND deleted=0 AND deleted_at IS NULL', [candidate.id, candidate.type]))[0];
        if (storedTitle?.quality_gate && poster.keys['185'] && !parseArray(storedTitle.locked_fields).includes('og_r2')) {
          try {
            const key = await composeOg(client, images, { id: storedTitle.id, type: storedTitle.type, title: storedTitle.title, year: storedTitle.year, posterPath: locks.includes('poster_r2') ? null : data.images.poster, posterKey: poster.keys['185'], siteName: config.site_name || 'ScreenPeek' });
            await batch([{ sql: "UPDATE titles SET og_r2=? WHERE id=? AND type=? AND updated_at=? AND quality_gate=1 AND hidden=0 AND deleted=0 AND deleted_at IS NULL AND NOT EXISTS(SELECT 1 FROM json_each(locked_fields) WHERE value='og_r2')", params: [key, storedTitle.id, storedTitle.type, storedTitle.updated_at] }]);
          } catch { warn(`${candidate.type}:${candidate.id}: sharing card generation failed.`); }
        }
        for (const season of data.seasons) {
          if (overTime()) throw new Error('Sync deadline reached');
          if (season.episode_count < 1) continue;
          const existingEpisodes = new Map((await db.query<{ episode_number: number; name: string; air_date: string | null; still_r2: string | null }>('SELECT episode_number,name,air_date,still_r2 FROM episodes WHERE title_id=? AND season_number=?', [candidate.id, season.season_number])).map(row => [row.episode_number, row]));
          // A season whose episode count already matches is not
          // re-fetched — even for a changed title. New episodes change
          // the count, so they are always picked up; only text edits
          // inside an otherwise unchanged season wait for a fuller
          // reconciliation. Without this, one long-running show costs
          // one source fetch per season on every single run.
          if (existingEpisodes.size === season.episode_count) continue;
          try {
            const details = await client.season<SeasonPayload>(candidate.id, season.season_number);
            if (!Array.isArray(details.episodes)) throw new Error('Invalid season payload');
            // One D1 request per season, not one per episode: the REST
            // API rate limit is per request, and a long-running show
            // otherwise burns hundreds of calls on a single title.
            const statements: SqlStatement[] = [];
            // Still images are fetched in parallel for the same reason
            // as people above: one-by-one they made series the slowest
            // titles in the run. The statement build below stays
            // sequential and reads the results from this map.
            const stills = new Map<number, { keys: Record<string, string>; warning: string | null }>();
            await Promise.all((details.episodes || []).map(async episode => {
              if (!Number.isSafeInteger(episode.episode_number) || episode.episode_number < 1) return;
              const priorEpisode = existingEpisodes.get(episode.episode_number);
              if (priorEpisode?.still_r2) { stills.set(episode.episode_number, { keys: { '185': priorEpisode.still_r2 as string }, warning: null }); return; }
              const still = await processImage(client, images, { kind: 'still', id: candidate.id, mediaType: 'tv', path: episode.still_path });
              if (still.warning) warn(still.warning);
              stills.set(episode.episode_number, still);
            }));
            for (const episode of details.episodes || []) {
              if (overTime()) throw new Error('Sync deadline reached');
              if (!Number.isSafeInteger(episode.episode_number) || episode.episode_number < 1) continue;
              const priorEpisode = existingEpisodes.get(episode.episode_number);
              if (priorEpisode && priorEpisode.still_r2 && priorEpisode.name === (episode.name || '') && (priorEpisode.air_date || null) === (episode.air_date || null)) continue;
              const still = stills.get(episode.episode_number) ?? { keys: {} as Record<string, string>, warning: null };
              statements.push({ sql: `INSERT INTO episodes(title_id,season_number,episode_number,name,overview,air_date,still_r2)
                SELECT ?,?,?,?,?,?,? WHERE EXISTS(SELECT 1 FROM titles WHERE id=? AND type='tv' AND deleted=0 AND deleted_at IS NULL)
                ON CONFLICT(title_id,season_number,episode_number) DO UPDATE SET name=excluded.name,overview=excluded.overview,air_date=excluded.air_date,still_r2=excluded.still_r2`,
                params: [candidate.id, season.season_number, episode.episode_number, episode.name || '', episode.overview || '', episode.air_date || null, still.keys['185'] || null, candidate.id] });
            }
            if (statements.length) await batch(statements);
          } catch (error) { if (overTime()) throw error; warn(`TV ${candidate.id}, season ${season.season_number}: episode refresh failed.`); }
        }
        await batch([{ sql: 'DELETE FROM sync_queue WHERE title_id=? AND title_type=?', params: [candidate.id, candidate.type] }]);
        if (previous) summary.updated++; else summary.added++;
        if (candidate.type === 'tv') persistedSeries++;
      } catch (error) {
        deferred.push(candidate);
        // A deadline stop mid-title is a deferral, not a failure: the
        // title keeps its queue row and resumes next run (every episode
        // and image already saved stays saved).
        if (!overTime()) {
          console.error(`Title persistence failure ${candidate.type}:${candidate.id}:`, error);
          // A D1 rate limit (HTTP 429) is global, not per-title: every
          // later title would fail the same way. Stop the loop cleanly
          // and let the next run continue — upserts make that safe.
          if (error instanceof Error && error.message.includes('HTTP 429')) {
            warn('Database rate limit reached; remaining work is deferred to the next run.');
            deferred.push(...work.prepared.slice(index + 1).map(item => item.candidate));
            break;
          }
          warn(`${candidate.type}:${candidate.id}: persistence failed; candidate retained for retry.`);
        }
      }
    }
    await purgeExpiredTrash({query:db.query.bind(db),batch:async statements=>{const result=await db.batch(statements);rowsWritten+=result.rowsWritten;return result;}},clock(),Math.min(1000,Math.max(0,Math.floor((budget-rowsWritten)/10))));
    // Small transactional chunks keep each request within D1 API limits.
    // Candidates already sitting in the queue keep their row untouched —
    // rewriting ~20k identical queue rows every night would burn most of
    // the daily D1 write budget on no-ops.
    const alreadyQueued = new Set(queued.map(candidate => titleKey(candidate.type, candidate.id)));
    // Prepared-but-unstored candidates (already fetched — the valuable
    // ones) re-queue first; never-prepared deferred candidates fill the
    // remaining room up to a per-run cap, so a huge changes day cannot
    // burn the daily write budget on queue rows alone.
    const unprepared = new Set(filtered.deferred);
    const orderedDeferred = [...deferred.filter(candidate => !unprepared.has(candidate)), ...deferred.filter(candidate => unprepared.has(candidate))];
    const toQueue = orderedDeferred.filter(candidate => !alreadyQueued.has(titleKey(candidate.type, candidate.id))).slice(0, 500);
    for (let offset = 0; offset < toQueue.length; offset += 100) {
      if (rowsWritten >= 80_000) { warn('Queue write safety cap reached; catch-up window remains open.'); break; }
      await batch(toQueue.slice(offset, offset + 100).map(candidate => ({
        sql: 'INSERT INTO sync_queue(title_id,title_type,candidate,queued_at) VALUES(?,?,?,?) ON CONFLICT(title_id,title_type) DO UPDATE SET candidate=excluded.candidate',
        params: [candidate.id, candidate.type, JSON.stringify(candidate), now.toISOString()],
      })));
    }
    if (deferred.length) warn(`${deferred.length} candidates deferred to a later run.`);
    rowsWritten += (await refreshCounts(db)).rowsWritten;
    await batch([
      { sql: "DELETE FROM click_log WHERE day < date('now','-30 days')" },
      { sql: "DELETE FROM search_log WHERE day < date('now','-30 days')" },
      { sql: 'DELETE FROM notfound_log WHERE path NOT IN (SELECT path FROM notfound_log ORDER BY last_seen DESC LIMIT 500)' },
      { sql: 'DELETE FROM admin_log WHERE id NOT IN (SELECT id FROM admin_log ORDER BY id DESC LIMIT 500)' },
    ]);
    summary.status = summary.errors.length ? 'partial' : 'ok';
  } catch (error) {
    // Raw upstream errors stay out of the summary (they can carry URLs
    // and tokens); the detail goes to the server log only.
    console.error('Sync infrastructure failure:', error);
    if (error instanceof Error && error.message.includes('HTTP 429')) {
      warn('Database rate limit reached near the end of the run; unfinished work stays queued for the next run.');
      summary.status = 'partial';
    } else {
      warn('Sync stopped after an infrastructure or source failure; existing catalogue data was retained.');
      summary.status = 'failed';
    }
  }
  summary.finishedAt = clock().toISOString();
  if (logId) {
    try { await finishSyncLog(db, logId, summary); }
    catch (error) { console.error('Sync log finalize failure:', error); summary.status = 'failed'; warn('Could not finalize the sync log.'); }
  }
  // Record this run's writes in the daily counter the governor reads.
  if (options.writeBudget === undefined && rowsWritten > 0) {
    try {
      await db.batch([{ sql: "INSERT INTO config(key,value,revision) VALUES('sync_write_day',?,1) ON CONFLICT(key) DO UPDATE SET value=excluded.value, revision=revision+1", params: [JSON.stringify({ day: writeDay, rows: dailyRowsBase + rowsWritten })] }]);
    } catch { /* Best effort: a missed recording only loosens the cap slightly. */ }
  }
  const alert = await notifyFailure(options.environment || {}, summary);
  if (alert.warning) {
    warn(alert.warning);
    if (logId) { try { await finishSyncLog(db, logId, summary); } catch { /* Earlier log error is already reported. */ } }
  }
  return { ...summary, rowsWritten };
}
