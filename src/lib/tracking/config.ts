// ScreenPeek Insight — tracking configuration.
//
// Every Insight behaviour is driven by `tracking_*` rows in the existing
// config table (seeded by db/migrations/012-tracking.sql). The master
// switch is tracking_enabled: while it is '0' the module is dark and the
// site behaves exactly as it did before Insight existed. Defaults here
// mirror the migration seeds exactly, so a missing row can never change
// behaviour.

export const TRACKING_DEFAULTS: Record<string, string> = {
  tracking_enabled: '0',
  tracking_mode: 'full',
  tracking_consent_mode: 'basic',
  tracking_t2_enabled: '0',
  tracking_ip_mode: 'masked',
  tracking_daily_cap: '3000',
  tracking_event_sample_pct: '100',
  tracking_pass_click_id: '1',
  tracking_click_param_name: 'sp_cid',
  tracking_retention_clicks_days: '90',
  tracking_retention_events_days: '30',
  tracking_retention_sessions_days: '90',
  tracking_retention_postbacks_days: '30',
  tracking_networks: '{}',
  tracking_status_map: '{}',
  tracking_quality_weights: '{}',
  tracking_quality_digest: '0',
  tracking_postback_lenient: '0',
  tracking_degraded: '0',
  tracking_tier1_countries: 'US,GB,CA,AU',
  tracking_fill_pct: '80',
  tracking_fill_after_hour_utc: '20',
  tracking_disguise_weights: '{}',
  tracking_rotation_sticky: '1',
  tracking_autoopt_min_clicks: '200',
  tracking_autoopt_apply: '0',
  tracking_attribution_window_days: '30',
  tracking_attribution_mode: 'last',
  tracking_funnels: '{}',
  tracking_cost_rules: '{}',
  tracking_alert_channels: '',
  tracking_report_day: 'monday',
  tracking_api_key: '',
};

export interface TrackingConfig {
  enabled: boolean;
  mode: string;
  consentMode: string;
  t2Enabled: boolean;
  ipMode: 'full' | 'masked' | 'off';
  dailyCap: number;
  eventSamplePct: number;
  passClickId: boolean;
  clickParamName: string;
  retentionClicksDays: number;
  retentionEventsDays: number;
  retentionSessionsDays: number;
  retentionPostbacksDays: number;
  networksJson: string;
  statusMapJson: string;
  qualityWeightsJson: string;
  qualityDigest: boolean;
  postbackLenient: boolean;
  degraded: boolean;
  tier1Countries: string[];
  fillPct: number;
  fillAfterHourUtc: number;
  disguiseWeightsJson: string;
  rotationSticky: boolean;
  autooptMinClicks: number;
  autooptApply: boolean;
  attributionWindowDays: number;
  attributionMode: 'first' | 'last';
  funnelsJson: string;
  costRulesJson: string;
  alertChannels: string;
  reportDay: string;
}

const flag = (value: string) => value === '1';
const num = (value: string, fallback: number) => {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : fallback;
};

export function parseTrackingConfig(rows: Record<string, string>): TrackingConfig {
  const get = (key: string) => rows[key] ?? TRACKING_DEFAULTS[key] ?? '';
  const ipMode = get('tracking_ip_mode');
  return {
    enabled: flag(get('tracking_enabled')),
    mode: get('tracking_mode') || 'full',
    consentMode: get('tracking_consent_mode') || 'basic',
    t2Enabled: flag(get('tracking_t2_enabled')),
    ipMode: ipMode === 'full' || ipMode === 'off' ? ipMode : 'masked',
    dailyCap: Math.max(1, Math.floor(num(get('tracking_daily_cap'), 3000))),
    eventSamplePct: Math.min(100, Math.max(0, num(get('tracking_event_sample_pct'), 100))),
    passClickId: flag(get('tracking_pass_click_id')),
    clickParamName: get('tracking_click_param_name') || 'sp_cid',
    retentionClicksDays: num(get('tracking_retention_clicks_days'), 90),
    retentionEventsDays: num(get('tracking_retention_events_days'), 30),
    retentionSessionsDays: num(get('tracking_retention_sessions_days'), 90),
    retentionPostbacksDays: num(get('tracking_retention_postbacks_days'), 30),
    networksJson: get('tracking_networks') || '{}',
    statusMapJson: get('tracking_status_map') || '{}',
    qualityWeightsJson: get('tracking_quality_weights') || '{}',
    qualityDigest: flag(get('tracking_quality_digest')),
    postbackLenient: flag(get('tracking_postback_lenient')),
    degraded: flag(get('tracking_degraded')),
    tier1Countries: get('tracking_tier1_countries').split(',').map(part => part.trim().toUpperCase()).filter(Boolean),
    fillPct: Math.min(100, Math.max(0, num(get('tracking_fill_pct'), 80))),
    fillAfterHourUtc: Math.min(23, Math.max(0, Math.floor(num(get('tracking_fill_after_hour_utc'), 20)))),
    disguiseWeightsJson: get('tracking_disguise_weights') || '{}',
    rotationSticky: flag(get('tracking_rotation_sticky')),
    autooptMinClicks: num(get('tracking_autoopt_min_clicks'), 200),
    autooptApply: flag(get('tracking_autoopt_apply')),
    attributionWindowDays: num(get('tracking_attribution_window_days'), 30),
    attributionMode: get('tracking_attribution_mode') === 'first' ? 'first' : 'last',
    funnelsJson: get('tracking_funnels') || '{}',
    costRulesJson: get('tracking_cost_rules') || '{}',
    alertChannels: get('tracking_alert_channels'),
    reportDay: get('tracking_report_day') || 'monday',
  };
}

/** Read every tracking_* config row and parse it. One indexed query. */
export async function readTrackingConfig(db: D1Database): Promise<TrackingConfig> {
  const result = await db.prepare("SELECT key, value FROM config WHERE key LIKE 'tracking_%'").all<{ key: string; value: string }>();
  const rows: Record<string, string> = {};
  for (const row of result.results || []) rows[row.key] = row.value;
  return parseTrackingConfig(rows);
}

/** One config value, KV mirror first (the admin save path mirrors every
 * config write to `config:<key>`), D1 fallback — the ads.ts pattern. */
export async function readTrackingValue(env: { DB: D1Database; CONFIG: KVNamespace }, key: string): Promise<string | null> {
  try {
    const value = await env.CONFIG.get(`config:${key}`);
    if (value !== null) return value;
  } catch { /* D1 fallback below. */ }
  return (await env.DB.prepare('SELECT value FROM config WHERE key=?').bind(key).first<{ value: string }>())?.value ?? null;
}

/** Hot-path master switch: a single KV/D1 read, safe to call per click. */
export async function trackingEnabledFast(env: { DB: D1Database; CONFIG: KVNamespace }): Promise<boolean> {
  try { return (await readTrackingValue(env, 'tracking_enabled')) === '1'; } catch { return false; }
}

/**
 * Several config values in at most one D1 query: KV mirror first per key
 * (admin saves mirror every write), one IN-query for the misses. Keeps
 * the /go/ response path inside its latency budget (gate G3.6).
 */
export async function readTrackingValues(env: { DB: D1Database; CONFIG: KVNamespace }, keys: string[]): Promise<Record<string, string | null>> {
  const out: Record<string, string | null> = {};
  const missing: string[] = [];
  await Promise.all(keys.map(async key => {
    try { out[key] = await env.CONFIG.get(`config:${key}`); } catch { out[key] = null; }
    if (out[key] === null) missing.push(key);
  }));
  if (missing.length) {
    try {
      const placeholders = missing.map(() => '?').join(',');
      const result = await env.DB.prepare(`SELECT key, value FROM config WHERE key IN (${placeholders})`).bind(...missing).all<{ key: string; value: string }>();
      for (const row of result.results || []) out[row.key] = row.value;
    } catch { /* callers treat null as the default */ }
  }
  return out;
}
