/**
 * ScreenPeek Insight — link health checker (F26, docs/06).
 *
 * Daily workflow step: HEAD-check (GET fallback) every active link
 * destination — default, per-country and per-device — plus every
 * active variant URL. Results land in tr_link_health, one row per
 * link + URL + day. A destination is only called DEAD after failing
 * two consecutive days; that raises an alert and drives the red badge
 * in the Links admin and the Tracking overview health strip.
 */
import { httpsDestination } from '../links.ts';
import { raiseAlert, type AlertEnvironment } from './alerts.ts';

export interface HealthTarget { slug: string; url: string }
export interface HealthRun { checked: number; dead: HealthTarget[] }

const dayOf = (date: Date) => date.toISOString().slice(0, 10);

export async function collectHealthTargets(db: D1Database): Promise<HealthTarget[]> {
  const targets = new Map<string, HealthTarget>();
  const add = (slug: string, value: unknown) => {
    // httpsDestination is the codebase's type guard for safe URLs.
    if (httpsDestination(value)) targets.set(`${slug}|${value}`, { slug, url: value });
  };
  const links = await db.prepare('SELECT slug, destination, rules FROM links WHERE enabled=1 AND deleted_at IS NULL')
    .all<{ slug: string; destination: string; rules: string }>();
  for (const link of links.results || []) {
    add(link.slug, link.destination);
    let rules: Record<string, unknown> = {};
    try {
      const parsed: unknown = typeof link.rules === 'string' ? JSON.parse(link.rules) : link.rules;
      if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) rules = parsed as Record<string, unknown>;
    } catch { /* malformed rules carry no extra destinations */ }
    for (const group of ['byCountry', 'byDevice']) {
      const map = rules[group];
      if (map && typeof map === 'object' && !Array.isArray(map)) {
        for (const value of Object.values(map as Record<string, unknown>)) add(link.slug, value);
      }
    }
  }
  const variants = await db.prepare('SELECT link_slug, dest_url FROM tr_link_variants WHERE active=1')
    .all<{ link_slug: string; dest_url: string }>();
  for (const variant of variants.results || []) add(variant.link_slug, variant.dest_url);
  return [...targets.values()];
}

async function probe(url: string, fetcher: typeof fetch): Promise<{ ok: boolean; httpStatus: number }> {
  const attempt = async (method: string) => {
    const response = await fetcher(url, { method, redirect: 'follow', signal: AbortSignal.timeout(5000) });
    return response.status;
  };
  try {
    let status = await attempt('HEAD');
    if (status === 405 || status === 501) status = await attempt('GET');
    return { ok: status >= 200 && status < 400, httpStatus: status };
  } catch { return { ok: false, httpStatus: 0 }; }
}

export async function runLinkHealth(env: AlertEnvironment, fetcher: typeof fetch = fetch, now = new Date()): Promise<HealthRun> {
  const targets = await collectHealthTargets(env.DB);
  const today = dayOf(now);
  const yesterday = dayOf(new Date(now.getTime() - 86_400_000));
  const dead: HealthTarget[] = [];
  for (const target of targets) {
    const result = await probe(target.url, fetcher);
    await env.DB.prepare('INSERT OR REPLACE INTO tr_link_health(link_slug,url,day,ok,http_status,checked_at) VALUES(?,?,?,?,?,?)')
      .bind(target.slug, target.url, today, result.ok ? 1 : 0, result.httpStatus || null, now.toISOString()).run();
    if (!result.ok) {
      const prior = await env.DB.prepare('SELECT ok FROM tr_link_health WHERE link_slug=? AND url=? AND day=?')
        .bind(target.slug, target.url, yesterday).first<{ ok: number }>();
      if (prior && prior.ok === 0) {
        dead.push(target);
        await raiseAlert(env, 'dead_link', target.slug,
          `Destination for ${target.slug} has failed its health check two days running: ${target.url} (today: ${result.httpStatus ? `HTTP ${result.httpStatus}` : 'no answer / timeout'}).`, now);
      }
    }
  }
  return { checked: targets.length, dead };
}

/** Slugs whose destination failed today AND yesterday — the badge set. */
export async function deadLinkSlugs(db: D1Database, now = new Date()): Promise<Array<{ slug: string; url: string; httpStatus: number | null }>> {
  const today = dayOf(now);
  const yesterday = dayOf(new Date(now.getTime() - 86_400_000));
  const rows = await db.prepare(`SELECT t.link_slug AS slug, t.url AS url, t.http_status AS httpStatus FROM tr_link_health t
    JOIN tr_link_health y ON y.link_slug=t.link_slug AND y.url=t.url AND y.day=?
    WHERE t.day=? AND t.ok=0 AND y.ok=0 ORDER BY t.link_slug`)
    .bind(yesterday, today).all<{ slug: string; url: string; httpStatus: number | null }>().catch(() => null);
  return rows?.results || [];
}
