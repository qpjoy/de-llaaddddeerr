-- Make the complete authorization scope set part of the usage row inserted by
-- the admission transaction. The child table is an indexed projection of this
-- immutable parent snapshot, not an independently extensible evidence source.

SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '2min';

ALTER TABLE public.usage_requests
  ADD COLUMN IF NOT EXISTS authorization_scopes jsonb NOT NULL DEFAULT '[]'::jsonb;

ALTER TABLE public.usage_requests
  DROP CONSTRAINT IF EXISTS usage_requests_authorization_scopes_array_check;
ALTER TABLE public.usage_requests
  ADD CONSTRAINT usage_requests_authorization_scopes_array_check
  CHECK (jsonb_typeof(authorization_scopes) = 'array') NOT VALID;
ALTER TABLE public.usage_requests
  VALIDATE CONSTRAINT usage_requests_authorization_scopes_array_check;

CREATE OR REPLACE FUNCTION protect_usage_request_authorization_snapshot()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  IF NEW.authorization_scopes IS DISTINCT FROM OLD.authorization_scopes THEN
    RAISE EXCEPTION 'usage request authorization snapshot is immutable'
      USING ERRCODE = '55000';
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS usage_requests_authorization_snapshot_immutable
  ON public.usage_requests;
CREATE TRIGGER usage_requests_authorization_snapshot_immutable
BEFORE UPDATE OF authorization_scopes ON public.usage_requests
FOR EACH ROW EXECUTE FUNCTION protect_usage_request_authorization_snapshot();

CREATE OR REPLACE FUNCTION seed_primary_usage_authorization_scope()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
  invalid_scope boolean;
  duplicate_scope boolean;
  primary_scope_type text := CASE WHEN NEW.platform IS NOT NULL
                                  THEN 'platform' ELSE 'capability' END;
  primary_scope_key text := coalesce(NEW.platform, NEW.capability);
BEGIN
  IF jsonb_array_length(NEW.authorization_scopes) = 0 THEN
    -- Rolling-upgrade compatibility for an older application process. Its
    -- historical single scope remains explicit. New code supplies all axes.
    INSERT INTO public.usage_request_authorization_scopes
      (usage_request_id, scope_type, scope_key, created_at)
    VALUES (NEW.id, primary_scope_type, primary_scope_key, NEW.created_at)
    ON CONFLICT (usage_request_id, scope_type, scope_key) DO NOTHING;
    RETURN NEW;
  END IF;

  SELECT EXISTS (
           SELECT 1
             FROM jsonb_array_elements(NEW.authorization_scopes) candidate
            WHERE jsonb_typeof(candidate) <> 'object'
               OR (SELECT count(*) FROM jsonb_object_keys(candidate)) <> 2
               OR NOT (candidate ? 'type' AND candidate ? 'key')
               OR candidate->>'type' NOT IN ('platform', 'capability')
               OR length(candidate->>'key') NOT BETWEEN 1 AND 128
               OR candidate->>'key' ~ '[[:cntrl:]]'
         ),
         count(*) <> count(DISTINCT (entry->>'type', entry->>'key'))
    INTO invalid_scope, duplicate_scope
    FROM jsonb_array_elements(NEW.authorization_scopes) entry;

  IF invalid_scope OR duplicate_scope THEN
    RAISE EXCEPTION 'usage request authorization snapshot is invalid'
      USING ERRCODE = '23514';
  END IF;

  IF NOT EXISTS (
    SELECT 1
      FROM jsonb_array_elements(NEW.authorization_scopes) entry
     WHERE entry->>'type' = primary_scope_type
       AND entry->>'key' = primary_scope_key
  ) THEN
    RAISE EXCEPTION 'usage request authorization snapshot omits the primary accounting scope'
      USING ERRCODE = '23514';
  END IF;

  INSERT INTO public.usage_request_authorization_scopes
    (usage_request_id, scope_type, scope_key, created_at)
  SELECT NEW.id, entry->>'type', entry->>'key', NEW.created_at
    FROM jsonb_array_elements(NEW.authorization_scopes) entry
  ON CONFLICT (usage_request_id, scope_type, scope_key) DO NOTHING;
  RETURN NEW;
END;
$$;

CREATE OR REPLACE FUNCTION protect_usage_request_authorization_scope()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
  parent_platform text;
  parent_capability text;
  parent_scopes jsonb;
BEGIN
  IF TG_OP = 'INSERT' THEN
    SELECT request.platform, request.capability, request.authorization_scopes
      INTO parent_platform, parent_capability, parent_scopes
      FROM public.usage_requests request
     WHERE request.id = NEW.usage_request_id;

    -- The parent snapshot is authoritative. A later INSERT may only restore
    -- one of its exact projection rows and therefore cannot widen the set.
    IF EXISTS (
         SELECT 1
           FROM jsonb_array_elements(coalesce(parent_scopes, '[]'::jsonb)) entry
          WHERE entry->>'type' = NEW.scope_type
            AND entry->>'key' = NEW.scope_key
       ) OR (
         jsonb_array_length(coalesce(parent_scopes, '[]'::jsonb)) = 0
         AND NEW.scope_type = CASE WHEN parent_platform IS NOT NULL
                                   THEN 'platform' ELSE 'capability' END
         AND NEW.scope_key = coalesce(parent_platform, parent_capability)
       ) THEN
      RETURN NEW;
    END IF;
  END IF;

  RAISE EXCEPTION 'usage request authorization scopes are immutable'
    USING ERRCODE = '55000';
END;
$$;

DROP TRIGGER IF EXISTS usage_request_authorization_scopes_immutable
  ON public.usage_request_authorization_scopes;
CREATE TRIGGER usage_request_authorization_scopes_immutable
BEFORE INSERT OR UPDATE OR DELETE ON public.usage_request_authorization_scopes
FOR EACH ROW EXECUTE FUNCTION protect_usage_request_authorization_scope();

COMMENT ON COLUMN public.usage_requests.authorization_scopes IS
  'Immutable complete authorization snapshot admitted atomically with the usage request; [] is legacy single-scope compatibility.';

COMMENT ON TABLE public.usage_request_authorization_scopes IS
  'Indexed append-only projection of usage_requests.authorization_scopes; billing remains bound to usage_requests.billing_meter_key.';
