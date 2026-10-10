ALTER TABLE contents ADD COLUMN allow_download INTEGER NOT NULL DEFAULT 1 CHECK (allow_download IN (0, 1));
