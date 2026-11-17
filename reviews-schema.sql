-- Reviews for Lynch Digitance Alerts (D1). Run once: npx wrangler d1 execute alerts-reviews --remote --file reviews-schema.sql
CREATE TABLE IF NOT EXISTS reviews (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  email       TEXT,                            -- account holders only; owner dashboard only, never public
  install_id  TEXT,                            -- random id of the install that posted it
  name        TEXT    NOT NULL,                -- public display name ("Ethan C." or "Alerts user")
  rating      INTEGER NOT NULL,                -- 1..5
  body        TEXT    NOT NULL DEFAULT '',     -- optional written review, max 500 characters
  version     TEXT,                            -- extension version that posted it
  created_at  INTEGER NOT NULL,
  updated_at  INTEGER NOT NULL,
  hidden      INTEGER NOT NULL DEFAULT 0,
  ip_hash     TEXT                             -- keyed hash, only used to cap new reviews per day
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_reviews_email ON reviews(email) WHERE email IS NOT NULL;
CREATE UNIQUE INDEX IF NOT EXISTS idx_reviews_install ON reviews(install_id) WHERE install_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_reviews_shown ON reviews(hidden, created_at);
