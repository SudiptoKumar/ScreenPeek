ALTER TABLE links ADD COLUMN deleted_at TEXT;
ALTER TABLE ad_slots ADD COLUMN deleted_at TEXT;
ALTER TABLE pages ADD COLUMN deleted_at TEXT;
ALTER TABLE collections ADD COLUMN deleted_at TEXT;
ALTER TABLE collections ADD COLUMN starts_at TEXT;
ALTER TABLE collections ADD COLUMN ends_at TEXT;
ALTER TABLE collections ADD COLUMN revision INTEGER NOT NULL DEFAULT 0;
ALTER TABLE taxonomy_overrides ADD COLUMN deleted_at TEXT;
ALTER TABLE taxonomy_overrides ADD COLUMN revision INTEGER NOT NULL DEFAULT 0;
ALTER TABLE redirects ADD COLUMN deleted_at TEXT;
ALTER TABLE redirects ADD COLUMN revision INTEGER NOT NULL DEFAULT 0;
ALTER TABLE seo_overrides ADD COLUMN deleted_at TEXT;
ALTER TABLE seo_overrides ADD COLUMN revision INTEGER NOT NULL DEFAULT 0;
ALTER TABLE people ADD COLUMN revision INTEGER NOT NULL DEFAULT 0;
ALTER TABLE titles ADD COLUMN pin_starts_at TEXT;
ALTER TABLE titles ADD COLUMN pin_ends_at TEXT;
CREATE TABLE IF NOT EXISTS admin_trash (
  entity TEXT NOT NULL, entity_key TEXT NOT NULL, snapshot TEXT NOT NULL,
  deleted_at TEXT NOT NULL DEFAULT (datetime('now')), actor TEXT NOT NULL,
  PRIMARY KEY(entity,entity_key)
);
CREATE INDEX IF NOT EXISTS idx_admin_trash_date ON admin_trash(deleted_at);
CREATE TABLE IF NOT EXISTS homepage_sections (
  key TEXT PRIMARY KEY, label TEXT NOT NULL, ord INTEGER NOT NULL DEFAULT 0,
  enabled INTEGER NOT NULL DEFAULT 1, source TEXT NOT NULL DEFAULT 'auto', pins TEXT NOT NULL DEFAULT '[]',
  starts_at TEXT, ends_at TEXT, revision INTEGER NOT NULL DEFAULT 0, deleted_at TEXT
);
INSERT OR IGNORE INTO homepage_sections(key,label,ord) VALUES
('trending','Trending now',10),('top10','Top 10 this week',20),('movies','Latest movies',30),('series','Latest series',40),('upcoming','Coming soon',50),('categories','Explore the catalogue',60),('genres','Pick a genre',70);
CREATE TABLE IF NOT EXISTS admin_revision_guard(id INTEGER PRIMARY KEY CHECK(id=1));
INSERT OR IGNORE INTO admin_revision_guard(id) VALUES(1);
