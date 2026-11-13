/**
 * ScreenPeek Insight — EPC auto-optimisation (F20, docs/05).
 *
 * Nightly (from the sync workflow) and on demand from the admin: for
 * every link the owner marked autoopt=1, compute earnings per click per
 * variant from the last 7 days — Tier-1 traffic judged separately from
 * the rest — and shift weight toward the best variant in steps of at
 * most 20 points. Variants under the minimum-click floor and
 * owner-locked variants never move. Suggestion mode
 * (tracking_autoopt_apply=0, the default) writes the proposal to the
 * admin log and changes nothing; apply mode performs the shift and
 * logs before/after with the EPC table used.
 */
import { readTrackingConfig } from './config.ts';
import { mirrorVariants } from './routing.ts';
import { raiseAlert } from './alerts.ts';

export interface EpcRow {
  slug: string;
  variantId: number;
  group: 'tier1' | 'rest';
  device: string;
  clicks: number;
  conversions: number;
  revenueMinor: number;
  epcMinor: number;
}

export async function computeEpcTable(db: D1Database, tier1Countries: string[], days = 7): Promise<EpcRow[]> {
  const tier1 = new Set(tier1Countries.map(code => code.toUpperCase()));
  const clicks = await db.prepare(
    `SELECT slug, variant_id, country, device_type, COUNT(*) AS clicks FROM tr_clicks
     WHERE variant_id IS NOT NULL AND ts >= datetime('now', ?) GROUP BY slug, variant_id, country, device_type`,
  ).bind(`-${days} days`).all<{ slug: string; variant_id: number; country: string; device_type: string; clicks: number }>();
  const conversions = await db.prepare(
    `SELECT k.slug AS slug, k.variant_id AS variant_id, k.country AS country, k.device_type AS device_type,
            COUNT(*) AS conversions, COALESCE(SUM(c.payout_minor), 0) AS revenue
     FROM tr_conversions c JOIN tr_clicks k ON k.click_id = c.click_id
     WHERE k.variant_id IS NOT NULL AND c.ts_received >= datetime('now', ?) AND c.status_mapped <> 'late'
     GROUP BY k.slug, k.variant_id, k.country, k.device_type`,
  ).bind(`-${days} days`).all<{ slug: string; variant_id: number; country: string; device_type: string; conversions: number; revenue: number }>();
  const map = new Map<string, EpcRow>();
  const keyOf = (slug: string, variantId: number, country: string, device: string) =>
    `${slug}|${variantId}|${tier1.has((country || '').toUpperCase()) ? 'tier1' : 'rest'}|${device || ''}`;
  for (const row of clicks.results || []) {
    const key = keyOf(row.slug, row.variant_id, row.country, row.device_type);
    const entry = map.get(key) || {
      slug: row.slug, variantId: row.variant_id,
      group: tier1.has((row.country || '').toUpperCase()) ? 'tier1' as const : 'rest' as const,
      device: row.device_type || '', clicks: 0, conversions: 0, revenueMinor: 0, epcMinor: 0,
    };
    entry.clicks += row.clicks;
    map.set(key, entry);
  }
  for (const row of conversions.results || []) {
    const key = keyOf(row.slug, row.variant_id, row.country, row.device_type);
    const entry = map.get(key);
    if (!entry) continue;
    entry.conversions += row.conversions;
    entry.revenueMinor += row.revenue;
  }
  for (const entry of map.values()) entry.epcMinor = entry.clicks ? Math.round(entry.revenueMinor / entry.clicks) : 0;
  return [...map.values()];
}

/** Per-variant score for the shift: Tier-1 EPC when the variant has
 * meaningful Tier-1 volume, otherwise its overall EPC. */
export function variantScores(table: EpcRow[], slug: string): Map<number, { clicks: number; epcMinor: number }> {
  const scores = new Map<number, { clicks: number; epcMinor: number; tier1Clicks: number; tier1Revenue: number }>();
  for (const row of table.filter(entry => entry.slug === slug)) {
    const entry = scores.get(row.variantId) || { clicks: 0, epcMinor: 0, tier1Clicks: 0, tier1Revenue: 0 };
    entry.clicks += row.clicks;
    if (row.group === 'tier1') { entry.tier1Clicks += row.clicks; entry.tier1Revenue += row.revenueMinor; }
    scores.set(row.variantId, entry);
  }
  const result = new Map<number, { clicks: number; epcMinor: number }>();
  for (const [variantId, entry] of scores) {
    // Overall revenue is needed for the non-Tier-1 fallback score.
    const totalRevenue = table.filter(row => row.slug === slug && row.variantId === variantId)
      .reduce((sum, row) => sum + row.revenueMinor, 0);
    const epc = entry.tier1Clicks >= 50
      ? Math.round(entry.tier1Revenue / entry.tier1Clicks)
      : (entry.clicks ? Math.round(totalRevenue / entry.clicks) : 0);
    result.set(variantId, { clicks: entry.clicks, epcMinor: epc });
  }
  return result;
}

export interface WeightShift { variantId: number; before: number; after: number }

/** Pure shift: best variant gains up to 20 points, taken proportionally
 * from the other movable variants. Locked / under-floor variants and
 * the best itself never lose. Weights stay integers summing to the
 * original total of the movable set + best. */
export function planShifts(
  variants: Array<{ id: number; weight: number; locked: number }>,
  scores: Map<number, { clicks: number; epcMinor: number }>,
  minClicks: number,
): WeightShift[] {
  const eligible = variants.filter(variant => (scores.get(variant.id)?.clicks || 0) >= minClicks);
  if (eligible.length < 2) return [];
  // Owner-locked variants never move — they can neither gain nor lose.
  const movable = eligible.filter(variant => !variant.locked);
  if (!movable.length) return [];
  const best = movable.reduce((winner, variant) =>
    (scores.get(variant.id)?.epcMinor || 0) > (scores.get(winner.id)?.epcMinor || 0) ? variant : winner, movable[0]);
  const losers = eligible.filter(variant => variant.id !== best.id && !variant.locked && variant.weight > 0);
  if (!losers.length) return [];
  const available = losers.reduce((sum, variant) => sum + variant.weight, 0);
  const gain = Math.min(20, available);
  if (gain <= 0) return [];
  const shifts: WeightShift[] = [{ variantId: best.id, before: best.weight, after: best.weight + gain }];
  let taken = 0;
  losers.forEach((variant, index) => {
    const share = index === losers.length - 1 ? gain - taken : Math.round((variant.weight / available) * gain);
    taken += share;
    if (share > 0) shifts.push({ variantId: variant.id, before: variant.weight, after: variant.weight - share });
  });
  return shifts;
}

export interface AutooptRun { linksChecked: number; proposals: Array<{ slug: string; shifts: WeightShift[]; applied: boolean }> }

export async function runAutoopt(env: { DB: D1Database; CONFIG: KVNamespace }): Promise<AutooptRun> {
  const cfg = await readTrackingConfig(env.DB);
  const links = await env.DB.prepare('SELECT slug FROM tr_link_settings WHERE autoopt=1').all<{ slug: string }>();
  const table = await computeEpcTable(env.DB, cfg.tier1Countries);
  const run: AutooptRun = { linksChecked: 0, proposals: [] };
  for (const { slug } of links.results || []) {
    run.linksChecked++;
    const variants = await env.DB.prepare('SELECT id, weight, locked FROM tr_link_variants WHERE link_slug=? AND active=1')
      .bind(slug).all<{ id: number; weight: number; locked: number }>();
    const rows = variants.results || [];
    if (rows.length < 2) continue;
    const shifts = planShifts(rows, variantScores(table, slug), cfg.autooptMinClicks);
    if (!shifts.length) continue;
    const applied = cfg.autooptApply;
    if (applied) {
      for (const shift of shifts) {
        await env.DB.prepare('UPDATE tr_link_variants SET weight=?, updated_at=? WHERE id=?')
          .bind(shift.after, new Date().toISOString().slice(0, 19).replace('T', ' '), shift.variantId).run();
      }
      await mirrorVariants(env, slug);
    }
    try {
      await env.DB.prepare("INSERT INTO admin_log(actor,entity,entity_id,after) VALUES('insight-jobs','autoopt',?,?)")
        .bind(slug, JSON.stringify({ applied, shifts, epc: table.filter(row => row.slug === slug) })).run();
    } catch { /* logging is best-effort */ }
    if (applied) {
      const summary = shifts.map(shift => `variant ${shift.variantId} ${shift.before}→${shift.after}`).join(', ');
      await raiseAlert(env, 'autoopt_applied', slug,
        `Auto-optimiser shifted weights on ${slug}: ${summary}. Details are in the admin log.`);
    }
    run.proposals.push({ slug, shifts, applied });
  }
  return run;
}
