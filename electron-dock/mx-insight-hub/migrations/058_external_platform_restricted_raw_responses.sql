CREATE SCHEMA IF NOT EXISTS control;

-- The operational response/archive tables in external_platform are deliberately
-- secret-free. Keep the exact, bounded provider response bytes in the restricted
-- control schema so business fields are never destroyed by a presentation-layer
-- redactor. Request headers, credentials and request URLs are never stored here.
CREATE TABLE IF NOT EXISTS control.external_platform_restricted_raw_responses (
  id uuid PRIMARY KEY,
  provider_call_id uuid NOT NULL UNIQUE
    REFERENCES external_platform.provider_calls(id) ON DELETE RESTRICT,
  content_type text,
  body_size integer NOT NULL CHECK (body_size >= 0),
  body_sha256 char(64) NOT NULL
    CHECK (body_sha256 ~ '^[0-9a-f]{64}$'),
  body_bytes bytea NOT NULL,
  body_text text,
  json_parsed boolean NOT NULL,
  parsed_payload jsonb,
  captured_at timestamptz NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  CHECK (octet_length(body_bytes) = body_size),
  CHECK (json_parsed OR parsed_payload IS NULL)
);

CREATE INDEX IF NOT EXISTS external_platform_restricted_raw_responses_time_idx
  ON control.external_platform_restricted_raw_responses (captured_at DESC);

REVOKE ALL ON TABLE control.external_platform_restricted_raw_responses FROM PUBLIC;

COMMENT ON TABLE control.external_platform_restricted_raw_responses IS
  'Restricted exact provider response bodies. Never select from Public, tenant, ordinary Admin, UI, log or search-projection paths.';
COMMENT ON COLUMN control.external_platform_restricted_raw_responses.body_bytes IS
  'Exact bounded HTTP response bytes; excludes request URL and request Authorization/Cookie/credential material.';
COMMENT ON COLUMN control.external_platform_restricted_raw_responses.body_text IS
  'Optional decoded UTF-8 view of body_bytes; body_bytes and its SHA-256 remain the source of truth.';
COMMENT ON COLUMN control.external_platform_restricted_raw_responses.parsed_payload IS
  'Convenience JSONB projection when json_parsed=true; body_bytes/body_sha256 are the only exact source because JSONB does not preserve whitespace, key order or duplicate keys.';
