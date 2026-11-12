// ScreenPeek Insight — traffic-quality flags (F9).
//
// FLAG-ONLY by design: flags inform the owner in the admin; nothing in
// the visitor path ever reads them to block, redirect or drop a click
// (the optional routing quality gate is F21 and ships disabled).
// Signals: bot UA, datacentre ASN org, low edge trust score (when the
// platform provides one), browser-vs-IP timezone mismatch (via the
// click's session), click velocity per IP, missing referrer on an
// on-site click. Weights and band thresholds are config-overridable.

export type QualityBand = 'clean' | 'review' | 'likely_bad';

export interface QualitySignals {
  isBotUa: boolean;
  connClass: string;
  trustScore: number | null;
  tzMismatch: boolean;
  velocityPerHour: number;
  noReferrerOnSiteClick: boolean;
}

export interface QualityVerdict { flags: string[]; band: QualityBand; score: number }

const DEFAULT_WEIGHTS: Record<string, number> = {
  bot_ua: 60, datacentre: 40, trust_low: 30, tz_mismatch: 25, velocity: 40, no_referrer: 10, vpn_proxy: 15,
};
export const DEFAULT_BAND_REVIEW = 20;
export const DEFAULT_BAND_BAD = 50;

/** Connection class from the ASN org string (shared with F16). */
export function connClassFromOrg(asOrg: string): string {
  const org = (asOrg || '').toLowerCase();
  if (!org) return 'unknown';
  if (/amazon|aws|google cloud|microsoft|azure|digitalocean|linode|vultr|ovh|hetzner|oracle cloud|alibaba|tencent|datacenter|data center|hosting|server|cloud/.test(org)) return 'datacentre';
  if (/vpn|proxy|tunnel|anonymous/.test(org)) return 'vpn';
  if (/mobile|wireless|cellular|telecom|broadband|cable|fiber|fibre|communications|internet services/.test(org)) return 'residential';
  return 'unknown';
}

export function parseWeights(raw: string): { weights: Record<string, number>; bandReview: number; bandBad: number } {
  let parsed: Record<string, unknown> = {};
  try { parsed = JSON.parse(raw || '{}') as Record<string, unknown>; } catch { parsed = {}; }
  const weights = { ...DEFAULT_WEIGHTS };
  for (const [key, value] of Object.entries(parsed)) {
    if (key !== 'band_review' && key !== 'band_bad' && typeof value === 'number' && Number.isFinite(value)) weights[key] = value;
  }
  const bandReview = typeof parsed.band_review === 'number' ? parsed.band_review : DEFAULT_BAND_REVIEW;
  const bandBad = typeof parsed.band_bad === 'number' ? parsed.band_bad : DEFAULT_BAND_BAD;
  return { weights, bandReview, bandBad };
}

export function flagsForSignals(signals: QualitySignals, weightsRaw: string): QualityVerdict {
  const { weights, bandReview, bandBad } = parseWeights(weightsRaw);
  const flags: string[] = [];
  if (signals.isBotUa) flags.push('bot_ua');
  if (signals.connClass === 'datacentre') flags.push('datacentre');
  if (signals.connClass === 'vpn' || signals.connClass === 'proxy') flags.push('vpn_proxy');
  if (signals.trustScore !== null && signals.trustScore < 30) flags.push('trust_low');
  if (signals.tzMismatch) flags.push('tz_mismatch');
  if (signals.velocityPerHour >= 30) flags.push('velocity');
  if (signals.noReferrerOnSiteClick) flags.push('no_referrer');
  const score = flags.reduce((sum, flag) => sum + (weights[flag] ?? 0), 0);
  const band: QualityBand = score >= bandBad ? 'likely_bad' : score >= bandReview ? 'review' : 'clean';
  return { flags, band, score };
}

/** Country a timezone belongs to, for the coarsest mismatch check. */
const TZ_COUNTRY: Record<string, string> = {
  'America/New_York': 'US', 'America/Chicago': 'US', 'America/Denver': 'US', 'America/Los_Angeles': 'US',
  'America/Phoenix': 'US', 'America/Anchorage': 'US', 'Pacific/Honolulu': 'US', 'America/Toronto': 'CA',
  'America/Vancouver': 'CA', 'Europe/London': 'GB', 'Australia/Sydney': 'AU', 'Australia/Perth': 'AU',
  'Australia/Melbourne': 'AU', 'Australia/Brisbane': 'AU', 'Asia/Dhaka': 'BD', 'Asia/Kolkata': 'IN',
  'Asia/Singapore': 'SG', 'Asia/Dubai': 'AE', 'Europe/Berlin': 'DE', 'Europe/Paris': 'FR',
};

export function tzCountryMismatch(browserTimezone: string, ipTimezone: string, country: string): boolean {
  const tz = browserTimezone || ipTimezone;
  if (!tz || !country) return false;
  const expected = TZ_COUNTRY[tz];
  return Boolean(expected && expected !== country.toUpperCase());
}

/** Gather a stored click's signals and return its verdict. */
export async function assessStoredClick(
  db: D1Database, clickId: string, weightsRaw: string,
): Promise<QualityVerdict | null> {
  const click = await db.prepare('SELECT * FROM tr_clicks WHERE click_id=?').bind(clickId).first<Record<string, unknown>>();
  if (!click) return null;
  let browserTimezone = '';
  if (click.session_id) {
    const session = await db.prepare('SELECT browser_timezone FROM tr_sessions WHERE session_id=?')
      .bind(String(click.session_id)).first<{ browser_timezone: string }>();
    browserTimezone = session?.browser_timezone || '';
  }
  let velocity = 0;
  if (click.ip) {
    const row = await db.prepare(
      "SELECT COUNT(*) AS count FROM tr_clicks WHERE ip=? AND ts >= datetime('now','-1 hour')",
    ).bind(String(click.ip)).first<{ count: number }>();
    velocity = row?.count ?? 0;
  }
  return flagsForSignals({
    isBotUa: Number(click.is_bot_ua || 0) === 1,
    connClass: connClassFromOrg(String(click.as_org || '')),
    trustScore: typeof click.trust_score === 'number' ? click.trust_score : null,
    tzMismatch: tzCountryMismatch(browserTimezone, String(click.ip_timezone || ''), String(click.country || '')),
    velocityPerHour: velocity,
    noReferrerOnSiteClick: Boolean(click.sp_page) && !click.referrer,
  }, weightsRaw);
}
