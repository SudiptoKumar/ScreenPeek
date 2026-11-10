-- Only a verified Access identity may see a test-mode slot.
ALTER TABLE ad_slots ADD COLUMN test_mode INTEGER NOT NULL DEFAULT 0 CHECK (test_mode IN (0,1));
INSERT OR IGNORE INTO config(key,value) VALUES ('ads_enabled','0');
