BEGIN;

SELECT pg_advisory_xact_lock(hashtextextended('mx-insight-hub:telegram-monitor:source-prepare', 0));
SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '15min';

DO $mx$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_class c
    JOIN pg_namespace n ON n.oid = c.relnamespace
    WHERE n.nspname = 'public' AND c.relname = 'tg_monitor_chats'
      AND c.relkind = 'r' AND NOT c.relispartition
      AND NOT EXISTS (
        SELECT 1 FROM pg_inherits i
         WHERE i.inhrelid = c.oid OR i.inhparent = c.oid
      )
  ) THEN
    RAISE EXCEPTION 'required Telegram source must be a non-partition ordinary table: public.tg_monitor_chats';
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM pg_class c
    JOIN pg_namespace n ON n.oid = c.relnamespace
    WHERE n.nspname = 'public' AND c.relname = 'tg_monitor_messages'
      AND c.relkind = 'r' AND NOT c.relispartition
      AND NOT EXISTS (
        SELECT 1 FROM pg_inherits i
         WHERE i.inhrelid = c.oid OR i.inhparent = c.oid
      )
  ) THEN
    RAISE EXCEPTION 'required Telegram source must be a non-partition ordinary table: public.tg_monitor_messages';
  END IF;
END
$mx$;

LOCK TABLE public.tg_monitor_chats, public.tg_monitor_messages
  IN ACCESS EXCLUSIVE MODE;

CREATE SCHEMA IF NOT EXISTS mx_insight_hub_source;
REVOKE ALL ON SCHEMA mx_insight_hub_source FROM PUBLIC;

CREATE TABLE IF NOT EXISTS mx_insight_hub_source.telegram_monitor_watermark (
  singleton boolean PRIMARY KEY DEFAULT true CHECK (singleton),
  last_updated_at timestamptz NOT NULL,
  CONSTRAINT telegram_monitor_watermark_last_updated_at_finite
    CHECK (isfinite(last_updated_at))
);

DO $mx$
DECLARE
  watermark_oid oid;
BEGIN
  SELECT c.oid
    INTO watermark_oid
    FROM pg_class c
    JOIN pg_namespace n ON n.oid = c.relnamespace
   WHERE n.nspname = 'mx_insight_hub_source'
     AND c.relname = 'telegram_monitor_watermark'
     AND c.relkind = 'r';

  IF watermark_oid IS NULL
     OR (SELECT count(*) FROM pg_attribute
          WHERE attrelid = watermark_oid AND attnum > 0 AND NOT attisdropped) <> 2
     OR NOT EXISTS (
       SELECT 1 FROM pg_attribute
        WHERE attrelid = watermark_oid AND attname = 'singleton'
          AND atttypid = 'boolean'::regtype AND attnotnull
     )
     OR NOT EXISTS (
       SELECT 1 FROM pg_attribute
        WHERE attrelid = watermark_oid AND attname = 'last_updated_at'
          AND atttypid = 'timestamp with time zone'::regtype AND attnotnull
     )
     OR NOT EXISTS (
       SELECT 1 FROM pg_constraint
        WHERE conrelid = watermark_oid AND contype = 'p'
          AND pg_get_constraintdef(oid) = 'PRIMARY KEY (singleton)'
     )
     OR NOT EXISTS (
       SELECT 1 FROM pg_constraint
        WHERE conrelid = watermark_oid AND contype = 'c'
          AND pg_get_expr(conbin, conrelid) = 'singleton'
     ) THEN
    RAISE EXCEPTION 'Telegram source watermark structure is incompatible';
  END IF;
END
$mx$;

ALTER TABLE mx_insight_hub_source.telegram_monitor_watermark
  DISABLE ROW LEVEL SECURITY;
ALTER TABLE mx_insight_hub_source.telegram_monitor_watermark
  NO FORCE ROW LEVEL SECURITY;

DO $mx$
BEGIN
  IF EXISTS (
    SELECT 1
      FROM mx_insight_hub_source.telegram_monitor_watermark
     WHERE NOT isfinite(last_updated_at)
  ) THEN
    RAISE EXCEPTION 'Telegram source watermark contains a non-finite timestamp';
  END IF;
END
$mx$;

ALTER TABLE mx_insight_hub_source.telegram_monitor_watermark
  DROP CONSTRAINT IF EXISTS telegram_monitor_watermark_last_updated_at_finite;
ALTER TABLE mx_insight_hub_source.telegram_monitor_watermark
  ADD CONSTRAINT telegram_monitor_watermark_last_updated_at_finite
  CHECK (isfinite(last_updated_at)) NOT VALID;
ALTER TABLE mx_insight_hub_source.telegram_monitor_watermark
  VALIDATE CONSTRAINT telegram_monitor_watermark_last_updated_at_finite;

CREATE TABLE IF NOT EXISTS mx_insight_hub_source.telegram_monitor_contract (
  contract_key text PRIMARY KEY,
  version integer NOT NULL,
  generation text NOT NULL,
  chats_table_oid oid NOT NULL,
  messages_table_oid oid NOT NULL,
  installed_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  installed_by name NOT NULL DEFAULT 'mx-insight-hub'::name
);

ALTER TABLE mx_insight_hub_source.telegram_monitor_contract
  ADD COLUMN IF NOT EXISTS generation text;
UPDATE mx_insight_hub_source.telegram_monitor_contract
   SET generation = md5(random()::text || clock_timestamp()::text || txid_current()::text)
 WHERE generation IS NULL;
ALTER TABLE mx_insight_hub_source.telegram_monitor_contract
  ALTER COLUMN generation SET NOT NULL;

DO $mx$
DECLARE
  column_type regtype;
BEGIN
  SELECT a.atttypid::regtype
    INTO column_type
    FROM pg_attribute a
   WHERE a.attrelid = 'public.tg_monitor_chats'::regclass
     AND a.attname = 'updated_at'
     AND a.attnum > 0
     AND NOT a.attisdropped;

  IF column_type IS NULL THEN
    RAISE EXCEPTION 'public.tg_monitor_chats.updated_at is required';
  END IF;
  IF column_type <> 'timestamp with time zone'::regtype THEN
    RAISE EXCEPTION 'public.tg_monitor_chats.updated_at must be timestamptz';
  END IF;
END
$mx$;

DO $mx$
BEGIN
  IF NOT EXISTS (
    SELECT 1
      FROM pg_attribute
     WHERE attrelid = 'public.tg_monitor_messages'::regclass
       AND attname = 'updated_at'
       AND attnum > 0
       AND NOT attisdropped
  ) THEN
    ALTER TABLE public.tg_monitor_messages
      ADD COLUMN updated_at timestamptz NOT NULL DEFAULT '1970-01-01 00:00:00+00'::timestamptz;
    ALTER TABLE public.tg_monitor_messages
      ALTER COLUMN updated_at DROP DEFAULT;
  END IF;
END
$mx$;

DO $mx$
DECLARE
  column_type regtype;
BEGIN
  SELECT a.atttypid::regtype
    INTO column_type
    FROM pg_attribute a
   WHERE a.attrelid = 'public.tg_monitor_messages'::regclass
     AND a.attname = 'updated_at'
     AND a.attnum > 0
     AND NOT a.attisdropped;

  IF column_type <> 'timestamp with time zone'::regtype THEN
    RAISE EXCEPTION 'public.tg_monitor_messages.updated_at must be timestamptz';
  END IF;
END
$mx$;

UPDATE public.tg_monitor_chats
   SET updated_at = clock_timestamp()
 WHERE updated_at IS NULL;

UPDATE public.tg_monitor_messages
   SET updated_at = clock_timestamp()
 WHERE updated_at IS NULL;

DO $mx$
BEGIN
  IF EXISTS (SELECT 1 FROM public.tg_monitor_chats WHERE NOT isfinite(updated_at))
     OR EXISTS (SELECT 1 FROM public.tg_monitor_messages WHERE NOT isfinite(updated_at)) THEN
    RAISE EXCEPTION 'Telegram source updated_at values must be finite';
  END IF;
END
$mx$;

ALTER TABLE public.tg_monitor_chats
  ALTER COLUMN updated_at SET NOT NULL;
ALTER TABLE public.tg_monitor_messages
  ALTER COLUMN updated_at SET NOT NULL;

ALTER TABLE public.tg_monitor_chats
  DROP CONSTRAINT IF EXISTS mx_insight_hub_tg_chats_updated_at_finite;
ALTER TABLE public.tg_monitor_chats
  ADD CONSTRAINT mx_insight_hub_tg_chats_updated_at_finite
  CHECK (isfinite(updated_at)) NOT VALID;
ALTER TABLE public.tg_monitor_chats
  VALIDATE CONSTRAINT mx_insight_hub_tg_chats_updated_at_finite;

ALTER TABLE public.tg_monitor_messages
  DROP CONSTRAINT IF EXISTS mx_insight_hub_tg_messages_updated_at_finite;
ALTER TABLE public.tg_monitor_messages
  ADD CONSTRAINT mx_insight_hub_tg_messages_updated_at_finite
  CHECK (isfinite(updated_at)) NOT VALID;
ALTER TABLE public.tg_monitor_messages
  VALIDATE CONSTRAINT mx_insight_hub_tg_messages_updated_at_finite;

INSERT INTO mx_insight_hub_source.telegram_monitor_watermark (singleton, last_updated_at)
VALUES (true, clock_timestamp())
ON CONFLICT (singleton) DO NOTHING;

UPDATE mx_insight_hub_source.telegram_monitor_watermark
   SET last_updated_at = GREATEST(
     last_updated_at,
     clock_timestamp(),
     COALESCE((SELECT max(updated_at) FROM public.tg_monitor_chats), '-infinity'::timestamptz),
     COALESCE((SELECT max(updated_at) FROM public.tg_monitor_messages), '-infinity'::timestamptz)
   )
 WHERE singleton;

CREATE OR REPLACE FUNCTION mx_insight_hub_source.telegram_monitor_advance_watermark()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, mx_insight_hub_source
AS $mx$
BEGIN
  UPDATE mx_insight_hub_source.telegram_monitor_watermark
     SET last_updated_at = GREATEST(
       clock_timestamp(),
       last_updated_at + interval '1 microsecond'
     )
   WHERE singleton;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'Telegram source watermark row is missing';
  END IF;

  RETURN NULL;
END
$mx$;

CREATE OR REPLACE FUNCTION mx_insight_hub_source.telegram_monitor_touch_updated_at()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, mx_insight_hub_source
AS $mx$
DECLARE
  next_updated_at timestamptz;
BEGIN
  SELECT last_updated_at
    INTO next_updated_at
    FROM mx_insight_hub_source.telegram_monitor_watermark
   WHERE singleton;

  IF next_updated_at IS NULL THEN
    RAISE EXCEPTION 'Telegram source watermark row is missing';
  END IF;

  NEW.updated_at := next_updated_at;
  RETURN NEW;
END
$mx$;

CREATE OR REPLACE FUNCTION mx_insight_hub_source.telegram_monitor_deny_hard_delete()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog
AS $mx$
BEGIN
  RAISE EXCEPTION 'hard DELETE/TRUNCATE is disabled for Telegram monitor source tables; use the source soft-delete/status fields';
END
$mx$;

DROP TRIGGER IF EXISTS mx_insight_hub_touch_updated_at ON public.tg_monitor_chats;
DROP TRIGGER IF EXISTS mx_insight_hub_advance_watermark ON public.tg_monitor_chats;
CREATE TRIGGER mx_insight_hub_advance_watermark
BEFORE INSERT OR UPDATE ON public.tg_monitor_chats
FOR EACH STATEMENT
EXECUTE FUNCTION mx_insight_hub_source.telegram_monitor_advance_watermark();
ALTER TABLE public.tg_monitor_chats
  ENABLE ALWAYS TRIGGER mx_insight_hub_advance_watermark;

DROP TRIGGER IF EXISTS zzzzzzzz_mx_insight_hub_touch_updated_at ON public.tg_monitor_chats;
CREATE TRIGGER zzzzzzzz_mx_insight_hub_touch_updated_at
BEFORE INSERT OR UPDATE ON public.tg_monitor_chats
FOR EACH ROW
EXECUTE FUNCTION mx_insight_hub_source.telegram_monitor_touch_updated_at();
ALTER TABLE public.tg_monitor_chats
  ENABLE ALWAYS TRIGGER zzzzzzzz_mx_insight_hub_touch_updated_at;

DROP TRIGGER IF EXISTS mx_insight_hub_touch_updated_at ON public.tg_monitor_messages;
DROP TRIGGER IF EXISTS mx_insight_hub_advance_watermark ON public.tg_monitor_messages;
CREATE TRIGGER mx_insight_hub_advance_watermark
BEFORE INSERT OR UPDATE ON public.tg_monitor_messages
FOR EACH STATEMENT
EXECUTE FUNCTION mx_insight_hub_source.telegram_monitor_advance_watermark();
ALTER TABLE public.tg_monitor_messages
  ENABLE ALWAYS TRIGGER mx_insight_hub_advance_watermark;

DROP TRIGGER IF EXISTS zzzzzzzz_mx_insight_hub_touch_updated_at ON public.tg_monitor_messages;
CREATE TRIGGER zzzzzzzz_mx_insight_hub_touch_updated_at
BEFORE INSERT OR UPDATE ON public.tg_monitor_messages
FOR EACH ROW
EXECUTE FUNCTION mx_insight_hub_source.telegram_monitor_touch_updated_at();
ALTER TABLE public.tg_monitor_messages
  ENABLE ALWAYS TRIGGER zzzzzzzz_mx_insight_hub_touch_updated_at;

DROP TRIGGER IF EXISTS mx_insight_hub_deny_hard_delete ON public.tg_monitor_chats;
CREATE TRIGGER mx_insight_hub_deny_hard_delete
BEFORE DELETE OR TRUNCATE ON public.tg_monitor_chats
FOR EACH STATEMENT
EXECUTE FUNCTION mx_insight_hub_source.telegram_monitor_deny_hard_delete();
ALTER TABLE public.tg_monitor_chats
  ENABLE ALWAYS TRIGGER mx_insight_hub_deny_hard_delete;

DROP TRIGGER IF EXISTS mx_insight_hub_deny_hard_delete ON public.tg_monitor_messages;
CREATE TRIGGER mx_insight_hub_deny_hard_delete
BEFORE DELETE OR TRUNCATE ON public.tg_monitor_messages
FOR EACH STATEMENT
EXECUTE FUNCTION mx_insight_hub_source.telegram_monitor_deny_hard_delete();
ALTER TABLE public.tg_monitor_messages
  ENABLE ALWAYS TRIGGER mx_insight_hub_deny_hard_delete;

REVOKE ALL ON mx_insight_hub_source.telegram_monitor_watermark FROM PUBLIC;
REVOKE ALL ON mx_insight_hub_source.telegram_monitor_contract FROM PUBLIC;
REVOKE ALL ON FUNCTION mx_insight_hub_source.telegram_monitor_advance_watermark() FROM PUBLIC;
REVOKE ALL ON FUNCTION mx_insight_hub_source.telegram_monitor_touch_updated_at() FROM PUBLIC;
REVOKE ALL ON FUNCTION mx_insight_hub_source.telegram_monitor_deny_hard_delete() FROM PUBLIC;
GRANT USAGE ON SCHEMA mx_insight_hub_source TO PUBLIC;
GRANT SELECT ON mx_insight_hub_source.telegram_monitor_watermark TO PUBLIC;
GRANT SELECT ON mx_insight_hub_source.telegram_monitor_contract TO PUBLIC;

INSERT INTO mx_insight_hub_source.telegram_monitor_contract (
  contract_key,
  version,
  generation,
  chats_table_oid,
  messages_table_oid,
  installed_at,
  installed_by
)
VALUES (
  'telegram-monitor',
  1,
  md5(random()::text || clock_timestamp()::text || txid_current()::text),
  'public.tg_monitor_chats'::regclass::oid,
  'public.tg_monitor_messages'::regclass::oid,
  clock_timestamp(),
  'mx-insight-hub'::name
)
ON CONFLICT (contract_key) DO UPDATE
SET version = EXCLUDED.version,
    generation = EXCLUDED.generation,
    chats_table_oid = EXCLUDED.chats_table_oid,
    messages_table_oid = EXCLUDED.messages_table_oid,
    installed_at = EXCLUDED.installed_at,
    installed_by = EXCLUDED.installed_by;

COMMIT;
