/**
 * ScreenPeek Insight — settings field definitions (F14).
 *
 * One definition drives both the admin Settings form (one field per row,
 * help text beside each, red star on the keys that matter) and the save
 * validation. `secretName` fields hold the NAME of a platform secret —
 * never a secret value.
 */
export type TrackingFieldKind = 'toggle' | 'number' | 'text' | 'json' | 'select' | 'secretName';
export interface TrackingField {
  key: string;
  label: string;
  help: string;
  kind: TrackingFieldKind;
  options?: string[];
  min?: number;
  max?: number;
  star?: boolean;
}

export const TRACKING_FIELDS: TrackingField[] = [
  { key: 'tracking_enabled', label: 'Tracking enabled', help: 'Master switch. Off = the whole Insight platform is dark: no capture, no beacon, no cookies, and /go/ behaves exactly as before.', kind: 'toggle', star: true },
  { key: 'tracking_mode', label: 'Tracking mode', help: 'full = clicks + page beacon. clicks = redirect capture only.', kind: 'select', options: ['full', 'clicks'] },
  { key: 'tracking_consent_mode', label: 'Consent mode', help: 'off = always collect. basic = honour GPC / Do-Not-Track signals. strict = additionally require the sp_consent opt-in cookie before fingerprint-tier signals.', kind: 'select', options: ['off', 'basic', 'strict'], star: true },
  { key: 'tracking_t2_enabled', label: 'Tier-2 signals (canvas / WebGL)', help: 'Off by default. When on, the beacon may collect canvas and WebGL hashes from visitors who opted in (strict consent).', kind: 'toggle' },
  { key: 'tracking_ip_mode', label: 'IP storage mode', help: 'full = store the whole address. masked = last octet zeroed (a.b.c.0). off = store nothing.', kind: 'select', options: ['full', 'masked', 'off'], star: true },
  { key: 'tracking_daily_cap', label: 'Daily raw-data cap', help: 'Maximum raw records (clicks + events + sessions) stored per UTC day. Aggregates keep counting after the cap.', kind: 'number', min: 100, max: 100000, star: true },
  { key: 'tracking_event_sample_pct', label: 'Event sampling %', help: 'Percentage of page events stored. 100 stores everything. Sampling never applies to clicks or conversions.', kind: 'number', min: 1, max: 100 },
  { key: 'tracking_pass_click_id', label: 'Pass click ID to destination', help: 'Appends the click ID to outgoing redirect URLs so networks can report it back.', kind: 'toggle' },
  { key: 'tracking_click_param_name', label: 'Click ID parameter name', help: 'The query parameter name used when passing the click ID (default sp_cid; some networks want cid or subid).', kind: 'text' },
  { key: 'tracking_tier1_countries', label: 'Tier-1 countries', help: 'Comma-separated country codes stored first when the daily cap fills. Everyone else is stored only under the fill rule.', kind: 'text', star: true },
  { key: 'tracking_fill_pct', label: 'Non-Tier-1 fill %', help: 'Non-Tier-1 rows are stored while the day is under this percentage of the cap.', kind: 'number', min: 0, max: 100 },
  { key: 'tracking_fill_after_hour_utc', label: 'Fill-after hour (UTC)', help: 'After this UTC hour, non-Tier-1 rows may fill the rest of the cap.', kind: 'number', min: 0, max: 23 },
  { key: 'tracking_retention_clicks_days', label: 'Retention — clicks (days)', help: 'Raw click rows older than this are purged by the retention job.', kind: 'number', min: 1, max: 3650 },
  { key: 'tracking_retention_events_days', label: 'Retention — events (days)', help: 'Raw page-event rows older than this are purged.', kind: 'number', min: 1, max: 3650 },
  { key: 'tracking_retention_sessions_days', label: 'Retention — sessions (days)', help: 'Session rows older than this are purged.', kind: 'number', min: 1, max: 3650 },
  { key: 'tracking_retention_postbacks_days', label: 'Retention — postback log (days)', help: 'Raw postback call log rows older than this are purged.', kind: 'number', min: 1, max: 3650 },
  { key: 'tracking_networks', label: 'Networks (JSON)', help: 'Per-network settings: {"network-name": {"secret_config_key": "TRACKING_PB_SECRET_X", "currency_default": "USD", "postback_url": "https://their.endpoint/pb?cid={click_id}&payout={payout}"}}. postback_url is the OUTGOING fire template (macros {click_id} {event} {payout} {currency} {txid} {sub1} {country} {device}); add "postback_url_by_slug": {"link-slug": "template"} to override it per link. Secret values live in platform secrets, never here.', kind: 'json' },
  { key: 'tracking_status_map', label: 'Status map (JSON)', help: 'Maps network status words to approved / pending / rejected / reversed: {"approved": ["paid", "confirmed"]}.', kind: 'json' },
  { key: 'tracking_postback_lenient', label: 'Lenient postback payouts', help: 'On = a postback with an unparseable payout is still stored, as payout 0, instead of rejected.', kind: 'toggle' },
  { key: 'tracking_quality_weights', label: 'Quality weights (JSON)', help: 'Points per quality signal and the review / likely_bad band thresholds: {"bot_ua": 60, "band_review": 20, "band_bad": 50}.', kind: 'json' },
  { key: 'tracking_quality_digest', label: 'Quality digest (reserved)', help: 'Reserved for the scheduled quality summary. No effect yet.', kind: 'toggle' },
  { key: 'tracking_quality_gate_enabled', label: 'Quality gate (safe page)', help: 'On = a click scoring 2+ quality signals is routed to the link\u2019s safe page (set per link in the Variants view) instead of the destination. Off = quality scores never affect routing.', kind: 'toggle' },
  { key: 'tracking_degraded', label: 'Quota degraded flag', help: 'Set automatically when the quota counter fails. Read-only in practice — clearing it manually re-arms the indicator.', kind: 'toggle' },
  { key: 'tracking_disguise_weights', label: 'Disguise weights (JSON)', help: 'Points subtracted per disguise signal for the consistency score: {"webrtc_mismatch": 30, "datacentre": 25}.', kind: 'json' },
  { key: 'tracking_rotation_sticky', label: 'Sticky rotation', help: 'On = a returning visitor keeps the same link variant (hash of the visitor ID). Off = every click re-rolls.', kind: 'toggle' },
  { key: 'tracking_autoopt_min_clicks', label: 'Auto-optimiser minimum clicks', help: 'A variant needs at least this many clicks in the window before its weight may move.', kind: 'number', min: 10, max: 100000 },
  { key: 'tracking_autoopt_apply', label: 'Auto-optimiser applies changes', help: 'Off = suggestion mode: the optimiser writes proposals to the audit log and changes nothing. On = it applies weight shifts itself (max 20 points per day, owner-locked variants never move).', kind: 'toggle' },
  { key: 'tracking_attribution_window_days', label: 'Attribution window (days)', help: 'A postback arriving later than this after the click is stored as late and excluded from EPC.', kind: 'number', min: 1, max: 365 },
  { key: 'tracking_attribution_mode', label: 'Attribution mode', help: 'last = the most recent click before the conversion gets credit. first = the earliest click in the window.', kind: 'select', options: ['last', 'first'] },
  { key: 'tracking_funnels', label: 'Funnels (JSON)', help: 'Named step sequences for the funnel view: {"signup": ["landing", "form", "done"]} — steps are page types or URL fragments.', kind: 'json' },
  { key: 'tracking_cost_rules', label: 'Cost rules (JSON)', help: 'CPC rules for profit maths, keyed by the click\u2019s source token (its sub1 value): {"promo-a": {"cpc_minor": 10, "currency": "USD"}}. The key "default" prices clicks that carry no sub1. Cost fills only for clicks whose token has a rule. Exact per-day costs can be imported as CSV in Tools.', kind: 'json' },
  { key: 'tracking_alert_channels', label: 'Alert channels', help: 'Where Insight alerts are sent: telegram (the money-bot chat), email, or both — comma-separated. Blank = alerts are recorded in Tracking → Alerts only. Note: this project has no email sender yet, so telegram is the channel that delivers today.', kind: 'text' },
  { key: 'tracking_report_day', label: 'Weekly report day', help: 'Day of the week the weekly summary is produced.', kind: 'select', options: ['monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday', 'sunday'] },
  { key: 'tracking_api_key', label: 'Reporting API key — secret NAME', help: 'The NAME of the platform secret that holds the reporting API key (for example TRACKING_API_KEY). The key value itself is never stored here; the API stays disabled until the secret exists.', kind: 'secretName' },
];

export const trackingField = (key: string) => TRACKING_FIELDS.find(field => field.key === key);
