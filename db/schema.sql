-- Movie System — Cloudflare D1 schema v1
-- Apply: wrangler d1 execute movie-db --remote --file=db/schema.sql
-- Additive-only changes in v1. See docs/DATA-MODEL.md for the rationale.

PRAGMA foreign_keys = ON;

CREATE TABLE IF NOT EXISTS titles (
  id            INTEGER NOT NULL,
  type          TEXT NOT NULL CHECK (type IN ('movie','tv')),
  slug          TEXT NOT NULL UNIQUE,
  title         TEXT NOT NULL,
  original_title TEXT,
  overview      TEXT,
  release_date  TEXT,
  year          INTEGER,
  runtime_min   INTEGER,
  status        TEXT,
  original_language TEXT,
  popularity    REAL NOT NULL DEFAULT 0,
  vote_average  REAL,
  vote_count    INTEGER,
  imdb_id       TEXT,
  poster_r2     TEXT,
  backdrop_r2   TEXT,
  poster_color  TEXT,
  og_r2         TEXT,
  genres        TEXT NOT NULL DEFAULT '[]',   -- JSON array of genre slugs
  similar_ids   TEXT NOT NULL DEFAULT '[]',   -- JSON array of TMDb ids
  trailer_key   TEXT,                          -- YouTube video key
  quality_gate  INTEGER NOT NULL DEFAULT 0,
  hidden        INTEGER NOT NULL DEFAULT 0,
  deleted       INTEGER NOT NULL DEFAULT 0,
  deleted_at    TEXT,
  locked_fields TEXT NOT NULL DEFAULT '[]',
  pinned        INTEGER NOT NULL DEFAULT 0,
  views         INTEGER NOT NULL DEFAULT 0,
  added_at      TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at    TEXT NOT NULL DEFAULT (datetime('now')),
  PRIMARY KEY (id, type)
);
CREATE INDEX IF NOT EXISTS idx_titles_pop   ON titles (type, popularity DESC);
CREATE INDEX IF NOT EXISTS idx_titles_date  ON titles (type, release_date DESC);
CREATE INDEX IF NOT EXISTS idx_titles_added ON titles (added_at DESC);
CREATE INDEX IF NOT EXISTS idx_titles_gate  ON titles (quality_gate, popularity DESC);

CREATE TABLE IF NOT EXISTS people (
  id          INTEGER PRIMARY KEY,
  slug        TEXT NOT NULL UNIQUE,
  name        TEXT NOT NULL,
  bio         TEXT,
  profile_r2  TEXT,
  popularity  REAL NOT NULL DEFAULT 0,
  locked_fields TEXT NOT NULL DEFAULT '[]',
  deleted_at  TEXT,
  updated_at  TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS credits (
  title_id    INTEGER NOT NULL,
  title_type  TEXT NOT NULL,
  person_id   INTEGER NOT NULL,
  role        TEXT NOT NULL CHECK (role IN ('cast','director','creator')),
  character   TEXT,
  ord         INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (title_id, title_type, person_id, role)
);
CREATE INDEX IF NOT EXISTS idx_credits_person ON credits (person_id);
CREATE INDEX IF NOT EXISTS idx_credits_title  ON credits (title_id, title_type, ord);

CREATE TABLE IF NOT EXISTS seasons (
  title_id      INTEGER NOT NULL,
  season_number INTEGER NOT NULL,
  name          TEXT,
  episode_count INTEGER,
  air_date      TEXT,
  PRIMARY KEY (title_id, season_number)
);

CREATE TABLE IF NOT EXISTS episodes (
  title_id      INTEGER NOT NULL,
  season_number INTEGER NOT NULL,
  episode_number INTEGER NOT NULL,
  name          TEXT,
  overview      TEXT,
  air_date      TEXT,
  still_r2      TEXT,
  PRIMARY KEY (title_id, season_number, episode_number)
);

CREATE TABLE IF NOT EXISTS providers (
  title_id      INTEGER NOT NULL,
  title_type    TEXT NOT NULL,
  country       TEXT NOT NULL,
  provider_id   INTEGER NOT NULL,
  provider_name TEXT NOT NULL,
  logo_r2       TEXT,
  offer_type    TEXT NOT NULL CHECK (offer_type IN ('stream','rent','buy','free','ads')),
  PRIMARY KEY (title_id, title_type, country, provider_id, offer_type)
);
CREATE INDEX IF NOT EXISTS idx_providers_lookup ON providers (title_id, title_type, country);
CREATE INDEX IF NOT EXISTS idx_providers_page   ON providers (provider_id, country, title_type);

CREATE TABLE IF NOT EXISTS releases (
  title_id      INTEGER NOT NULL,
  title_type    TEXT NOT NULL,
  country       TEXT NOT NULL,
  release_date  TEXT,
  certification TEXT,
  PRIMARY KEY (title_id, title_type, country)
);

CREATE TABLE IF NOT EXISTS genres (
  slug TEXT PRIMARY KEY, name TEXT NOT NULL, title_count INTEGER NOT NULL DEFAULT 0
);
CREATE TABLE IF NOT EXISTS collections (
  slug TEXT PRIMARY KEY, name TEXT NOT NULL, title_count INTEGER NOT NULL DEFAULT 0
);
CREATE TABLE IF NOT EXISTS languages (
  slug TEXT PRIMARY KEY, name TEXT NOT NULL, title_count INTEGER NOT NULL DEFAULT 0
);

CREATE TABLE IF NOT EXISTS links (
  slug         TEXT PRIMARY KEY,
  name         TEXT NOT NULL,
  destination  TEXT NOT NULL,
  type         TEXT NOT NULL DEFAULT 'other',
  enabled      INTEGER NOT NULL DEFAULT 1,
  rules        TEXT NOT NULL DEFAULT '{}',   -- JSON: byCountry/byDevice/split
  clicks_total INTEGER NOT NULL DEFAULT 0,
  clicks_today INTEGER NOT NULL DEFAULT 0,
  clicks_day   TEXT,
  starts_at    TEXT,
  ends_at      TEXT,
  updated_at   TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS ad_slots (
  page_type TEXT NOT NULL,
  placement TEXT NOT NULL,
  code      TEXT NOT NULL DEFAULT '',
  enabled   INTEGER NOT NULL DEFAULT 0,
  starts_at TEXT,
  ends_at   TEXT,
  PRIMARY KEY (page_type, placement)
);

CREATE TABLE IF NOT EXISTS config (
  key TEXT PRIMARY KEY, value TEXT NOT NULL DEFAULT ''
);
INSERT OR IGNORE INTO config (key, value) VALUES
  ('site_name',''), ('site_tagline',''), ('popunder_cap_hours','24'),
  ('ratings_external','0'), ('maintenance','0'), ('analytics_id',''),
  ('telegram_channel',''), ('sync_popularity_gate','10'),
  ('sync_max_titles','2000'), ('telegram_post_cap','5'),
  ('static_top_n','3000'), ('google_site_verification',''),
  ('bing_site_verification','');

CREATE TABLE IF NOT EXISTS votes (
  title_id   INTEGER NOT NULL,
  title_type TEXT NOT NULL,
  choice     TEXT NOT NULL CHECK (choice IN ('must','good','average','skip')),
  count      INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (title_id, title_type, choice)
);

CREATE TABLE IF NOT EXISTS click_log (
  slug    TEXT NOT NULL,
  day     TEXT NOT NULL,
  country TEXT NOT NULL DEFAULT '',
  device  TEXT NOT NULL DEFAULT '',
  dest    TEXT NOT NULL DEFAULT '',
  count   INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (slug, day, country, device, dest)
);

CREATE TABLE IF NOT EXISTS sync_log (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  started_at  TEXT NOT NULL,
  finished_at TEXT,
  status      TEXT NOT NULL DEFAULT 'running',
  added       INTEGER NOT NULL DEFAULT 0,
  updated     INTEGER NOT NULL DEFAULT 0,
  errors      TEXT,
  source      TEXT NOT NULL DEFAULT 'cron'
);

CREATE TABLE IF NOT EXISTS ratings_ext (
  title_id   INTEGER NOT NULL,
  title_type TEXT NOT NULL,
  imdb       REAL, rt INTEGER, metacritic INTEGER,
  fetched_at TEXT,
  PRIMARY KEY (title_id, title_type)
);

CREATE TABLE IF NOT EXISTS redirects (
  from_path  TEXT PRIMARY KEY,
  to_target  TEXT NOT NULL,
  type       INTEGER NOT NULL DEFAULT 301,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS seo_overrides (
  path    TEXT PRIMARY KEY,
  title   TEXT,
  noindex INTEGER NOT NULL DEFAULT 0
);

CREATE TABLE IF NOT EXISTS notfound_log (
  path      TEXT PRIMARY KEY,
  count     INTEGER NOT NULL DEFAULT 1,
  last_seen TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS admin_log (
  id        INTEGER PRIMARY KEY AUTOINCREMENT,
  ts        TEXT NOT NULL DEFAULT (datetime('now')),
  actor     TEXT,
  entity    TEXT NOT NULL,
  entity_id TEXT NOT NULL,
  before    TEXT,
  after     TEXT
);

-- ── Admin suite v3 (see docs/ADMIN-PANEL.md) ──
CREATE TABLE IF NOT EXISTS blocklist (
  tmdb_id    INTEGER NOT NULL,
  type       TEXT NOT NULL,
  reason     TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  PRIMARY KEY (tmdb_id, type)
);

CREATE TABLE IF NOT EXISTS admin_users (
  email      TEXT PRIMARY KEY,
  role       TEXT NOT NULL DEFAULT 'viewer' CHECK (role IN ('owner','editor','ads','viewer')),
  modules    TEXT NOT NULL DEFAULT '{}',
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS pages (
  slug      TEXT PRIMARY KEY,
  title     TEXT NOT NULL DEFAULT '',
  body_md   TEXT NOT NULL DEFAULT '',
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS inbox (
  id        INTEGER PRIMARY KEY AUTOINCREMENT,
  ts        TEXT NOT NULL DEFAULT (datetime('now')),
  kind      TEXT NOT NULL CHECK (kind IN ('contact','takedown')),
  name      TEXT, email TEXT, message TEXT NOT NULL,
  title_ref TEXT,
  status    TEXT NOT NULL DEFAULT 'new' CHECK (status IN ('new','done','dismissed'))
);

CREATE TABLE IF NOT EXISTS search_log (
  day     TEXT NOT NULL,
  query   TEXT NOT NULL,
  results INTEGER NOT NULL DEFAULT 0,
  count   INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (day, query)
);

CREATE TABLE IF NOT EXISTS taxonomy_overrides (
  kind         TEXT NOT NULL,
  slug         TEXT NOT NULL,
  display_name TEXT,
  ord          INTEGER NOT NULL DEFAULT 0,
  hidden       INTEGER NOT NULL DEFAULT 0,
  intro        TEXT,
  PRIMARY KEY (kind, slug)
);
CREATE INDEX IF NOT EXISTS idx_admin_log_ts ON admin_log (ts DESC);

-- Full-text search over titles (kept in step by sync)
CREATE VIRTUAL TABLE IF NOT EXISTS titles_fts USING fts5(
  title, slug, year, type, tokenize = 'unicode61'
);
