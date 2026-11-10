ALTER TABLE links ADD COLUMN revision INTEGER NOT NULL DEFAULT 0;
ALTER TABLE ad_slots ADD COLUMN revision INTEGER NOT NULL DEFAULT 0;
ALTER TABLE config ADD COLUMN revision INTEGER NOT NULL DEFAULT 0;
ALTER TABLE titles ADD COLUMN revision INTEGER NOT NULL DEFAULT 0;
CREATE INDEX IF NOT EXISTS idx_click_log_day ON click_log(day);
CREATE TABLE IF NOT EXISTS admin_delivery (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  log_id INTEGER NOT NULL,
  entity TEXT NOT NULL,
  entity_id TEXT NOT NULL,
  payload TEXT NOT NULL,
  kv_done INTEGER NOT NULL DEFAULT 0,
  purge_done INTEGER NOT NULL DEFAULT 0,
  attempts INTEGER NOT NULL DEFAULT 0,
  last_error TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_admin_delivery_pending ON admin_delivery(kv_done,purge_done,id);
