-- ScreenPeek Insight — migration 013: routing additions (F20/F21).
-- Additive only: one Insight-owned link-settings table (the base links
-- table is never altered) and the quality-gate switch F21 references.
-- Idempotent: safe to re-run.

CREATE TABLE IF NOT EXISTS tr_link_settings (
  slug TEXT PRIMARY KEY,
  autoopt INTEGER NOT NULL DEFAULT 0,
  safe_url TEXT NOT NULL DEFAULT ''
);

INSERT OR IGNORE INTO config(key, value) VALUES ('tracking_quality_gate_enabled', '0');

-- Owner-locked variants never move under the auto-optimiser (F20).
ALTER TABLE tr_link_variants ADD COLUMN locked INTEGER NOT NULL DEFAULT 0;

-- Conversion source (F22): 's2s' for server postbacks, 'pixel' for
-- browser pixel fires. Existing rows default to 's2s'.
ALTER TABLE tr_conversions ADD COLUMN source TEXT NOT NULL DEFAULT 's2s';
