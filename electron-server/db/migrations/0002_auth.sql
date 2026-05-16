-- Phase 5: users + sessions + entitlements + verification codes.
-- Matches the JSON-backed `auth-storage.ts` shape so swap-in is mechanical.

CREATE EXTENSION IF NOT EXISTS pgcrypto;   -- for gen_random_uuid()

CREATE TABLE users (
  id                  uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  username            text UNIQUE,
  email               text UNIQUE,
  phone               text UNIQUE,
  password_hash       text NOT NULL,
  role                text NOT NULL DEFAULT 'user'
                      CHECK (role IN ('user', 'admin', 'banned')),
  display_name        text,
  email_verified_at   timestamptz,
  phone_verified_at   timestamptz,
  created_at          timestamptz NOT NULL DEFAULT now(),
  updated_at          timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT users_has_login
    CHECK (username IS NOT NULL OR email IS NOT NULL OR phone IS NOT NULL)
);

CREATE TABLE refresh_tokens (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id       uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  token_hash    text NOT NULL,
  device_label  text,
  expires_at    timestamptz NOT NULL,
  revoked_at    timestamptz,
  created_at    timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX refresh_tokens_user_idx ON refresh_tokens(user_id);
CREATE INDEX refresh_tokens_hash_idx ON refresh_tokens(token_hash);

CREATE TABLE entitlements (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id     uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  plugin_id   text NOT NULL,
  kind        text NOT NULL CHECK (kind IN ('free', 'paid', 'trial')),
  granted_at  timestamptz NOT NULL DEFAULT now(),
  expires_at  timestamptz,
  UNIQUE (user_id, plugin_id)
);

CREATE TABLE verification_codes (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  channel      text NOT NULL CHECK (channel IN ('email', 'sms')),
  destination  text NOT NULL,
  code         text NOT NULL,
  purpose      text NOT NULL CHECK (purpose IN ('register', 'login', 'reset')),
  expires_at   timestamptz NOT NULL,
  consumed_at  timestamptz,
  created_at   timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX verification_codes_lookup_idx
  ON verification_codes(channel, destination, code, purpose)
  WHERE consumed_at IS NULL;
