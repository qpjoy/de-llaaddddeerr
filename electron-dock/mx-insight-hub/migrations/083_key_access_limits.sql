-- Optional additional per-Key limits. NULL means no additional limit; existing policies remain intact.
CREATE TABLE control.api_key_access_limits (
 api_key_id uuid NOT NULL REFERENCES api_keys(id),
 scope_type text NOT NULL CHECK (scope_type IN ('platform','capability')),
 scope_key text NOT NULL,
 total_limit bigint CHECK (total_limit > 0),
 rate_limit integer CHECK (rate_limit > 0),
 window_seconds integer NOT NULL DEFAULT 60 CHECK (window_seconds BETWEEN 1 AND 86400),
 revision integer NOT NULL DEFAULT 1,
 updated_at timestamptz NOT NULL DEFAULT now(),
 PRIMARY KEY(api_key_id,scope_type,scope_key)
);
CREATE TABLE control.api_key_access_limit_events (
 id bigserial PRIMARY KEY, api_key_id uuid NOT NULL REFERENCES api_keys(id),
 scope_type text NOT NULL, scope_key text NOT NULL, configuration jsonb NOT NULL,
 actor text NOT NULL, created_at timestamptz NOT NULL DEFAULT now()
);
