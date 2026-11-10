-- Adsterra revenue snapshots, filled by the money checker (scripts/money_check.py).
-- One row per UTC stats day for the whole site, plus a per-placement split.
CREATE TABLE IF NOT EXISTS adsterra_days (
  date TEXT PRIMARY KEY,
  impressions INTEGER NOT NULL DEFAULT 0,
  clicks INTEGER NOT NULL DEFAULT 0,
  ctr REAL NOT NULL DEFAULT 0,
  cpm REAL NOT NULL DEFAULT 0,
  revenue REAL NOT NULL DEFAULT 0,
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE TABLE IF NOT EXISTS adsterra_formats (
  date TEXT NOT NULL,
  placement_id INTEGER NOT NULL,
  impressions INTEGER NOT NULL DEFAULT 0,
  clicks INTEGER NOT NULL DEFAULT 0,
  revenue REAL NOT NULL DEFAULT 0,
  PRIMARY KEY (date, placement_id)
);
