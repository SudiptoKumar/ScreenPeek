-- 012 — ScreenPeek Insight (in-house tracking), ADDITIVE ONLY.
-- Built from the Insight v3 package schema template with ONE adaptation:
-- links are identified by slug everywhere in this codebase (links.slug is
-- the primary key; click_log and tr_clicks both key by slug), so the
-- template's link_id columns are link_slug TEXT here. Rowids are not
-- stable across backup/restore; slugs are.
-- Idempotent: safe to re-run. No existing table is altered.
-- ScreenPeek Insight v3 — tracking schema (ADDITIVE ONLY)
-- v2 note: raw storage is governed by the quota engine (PRD §5):
-- 3,000 raw rows/day, Tier-1 countries first, fill-up rule for the rest.
-- Aggregates + conversions are never capped.
-- Apply as the NEXT numbered file in db/migrations/ (check the repo for the
-- highest existing number; do not assume). Idempotent: safe to re-run.
-- No existing table is altered. Money is integer minor units. Times are UTC ISO.

CREATE TABLE IF NOT EXISTS tr_clicks (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  click_id      TEXT NOT NULL UNIQUE,
  ts            TEXT NOT NULL DEFAULT (datetime('now')),
  slug          TEXT NOT NULL,
  link_name     TEXT NOT NULL DEFAULT '',
  link_type     TEXT NOT NULL DEFAULT '',
  destination   TEXT NOT NULL DEFAULT '',
  dest_host     TEXT NOT NULL DEFAULT '',
  route_reason  TEXT NOT NULL DEFAULT 'default',
  ip            TEXT NOT NULL DEFAULT '',
  country       TEXT NOT NULL DEFAULT '',
  region        TEXT NOT NULL DEFAULT '',
  city          TEXT NOT NULL DEFAULT '',
  continent     TEXT NOT NULL DEFAULT '',
  postal_code   TEXT NOT NULL DEFAULT '',
  lat           REAL,
  lon           REAL,
  ip_timezone   TEXT NOT NULL DEFAULT '',
  asn           INTEGER,
  as_org        TEXT NOT NULL DEFAULT '',
  http_protocol TEXT NOT NULL DEFAULT '',
  tls_version   TEXT NOT NULL DEFAULT '',
  trust_score   INTEGER,
  ua_raw        TEXT NOT NULL DEFAULT '',
  browser       TEXT NOT NULL DEFAULT '',
  browser_major TEXT NOT NULL DEFAULT '',
  os            TEXT NOT NULL DEFAULT '',
  os_version    TEXT NOT NULL DEFAULT '',
  device_type   TEXT NOT NULL DEFAULT '',
  device_brand  TEXT NOT NULL DEFAULT '',
  device_model  TEXT NOT NULL DEFAULT '',
  language      TEXT NOT NULL DEFAULT '',
  referrer      TEXT NOT NULL DEFAULT '',
  referrer_domain TEXT NOT NULL DEFAULT '',
  referrer_class  TEXT NOT NULL DEFAULT '',
  visitor_id    TEXT NOT NULL DEFAULT '',
  session_id    TEXT NOT NULL DEFAULT '',
  utm_source    TEXT NOT NULL DEFAULT '',
  utm_medium    TEXT NOT NULL DEFAULT '',
  utm_campaign  TEXT NOT NULL DEFAULT '',
  utm_content   TEXT NOT NULL DEFAULT '',
  utm_term      TEXT NOT NULL DEFAULT '',
  sub1 TEXT NOT NULL DEFAULT '', sub2 TEXT NOT NULL DEFAULT '',
  sub3 TEXT NOT NULL DEFAULT '', sub4 TEXT NOT NULL DEFAULT '',
  sub5 TEXT NOT NULL DEFAULT '',
  sp_page       TEXT NOT NULL DEFAULT '',
  sp_title      TEXT NOT NULL DEFAULT '',
  is_bot_ua     INTEGER NOT NULL DEFAULT 0,
  is_test       INTEGER NOT NULL DEFAULT 0,
  quality_band  TEXT NOT NULL DEFAULT '',
  quality_flags TEXT NOT NULL DEFAULT '[]',
  variant_id       INTEGER,
  conn_class       TEXT NOT NULL DEFAULT '',
  disguise_score   INTEGER,
  disguise_reasons TEXT NOT NULL DEFAULT '[]'
);
CREATE INDEX IF NOT EXISTS idx_tr_clicks_ts       ON tr_clicks(ts);
CREATE INDEX IF NOT EXISTS idx_tr_clicks_slug_ts  ON tr_clicks(slug, ts);
CREATE INDEX IF NOT EXISTS idx_tr_clicks_ctry_ts  ON tr_clicks(country, ts);
CREATE INDEX IF NOT EXISTS idx_tr_clicks_visitor  ON tr_clicks(visitor_id, ts);
CREATE INDEX IF NOT EXISTS idx_tr_clicks_ip_ts    ON tr_clicks(ip, ts);

CREATE TABLE IF NOT EXISTS tr_events (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  ts_received   TEXT NOT NULL DEFAULT (datetime('now')),
  session_id    TEXT NOT NULL DEFAULT '',
  visitor_id    TEXT NOT NULL DEFAULT '',
  page_url      TEXT NOT NULL DEFAULT '',
  page_type     TEXT NOT NULL DEFAULT '',
  title_id      TEXT NOT NULL DEFAULT '',
  event_type    TEXT NOT NULL DEFAULT 'pageview',
  referrer      TEXT NOT NULL DEFAULT '',
  screen_w INTEGER, screen_h INTEGER, avail_w INTEGER, avail_h INTEGER,
  viewport_w INTEGER, viewport_h INTEGER,
  dpr REAL, color_depth INTEGER,
  orientation   TEXT NOT NULL DEFAULT '',
  browser_timezone TEXT NOT NULL DEFAULT '',
  languages     TEXT NOT NULL DEFAULT '',
  cpu_cores     INTEGER,
  ram_bucket_gb REAL,
  touch_points  INTEGER,
  connection_type TEXT NOT NULL DEFAULT '',
  downlink_mbps REAL, rtt_ms INTEGER, save_data INTEGER,
  dark_mode INTEGER, reduced_motion INTEGER,
  webgl_renderer TEXT NOT NULL DEFAULT '',
  canvas_hash   TEXT NOT NULL DEFAULT '',
  payload_json  TEXT NOT NULL DEFAULT '{}',
  is_test       INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX IF NOT EXISTS idx_tr_events_session ON tr_events(session_id);
CREATE INDEX IF NOT EXISTS idx_tr_events_ts      ON tr_events(ts_received);
CREATE INDEX IF NOT EXISTS idx_tr_events_page_ts ON tr_events(page_type, ts_received);

CREATE TABLE IF NOT EXISTS tr_sessions (
  session_id    TEXT PRIMARY KEY,
  visitor_id    TEXT NOT NULL DEFAULT '',
  started_at    TEXT NOT NULL,
  last_seen_at  TEXT NOT NULL,
  pageviews     INTEGER NOT NULL DEFAULT 0,
  max_scroll_pct INTEGER NOT NULL DEFAULT 0,
  total_duration_s INTEGER NOT NULL DEFAULT 0,
  entry_page    TEXT NOT NULL DEFAULT '',
  exit_page     TEXT NOT NULL DEFAULT '',
  device_type   TEXT NOT NULL DEFAULT '',
  country       TEXT NOT NULL DEFAULT '',
  browser       TEXT NOT NULL DEFAULT '',
  os            TEXT NOT NULL DEFAULT '',
  screen_w INTEGER, screen_h INTEGER,
  browser_timezone TEXT NOT NULL DEFAULT '',
  go_clicks     INTEGER NOT NULL DEFAULT 0,
  is_test       INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX IF NOT EXISTS idx_tr_sessions_visitor ON tr_sessions(visitor_id);
CREATE INDEX IF NOT EXISTS idx_tr_sessions_started ON tr_sessions(started_at);

CREATE TABLE IF NOT EXISTS tr_page_daily (
  day TEXT NOT NULL, page_type TEXT NOT NULL DEFAULT '', page_url TEXT NOT NULL,
  pageviews INTEGER NOT NULL DEFAULT 0,
  unique_sessions INTEGER NOT NULL DEFAULT 0,
  avg_duration_s REAL NOT NULL DEFAULT 0,
  avg_max_scroll_pct REAL NOT NULL DEFAULT 0,
  cta_clicks INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (day, page_type, page_url)
);

CREATE TABLE IF NOT EXISTS tr_click_daily (
  day TEXT NOT NULL, slug TEXT NOT NULL, country TEXT NOT NULL DEFAULT '',
  device_type TEXT NOT NULL DEFAULT '', dest_host TEXT NOT NULL DEFAULT '',
  currency TEXT NOT NULL DEFAULT '',
  clicks INTEGER NOT NULL DEFAULT 0,
  unique_visitors INTEGER NOT NULL DEFAULT 0,
  conversions INTEGER NOT NULL DEFAULT 0,
  revenue_minor INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (day, slug, country, device_type, dest_host, currency)
);

CREATE TABLE IF NOT EXISTS tr_conversions (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  click_id      TEXT NOT NULL,
  network       TEXT NOT NULL DEFAULT '',
  event         TEXT NOT NULL DEFAULT 'conversion',
  payout_minor  INTEGER NOT NULL DEFAULT 0,
  currency      TEXT NOT NULL DEFAULT 'USD',
  status_mapped TEXT NOT NULL DEFAULT 'pending',
  status_raw    TEXT NOT NULL DEFAULT '',
  txid          TEXT NOT NULL DEFAULT '',
  ts_received   TEXT NOT NULL DEFAULT (datetime('now')),
  conversion_ts TEXT,
  em_hash       TEXT NOT NULL DEFAULT '',
  ph_hash       TEXT NOT NULL DEFAULT '',
  is_test       INTEGER NOT NULL DEFAULT 0,
  UNIQUE (click_id, txid, event)
);
CREATE INDEX IF NOT EXISTS idx_tr_conv_click ON tr_conversions(click_id);
CREATE INDEX IF NOT EXISTS idx_tr_conv_ts    ON tr_conversions(ts_received);

-- v3 additions (F18-F26)
CREATE TABLE IF NOT EXISTS tr_link_variants (
  id INTEGER PRIMARY KEY, link_slug TEXT NOT NULL DEFAULT '',
  dest_url TEXT NOT NULL DEFAULT '', weight INTEGER NOT NULL DEFAULT 100,
  chain_order INTEGER NOT NULL DEFAULT 0, active INTEGER NOT NULL DEFAULT 1,
  cap_clicks_day INTEGER NOT NULL DEFAULT 0, cap_conv_day INTEGER NOT NULL DEFAULT 0,
  schedule TEXT NOT NULL DEFAULT '', note TEXT NOT NULL DEFAULT '',
  created_at TEXT NOT NULL DEFAULT '', updated_at TEXT NOT NULL DEFAULT ''
);
CREATE INDEX IF NOT EXISTS idx_tr_var_link ON tr_link_variants(link_slug, active);
CREATE TABLE IF NOT EXISTS tr_postbacks_out (
  id INTEGER PRIMARY KEY, conversion_id INTEGER, network TEXT NOT NULL DEFAULT '',
  url_host TEXT NOT NULL DEFAULT '', status TEXT NOT NULL DEFAULT 'queued',
  http_status INTEGER, attempts INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL DEFAULT '', last_try_at TEXT NOT NULL DEFAULT ''
);
CREATE TABLE IF NOT EXISTS tr_cost_daily (
  day TEXT NOT NULL, link_slug TEXT NOT NULL DEFAULT '', source TEXT NOT NULL DEFAULT '',
  cost_minor INTEGER NOT NULL DEFAULT 0, currency TEXT NOT NULL DEFAULT 'USD',
  PRIMARY KEY (day, link_slug, source, currency)
);
CREATE TABLE IF NOT EXISTS tr_alerts (
  id INTEGER PRIMARY KEY, day TEXT NOT NULL DEFAULT '', kind TEXT NOT NULL DEFAULT '',
  ref TEXT NOT NULL DEFAULT '', message TEXT NOT NULL DEFAULT '', sent INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL DEFAULT ''
);
CREATE TABLE IF NOT EXISTS tr_link_health (
  link_slug TEXT NOT NULL DEFAULT '', url TEXT NOT NULL DEFAULT '', day TEXT NOT NULL DEFAULT '',
  ok INTEGER NOT NULL DEFAULT 1, http_status INTEGER, checked_at TEXT NOT NULL DEFAULT '',
  PRIMARY KEY (link_slug, url, day)
);

CREATE TABLE IF NOT EXISTS tr_postbacks_raw (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  ts TEXT NOT NULL DEFAULT (datetime('now')),
  network TEXT NOT NULL DEFAULT '',
  ip TEXT NOT NULL DEFAULT '',
  params_json TEXT NOT NULL DEFAULT '{}',
  result TEXT NOT NULL DEFAULT '',
  reason TEXT NOT NULL DEFAULT ''
);
CREATE INDEX IF NOT EXISTS idx_tr_pb_ts ON tr_postbacks_raw(ts);

CREATE TABLE IF NOT EXISTS tr_export_jobs (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  created_by TEXT NOT NULL DEFAULT '',
  dataset TEXT NOT NULL DEFAULT '',
  filters_json TEXT NOT NULL DEFAULT '{}',
  columns_json TEXT NOT NULL DEFAULT '[]',
  format TEXT NOT NULL DEFAULT 'csv',
  status TEXT NOT NULL DEFAULT 'queued',
  row_count INTEGER,
  size_bytes INTEGER,
  r2_key TEXT NOT NULL DEFAULT '',
  error TEXT NOT NULL DEFAULT '',
  expires_at TEXT
);
CREATE INDEX IF NOT EXISTS idx_tr_exp_created ON tr_export_jobs(created_at);

-- Default config (names + defaults only; secrets are NEVER stored here)
INSERT OR IGNORE INTO config (key, value) VALUES
  ('tracking_enabled','0'),
  ('tracking_mode','full'),
  ('tracking_consent_mode','basic'),
  ('tracking_t2_enabled','0'),
  ('tracking_ip_mode','masked'),
  ('tracking_daily_cap','3000'),
  ('tracking_event_sample_pct','100'),
  ('tracking_pass_click_id','1'),
  ('tracking_click_param_name','sp_cid'),
  ('tracking_retention_clicks_days','90'),
  ('tracking_retention_events_days','30'),
  ('tracking_retention_sessions_days','90'),
  ('tracking_retention_postbacks_days','30'),
  ('tracking_networks','{}'),
  ('tracking_status_map','{}'),
  ('tracking_quality_weights','{}'),
  ('tracking_quality_digest','0'),
  ('tracking_quality_gate_enabled','0'),
  ('tracking_postback_lenient','0'),
  ('tracking_degraded','0'),
  ('tracking_tier1_countries','US,GB,CA,AU'),
  ('tracking_fill_pct','80'),
  ('tracking_fill_after_hour_utc','20'),
  ('tracking_disguise_weights','{}'),
  ('tracking_rotation_sticky','1'),
  ('tracking_autoopt_min_clicks','200'),
  ('tracking_autoopt_apply','0'),
  ('tracking_attribution_window_days','30'),
  ('tracking_attribution_mode','last'),
  ('tracking_funnels','{}'),
  ('tracking_cost_rules','{}'),
  ('tracking_alert_channels',''),
  ('tracking_report_day','monday'),
  ('tracking_api_key','');
