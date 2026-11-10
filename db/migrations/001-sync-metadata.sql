-- Additive metadata needed by documented Phase 1 detail/taxonomy pages.
-- Apply once; migration tracking is handled by Wrangler migrations.
ALTER TABLE titles ADD COLUMN gallery_r2 TEXT NOT NULL DEFAULT '[]';
ALTER TABLE titles ADD COLUMN studio TEXT;
ALTER TABLE titles ADD COLUMN budget INTEGER;
ALTER TABLE titles ADD COLUMN revenue INTEGER;

CREATE TABLE IF NOT EXISTS title_genres (
  title_id INTEGER NOT NULL,
  title_type TEXT NOT NULL,
  genre_slug TEXT NOT NULL,
  PRIMARY KEY(title_id,title_type,genre_slug)
);
CREATE INDEX IF NOT EXISTS idx_title_genres_slug ON title_genres(genre_slug,title_type,title_id);
INSERT OR IGNORE INTO title_genres(title_id,title_type,genre_slug)
SELECT t.id,t.type,j.value FROM titles t,json_each(t.genres) j WHERE j.type='text';
CREATE TABLE IF NOT EXISTS collection_titles (
  collection_slug TEXT NOT NULL,
  title_id INTEGER NOT NULL,
  title_type TEXT NOT NULL,
  source TEXT NOT NULL DEFAULT 'manual' CHECK(source IN ('manual','tmdb')),
  PRIMARY KEY(collection_slug,title_id,title_type)
);
CREATE INDEX IF NOT EXISTS idx_collection_titles_title ON collection_titles(title_id,title_type);
CREATE INDEX IF NOT EXISTS idx_titles_language ON titles(original_language,popularity DESC);
CREATE INDEX IF NOT EXISTS idx_titles_year ON titles(year,popularity DESC);

-- Overflow and failed candidates survive runs instead of silently disappearing.
CREATE TABLE IF NOT EXISTS sync_queue (
  title_id INTEGER NOT NULL,
  title_type TEXT NOT NULL,
  candidate TEXT NOT NULL,
  queued_at TEXT NOT NULL,
  PRIMARY KEY(title_id,title_type)
);
