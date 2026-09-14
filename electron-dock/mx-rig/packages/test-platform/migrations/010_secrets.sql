-- Credentials for the application under test: the read-only test account a
-- `real` profile run signs in with.
--
-- Encrypted at rest, and that is not ceremony. specs/14 §2 puts a nightly
-- `pg_dump mx_test` into an OSS bucket. Plaintext here means those passwords
-- live in object storage, with a different access model and a much longer
-- retention than anyone intended when they typed them in.
--
-- The key lives in MXT_SECRET_KEY, outside the database, so a dump alone is
-- not enough. Without that variable the platform refuses to store secrets at
-- all rather than quietly falling back to plaintext.

CREATE TABLE IF NOT EXISTS mxt_secrets (
  id          text PRIMARY KEY,
  app_id      text NOT NULL REFERENCES mxt_apps(id) ON DELETE CASCADE,
  -- The name a suite references in secretRefs, e.g. LUOPAN_TEST_PASSWORD.
  name        text NOT NULL,
  -- AES-256-GCM. iv and tag are stored alongside; none of the three is secret
  -- on its own.
  ciphertext  text NOT NULL,
  iv          text NOT NULL,
  tag         text NOT NULL,
  description text,
  created_by  text,
  created_at  timestamptz NOT NULL DEFAULT now(),
  updated_at  timestamptz NOT NULL DEFAULT now(),
  UNIQUE (app_id, name)
);

CREATE INDEX IF NOT EXISTS mxt_secrets_app_idx ON mxt_secrets (app_id);
