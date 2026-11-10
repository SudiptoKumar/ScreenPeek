import { TmdbError } from './tmdb.ts';
import type { TmdbClient } from './tmdb.ts';
import type { Candidate, ExistingTitleState, SourceDetails, TransformedTitle } from './types.ts';
import { titleKey } from './types.ts';
import { transformTitle } from './transform.ts';

export interface PreparedTitle { candidate: Candidate; source: SourceDetails; data: TransformedTitle; }

/** Fetch bounded waves, then reserve slugs in queue order, not network completion order. */
export async function prepareCandidates(client: Pick<TmdbClient, 'details'>, candidates: Candidate[], options: {
  now: Date; existing: Map<string, ExistingTitleState>; usedSlugs: Set<string>;
  popularityGate?: number;
  forceImport?: boolean;
  deadlineMs?: number;
}) {
  const prepared: PreparedTitle[] = [];
  const failures: Array<{ candidate: Candidate; status?: number; message: string }> = [];
  const skipped: Array<{ candidate: Candidate; reason: string }> = [];
  const remaining: Candidate[] = [];
  for (let start = 0; start < candidates.length; start += 5) {
    // Past the deadline, stop fetching: the unprepared candidates are
    // returned as `remaining` so the caller can defer them to the queue
    // and spend the rest of the run actually storing what is prepared.
    if (options.deadlineMs !== undefined && performance.now() >= options.deadlineMs) {
      remaining.push(...candidates.slice(start));
      break;
    }
    const wave = candidates.slice(start, start + 5);
    const results = await Promise.allSettled(wave.map(candidate => client.details<SourceDetails>(candidate.type, candidate.id)));
    for (const [index, result] of results.entries()) {
      const candidate = wave[index];
      if (result.status === 'rejected') {
        failures.push({ candidate, status: result.reason instanceof TmdbError ? result.reason.status : undefined,
          message: result.reason instanceof TmdbError ? result.reason.message : 'Bundled metadata request failed' });
        continue;
      }
      try {
        const source = result.value;
        if (!source || source.id !== candidate.id) throw new Error('Bundled detail ID does not match the candidate');
        const existing = options.existing.get(titleKey(candidate.type, candidate.id));
        if (!options.forceImport && !existing && !source.poster_path && (source.popularity ?? 0) < (options.popularityGate ?? 10)) {
          skipped.push({ candidate, reason: 'New title lacks a poster and sufficient popularity after detail verification' });
          continue;
        }
        const data = transformTitle(source, candidate.type, { now: options.now, usedSlugs: options.usedSlugs, existingSlug: existing?.slug, popularityGate: options.popularityGate });
        options.usedSlugs.add(data.title.slug);
        prepared.push({ candidate, source, data });
      } catch {
        failures.push({ candidate, message: 'Bundled metadata failed validation or transformation' });
      }
    }
  }
  return { prepared, failures, skipped, remaining };
}
