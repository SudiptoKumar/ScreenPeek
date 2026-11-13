/**
 * ScreenPeek Insight — variant routing (F18/F19/F21, docs/05).
 *
 * A link may carry weighted destination variants. On a tracked click the
 * router picks among ACTIVE variants that are in schedule and under
 * their daily caps, in chain order as the cascade fallback: when the
 * weighted pick is capped the next eligible variant serves; when none
 * can serve, the link's own resolved destination serves with
 * route_reason 'cap_fallback' (or 'schedule' when schedules blocked
 * everything). Cap counters live in KV (written by the background
 * capture / postback paths); variant lists are KV-mirrored on save.
 *
 * The quality gate (F21) is separate: when enabled and the link has a
 * safe_url, a click showing 2+ quality signals goes to the safe page
 * with route_reason 'quality_gate'. It ships disabled and unconfigured.
 */
import { connClassFromOrg } from './quality.ts';

export interface VariantRow {
  id: number;
  link_slug: string;
  dest_url: string;
  weight: number;
  chain_order: number;
  active: number;
  cap_clicks_day: number;
  cap_conv_day: number;
  schedule: string;
  note: string;
}

export interface VariantCounts { clicks: number; conversions: number }

const dayOf = (now: Date) => now.toISOString().slice(0, 10);
export const variantClickKey = (variantId: number, now: Date) => `tr_var_clicks:${dayOf(now)}:${variantId}`;
export const variantConvKey = (variantId: number, now: Date) => `tr_var_convs:${dayOf(now)}:${variantId}`;
const variantsKey = (slug: string) => `tr_variants:${slug}`;

export async function readVariants(env: { DB: D1Database; CONFIG: KVNamespace }, slug: string): Promise<VariantRow[]> {
  try {
    const cached = await env.CONFIG.get(variantsKey(slug));
    if (cached) {
      const parsed = JSON.parse(cached) as VariantRow[];
      if (Array.isArray(parsed)) return parsed;
    }
  } catch { /* fall through to D1 */ }
  const rows = await env.DB.prepare(
    'SELECT * FROM tr_link_variants WHERE link_slug=? AND active=1 ORDER BY chain_order, id',
  ).bind(slug).all<VariantRow>();
  const variants = rows.results || [];
  try { await env.CONFIG.put(variantsKey(slug), JSON.stringify(variants)); } catch { /* mirror is best-effort */ }
  return variants;
}

export async function mirrorVariants(env: { DB: D1Database; CONFIG: KVNamespace }, slug: string): Promise<void> {
  const rows = await env.DB.prepare(
    'SELECT * FROM tr_link_variants WHERE link_slug=? AND active=1 ORDER BY chain_order, id',
  ).bind(slug).all<VariantRow>();
  try { await env.CONFIG.put(variantsKey(slug), JSON.stringify(rows.results || [])); } catch { /* best-effort */ }
}

export async function readVariantCounts(env: { CONFIG: KVNamespace }, variants: VariantRow[], now: Date): Promise<Map<number, VariantCounts>> {
  const counts = new Map<number, VariantCounts>();
  await Promise.all(variants.map(async variant => {
    const [clicks, conversions] = await Promise.all([
      env.CONFIG.get(variantClickKey(variant.id, now)).catch(() => null),
      env.CONFIG.get(variantConvKey(variant.id, now)).catch(() => null),
    ]);
    counts.set(variant.id, { clicks: Number(clicks) || 0, conversions: Number(conversions) || 0 });
  }));
  return counts;
}

export async function bumpVariantCounter(env: { CONFIG: KVNamespace }, kind: 'clicks' | 'conversions', variantId: number, now: Date): Promise<void> {
  const key = kind === 'clicks' ? variantClickKey(variantId, now) : variantConvKey(variantId, now);
  try {
    const current = Number(await env.CONFIG.get(key)) || 0;
    await env.CONFIG.put(key, String(current + 1), { expirationTtl: 60 * 60 * 26 });
  } catch { /* caps are best-effort counters */ }
}

/** Schedule JSON: {"days":[0-6],"start":"HH:MM","end":"HH:MM","tz":"UTC"}.
 * Empty/invalid = always in schedule. Evaluation uses the schedule's own
 * timezone (default UTC) so behaviour is deterministic everywhere. */
export function scheduleAllows(scheduleJson: string, now: Date): boolean {
  if (!scheduleJson) return true;
  let schedule: { days?: number[]; start?: string; end?: string; tz?: string };
  try { schedule = JSON.parse(scheduleJson) as typeof schedule; } catch { return true; }
  if (!schedule || typeof schedule !== 'object') return true;
  try {
    const parts = new Intl.DateTimeFormat('en-GB', {
      timeZone: schedule.tz || 'UTC', weekday: 'short', hour: '2-digit', minute: '2-digit', hour12: false,
    }).formatToParts(now);
    const weekday = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'].indexOf(parts.find(part => part.type === 'weekday')?.value || 'Sun');
    if (Array.isArray(schedule.days) && schedule.days.length && !schedule.days.includes(weekday)) return false;
    const minutes = Number(parts.find(part => part.type === 'hour')?.value || 0) * 60 + Number(parts.find(part => part.type === 'minute')?.value || 0);
    const toMinutes = (value?: string) => {
      const match = /^(\d{1,2}):(\d{2})$/.test(value || '') ? (value as string).split(':').map(Number) : null;
      return match ? match[0] * 60 + match[1] : null;
    };
    const start = toMinutes(schedule.start);
    const end = toMinutes(schedule.end);
    if (start !== null && minutes < start) return false;
    if (end !== null && minutes >= end) return false;
    return true;
  } catch { return true; }
}

export const underCaps = (variant: VariantRow, counts: VariantCounts): boolean =>
  (variant.cap_clicks_day <= 0 || counts.clicks < variant.cap_clicks_day)
  && (variant.cap_conv_day <= 0 || counts.conversions < variant.cap_conv_day);

/** Deterministic 0..1 from a string key (FNV-1a) for sticky picks. */
export function hashFraction(key: string): number {
  let hash = 0x811c9dc5;
  for (let index = 0; index < key.length; index++) {
    hash ^= key.charCodeAt(index);
    hash = Math.imul(hash, 0x01000193);
  }
  return ((hash >>> 0) % 100_000) / 100_000;
}

export function pickVariant(eligible: VariantRow[], stickyKey: string | null, random: () => number = Math.random): VariantRow | null {
  const weighted = eligible.filter(variant => variant.weight > 0);
  if (!weighted.length) return eligible[0] ?? null;
  const total = weighted.reduce((sum, variant) => sum + variant.weight, 0);
  let roll = (stickyKey ? hashFraction(stickyKey) : random()) * total;
  for (const variant of weighted) {
    roll -= variant.weight;
    if (roll < 0) return variant;
  }
  return weighted[weighted.length - 1];
}

export interface RouteDecision {
  destination: string;
  routeReason: string;
  variantId: number | null;
  /** Variants that were skipped purely because a cap was hit. */
  cappedIds: number[];
  scheduleBlocked: boolean;
}

export function decideRoute(input: {
  variants: VariantRow[];
  counts: Map<number, VariantCounts>;
  fallbackDestination: string;
  fallbackReason: string;
  stickyKey: string | null;
  now: Date;
}): RouteDecision {
  const { variants, counts, fallbackDestination, fallbackReason, stickyKey, now } = input;
  if (!variants.length) return { destination: fallbackDestination, routeReason: fallbackReason, variantId: null, cappedIds: [], scheduleBlocked: false };
  const inSchedule = variants.filter(variant => scheduleAllows(variant.schedule, now));
  const scheduleBlocked = inSchedule.length === 0;
  const cappedIds: number[] = [];
  const eligible = inSchedule.filter(variant => {
    const ok = underCaps(variant, counts.get(variant.id) || { clicks: 0, conversions: 0 });
    if (!ok) cappedIds.push(variant.id);
    return ok;
  });
  if (!eligible.length) {
    return {
      destination: fallbackDestination,
      routeReason: cappedIds.length ? 'cap_fallback' : (scheduleBlocked ? 'schedule' : fallbackReason),
      variantId: null, cappedIds, scheduleBlocked,
    };
  }
  const picked = pickVariant(eligible, stickyKey);
  if (!picked) return { destination: fallbackDestination, routeReason: fallbackReason, variantId: null, cappedIds, scheduleBlocked };
  return { destination: picked.dest_url, routeReason: `variant:${picked.id}`, variantId: picked.id, cappedIds, scheduleBlocked };
}

/** F21 quality gate: 2+ synchronous quality signals on this request. */
export function qualityGateSignals(request: Request, asOrg: string, trustScore: number | null, isBotUa: boolean): number {
  let signals = 0;
  if (isBotUa) signals++;
  if (connClassFromOrg(asOrg) === 'datacentre') signals++;
  if (typeof trustScore === 'number' && trustScore < 30) signals++;
  void request;
  return signals;
}

/** One cap alert per variant per day (tr_alerts; F26 delivers them). */
export async function recordCapAlerts(env: { DB: D1Database }, slug: string, cappedIds: number[], now: Date): Promise<void> {
  const day = dayOf(now);
  for (const variantId of cappedIds) {
    const ref = `${slug}#${variantId}`;
    try {
      const existing = await env.DB.prepare("SELECT id FROM tr_alerts WHERE day=? AND kind='cap_hit' AND ref=?").bind(day, ref).first();
      if (!existing) {
        await env.DB.prepare('INSERT INTO tr_alerts(day,kind,ref,message,created_at) VALUES(?,?,?,?,?)')
          .bind(day, 'cap_hit', ref, `Variant ${variantId} of link ${slug} hit its daily cap; traffic cascaded to the next variant or the fallback.`, now.toISOString()).run();
      }
    } catch { /* alerts are best-effort */ }
  }
}
