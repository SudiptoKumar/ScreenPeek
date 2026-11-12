// ScreenPeek Insight — priority quota engine (PRD §5, docs/01).
//
// Raw storage is capped per UTC day (default 3,000 rows across clicks +
// events + sessions). Tier-1 countries are always stored first; other
// countries fill the quota only under the fill rule. Conversions are
// money records: always stored, never counted. Aggregates are counted by
// the callers regardless of this decision, so totals stay true even when
// raw storage is capped.
//
// State is one KV counter per UTC day: tr_quota:YYYY-MM-DD. Read-modify-
// write races may overshoot by a few rows under concurrency — accepted
// and documented in docs/01.

export type QuotaKind = 'click' | 'session' | 'event' | 'conversion';
export type Tier = 'tier1' | 'other';
export type QuotaDecision = 'store' | 'skip';

export interface QuotaRules {
  dailyCap: number;
  tier1Countries: string[];
  fillPct: number;
  fillAfterHourUtc: number;
}

export function classifyTier(country: string, tier1Countries: string[]): Tier {
  const value = (country || '').trim().toUpperCase();
  if (!value) return 'other';
  return tier1Countries.includes(value) ? 'tier1' : 'other';
}

/** Pure decision. `count` = raw rows already stored today. */
export function quotaDecision(count: number, rules: QuotaRules, tier: Tier, kind: QuotaKind, now: Date): QuotaDecision {
  if (kind === 'conversion') return 'store';
  if (count >= rules.dailyCap) return 'skip';
  if (tier === 'tier1') return 'store';
  const fillThreshold = Math.floor(rules.dailyCap * rules.fillPct / 100);
  if (count < fillThreshold) return 'store';
  const hour = now.getUTCHours();
  // Events are the lowest priority: in the late-fill window they join
  // only in the final hour (docs/01). Clicks and sessions use the plain
  // fill rule.
  if (kind === 'event') return hour >= 23 && count < rules.dailyCap ? 'store' : 'skip';
  return hour >= rules.fillAfterHourUtc && count < rules.dailyCap ? 'store' : 'skip';
}

export const quotaKey = (now: Date) => `tr_quota:${now.toISOString().slice(0, 10)}`;

export interface QuotaKv {
  get(key: string): Promise<string | null>;
  put(key: string, value: string): Promise<void>;
}

export interface QuotaResult {
  decision: QuotaDecision;
  /** Raw rows stored today after this decision. */
  count: number;
  tier: Tier;
  /** True when the cap has been reached today (drives tracking_degraded). */
  capped: boolean;
}

/**
 * Stateful engine over the KV day counter. `onDegradedChange` lets the
 * caller persist the tracking_degraded config flag when it flips.
 */
export class QuotaEngine {
  private degraded = false;
  private kv: QuotaKv;
  private onDegradedChange?: (degraded: boolean) => Promise<void>;

  constructor(kv: QuotaKv, onDegradedChange?: (degraded: boolean) => Promise<void>) {
    this.kv = kv;
    this.onDegradedChange = onDegradedChange;
  }

  /** One KV value holds both counters ({s: stored, t: total attempts})
   * so a decision costs a single get + a single put. A legacy plain
   * number reads as both counters at that value. */
  private async readState(now: Date): Promise<{ stored: number; total: number }> {
    const raw = await this.kv.get(quotaKey(now));
    if (!raw) return { stored: 0, total: 0 };
    try {
      const parsed = JSON.parse(raw) as { s?: number; t?: number };
      if (typeof parsed?.s === 'number') return { stored: parsed.s, total: typeof parsed.t === 'number' ? parsed.t : parsed.s };
    } catch { /* fall through to the legacy shape */ }
    const numeric = Number(raw) || 0;
    return { stored: numeric, total: numeric };
  }

  async decide(input: { kind: QuotaKind; country: string }, rules: QuotaRules, now = new Date()): Promise<QuotaResult> {
    const tier = classifyTier(input.country, rules.tier1Countries);
    if (input.kind === 'conversion') return { decision: 'store', count: await this.count(now), tier, capped: false };
    const state = await this.readState(now);
    const decision = quotaDecision(state.stored, rules, tier, input.kind, now);
    const next = decision === 'store' ? state.stored + 1 : state.stored;
    try {
      await this.kv.put(quotaKey(now), JSON.stringify({ s: next, t: state.total + 1 }));
    } catch { /* a failed counter put never changes the decision */ }
    if (decision === 'store' && this.degraded) { this.degraded = false; await this.onDegradedChange?.(false); }
    const capped = next >= rules.dailyCap;
    if (capped && !this.degraded) { this.degraded = true; await this.onDegradedChange?.(true); }
    return { decision, count: next, tier, capped };
  }

  async count(now = new Date()): Promise<number> {
    return (await this.readState(now)).stored;
  }

  async total(now = new Date()): Promise<number> {
    return (await this.readState(now)).total;
  }
}
