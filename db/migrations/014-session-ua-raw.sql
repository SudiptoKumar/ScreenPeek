-- ScreenPeek Insight — migration 014: full user-agent string on page visits.
-- Owner request 2026-11-13: page-visit sessions stored only the parsed
-- browser/os/device; the raw UA line (e.g. "Mozilla/5.0 (Windows NT 10.0;
-- Win64; x64; rv:128.0) Gecko/20100101 Firefox/128.0") was stored only on
-- /go/ clicks (tr_clicks.ua_raw). Additive only: one column on tr_sessions,
-- written by the beacon ingestion from the request's User-Agent header.

ALTER TABLE tr_sessions ADD COLUMN ua_raw TEXT NOT NULL DEFAULT '';
