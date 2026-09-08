-- Customer billing is intentionally independent from provider procurement.
-- One customer usage request has at most one customer charge even when the
-- request fans out into several external_platform.provider_calls.

-- This file follows migration 055 and is executed transactionally by
-- server/migrate.mjs.  Bound the two ALTER TABLE locks so a rolling deploy
-- fails closed instead of waiting indefinitely behind production writers.
SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '5min';

CREATE SCHEMA IF NOT EXISTS billing;

CREATE TABLE IF NOT EXISTS billing.customer_price_books (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  price_book_key text NOT NULL
    CHECK (price_book_key ~ '^[a-z][a-z0-9._-]{0,63}$'),
  version integer NOT NULL CHECK (version > 0),
  currency char(3) NOT NULL CHECK (currency ~ '^[A-Z]{3}$'),
  default_multiplier_ppm bigint NOT NULL DEFAULT 1000000
    CHECK (default_multiplier_ppm BETWEEN 0 AND 100000000),
  status text NOT NULL DEFAULT 'draft'
    CHECK (status IN ('draft', 'published', 'retired')),
  published_at timestamptz,
  published_by text CHECK (
    published_by IS NULL OR length(btrim(published_by)) BETWEEN 1 AND 256
  ),
  retired_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (price_book_key, version),
  CHECK (
    (status = 'draft' AND published_at IS NULL AND published_by IS NULL AND retired_at IS NULL)
    OR (status = 'published' AND published_at IS NOT NULL
      AND published_by IS NOT NULL AND retired_at IS NULL)
    OR (status = 'retired' AND published_at IS NOT NULL
      AND published_by IS NOT NULL AND retired_at IS NOT NULL)
  )
);

CREATE TABLE IF NOT EXISTS billing.customer_price_entries (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  price_book_id uuid NOT NULL
    REFERENCES billing.customer_price_books(id) ON DELETE RESTRICT,
  meter_key text NOT NULL
    CHECK (meter_key ~ '^[a-z][a-z0-9._-]{0,127}$'),
  billing_unit text NOT NULL DEFAULT 'request'
    CHECK (billing_unit = 'request'),
  unit_price_minor bigint NOT NULL
    CHECK (unit_price_minor BETWEEN 0 AND 9007199254740991),
  description text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (price_book_id, meter_key)
);

-- Published price-book contents are immutable.  Retirement only prevents the
-- version from being selected by a new plan; requests on an already-published
-- plan keep using the exact historical entries.
CREATE OR REPLACE FUNCTION billing.protect_customer_price_book()
RETURNS trigger
LANGUAGE plpgsql
AS $function$
BEGIN
  IF TG_OP = 'DELETE' THEN
    IF OLD.status <> 'draft' THEN
      RAISE EXCEPTION 'published customer price books are immutable'
        USING ERRCODE = '55000';
    END IF;
    RETURN OLD;
  END IF;

  IF OLD.status = 'retired' THEN
    RAISE EXCEPTION 'retired customer price books are immutable'
      USING ERRCODE = '55000';
  END IF;

  IF OLD.status = 'published' THEN
    IF NEW.status <> 'retired'
      OR NEW.id IS DISTINCT FROM OLD.id
      OR NEW.price_book_key IS DISTINCT FROM OLD.price_book_key
      OR NEW.version IS DISTINCT FROM OLD.version
      OR NEW.currency IS DISTINCT FROM OLD.currency
      OR NEW.default_multiplier_ppm IS DISTINCT FROM OLD.default_multiplier_ppm
      OR NEW.published_at IS DISTINCT FROM OLD.published_at
      OR NEW.published_by IS DISTINCT FROM OLD.published_by
      OR NEW.created_at IS DISTINCT FROM OLD.created_at
      OR NEW.retired_at IS NULL THEN
      RAISE EXCEPTION 'published customer price books are immutable; only retirement is allowed'
        USING ERRCODE = '55000';
    END IF;
    NEW.updated_at := now();
    RETURN NEW;
  END IF;

  IF OLD.status = 'draft' AND NEW.status = 'retired' THEN
    RAISE EXCEPTION 'a draft customer price book must be published before retirement'
      USING ERRCODE = '23514';
  END IF;
  IF NEW.status = 'published' AND NEW.published_at IS NULL THEN
    NEW.published_at := now();
  END IF;
  IF OLD.status = 'draft' AND NEW.status = 'published' THEN
    PERFORM 1 FROM billing.customer_price_entries
     WHERE price_book_id = NEW.id;
    IF NOT FOUND THEN
      RAISE EXCEPTION 'a customer price book must contain at least one entry before publication'
        USING ERRCODE = '23514';
    END IF;
  END IF;
  NEW.updated_at := now();
  RETURN NEW;
END;
$function$;

DROP TRIGGER IF EXISTS customer_price_books_protect
  ON billing.customer_price_books;
CREATE TRIGGER customer_price_books_protect
BEFORE UPDATE OR DELETE ON billing.customer_price_books
FOR EACH ROW
EXECUTE FUNCTION billing.protect_customer_price_book();

CREATE OR REPLACE FUNCTION billing.protect_customer_price_entry()
RETURNS trigger
LANGUAGE plpgsql
AS $function$
DECLARE
  source_book_status text;
  target_book_status text;
BEGIN
  SELECT status INTO source_book_status
    FROM billing.customer_price_books
   WHERE id = CASE WHEN TG_OP = 'INSERT' THEN NEW.price_book_id ELSE OLD.price_book_id END
   FOR SHARE;
  IF source_book_status IS DISTINCT FROM 'draft' THEN
    RAISE EXCEPTION 'customer price entries can only change while their price book is draft'
      USING ERRCODE = '55000';
  END IF;

  IF TG_OP = 'UPDATE' AND NEW.price_book_id IS DISTINCT FROM OLD.price_book_id THEN
    SELECT status INTO target_book_status
      FROM billing.customer_price_books
     WHERE id = NEW.price_book_id
     FOR SHARE;
    IF target_book_status IS DISTINCT FROM 'draft' THEN
      RAISE EXCEPTION 'customer price entries can only move to a draft price book'
        USING ERRCODE = '55000';
    END IF;
  END IF;

  IF TG_OP = 'UPDATE' THEN
    NEW.updated_at := now();
  END IF;
  IF TG_OP <> 'DELETE' THEN
    NEW.meter_key := lower(btrim(NEW.meter_key));
  END IF;
  RETURN CASE WHEN TG_OP = 'DELETE' THEN OLD ELSE NEW END;
END;
$function$;

DROP TRIGGER IF EXISTS customer_price_entries_protect
  ON billing.customer_price_entries;
CREATE TRIGGER customer_price_entries_protect
BEFORE INSERT OR UPDATE OR DELETE ON billing.customer_price_entries
FOR EACH ROW
EXECUTE FUNCTION billing.protect_customer_price_entry();

-- Existing published plan versions remain untouched and therefore NULL.  A
-- NULL price book is the explicit compatibility path: it never creates a
-- customer charge, even if a tenant later receives a billing profile.
ALTER TABLE plan_versions
  ADD COLUMN IF NOT EXISTS customer_price_book_id uuid
    REFERENCES billing.customer_price_books(id) ON DELETE RESTRICT;

CREATE OR REPLACE FUNCTION billing.validate_plan_customer_price_book()
RETURNS trigger
LANGUAGE plpgsql
AS $function$
BEGIN
  IF NEW.customer_price_book_id IS NOT NULL AND NEW.status = 'published' THEN
    PERFORM 1
      FROM billing.customer_price_books price_book
     WHERE price_book.id = NEW.customer_price_book_id
       AND price_book.status = 'published'
       AND EXISTS (
         SELECT 1 FROM billing.customer_price_entries price_entry
          WHERE price_entry.price_book_id = price_book.id
       );
    IF NOT FOUND THEN
      RAISE EXCEPTION 'published plan versions require a non-empty published customer price book'
        USING ERRCODE = '23514';
    END IF;
  END IF;
  RETURN NEW;
END;
$function$;

DROP TRIGGER IF EXISTS plan_versions_validate_customer_price_book
  ON plan_versions;
CREATE TRIGGER plan_versions_validate_customer_price_book
BEFORE INSERT OR UPDATE OF status, customer_price_book_id ON plan_versions
FOR EACH ROW
EXECUTE FUNCTION billing.validate_plan_customer_price_book();

CREATE TABLE IF NOT EXISTS billing.tenant_billing_profiles (
  tenant_id uuid PRIMARY KEY REFERENCES tenants(id) ON DELETE RESTRICT,
  mode text NOT NULL DEFAULT 'disabled'
    CHECK (mode IN ('disabled', 'shadow', 'enforced')),
  multiplier_ppm bigint
    CHECK (multiplier_ppm IS NULL OR multiplier_ppm BETWEEN 0 AND 100000000),
  revision integer NOT NULL DEFAULT 1 CHECK (revision > 0),
  updated_by text NOT NULL DEFAULT 'migration'
    CHECK (length(btrim(updated_by)) BETWEEN 1 AND 256),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE OR REPLACE FUNCTION billing.validate_tenant_billing_profile()
RETURNS trigger
LANGUAGE plpgsql
AS $function$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'tenant billing profiles cannot be deleted; set mode to disabled instead'
      USING ERRCODE = '55000';
  END IF;

  -- Application writers take this exclusive lock before reading the profile;
  -- retaining it here also protects direct inserts/updates. Usage reservations
  -- use the shared form so disabled/shadow traffic remains concurrent.
  PERFORM pg_advisory_xact_lock(hashtext('billing:tenant:' || NEW.tenant_id::text));

  IF TG_OP = 'INSERT' THEN
    RETURN NEW;
  END IF;
  IF NEW.tenant_id IS DISTINCT FROM OLD.tenant_id THEN
    RAISE EXCEPTION 'tenant billing profile identity is immutable'
      USING ERRCODE = '55000';
  END IF;
  IF NEW.revision <> OLD.revision + 1 THEN
    RAISE EXCEPTION 'tenant billing profile revision must increase by exactly one'
      USING ERRCODE = '23514';
  END IF;
  NEW.updated_at := now();
  RETURN NEW;
END;
$function$;

DROP TRIGGER IF EXISTS tenant_billing_profiles_validate
  ON billing.tenant_billing_profiles;
CREATE TRIGGER tenant_billing_profiles_validate
BEFORE INSERT OR UPDATE OR DELETE ON billing.tenant_billing_profiles
FOR EACH ROW
EXECUTE FUNCTION billing.validate_tenant_billing_profile();

CREATE TABLE IF NOT EXISTS billing.credit_accounts (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES tenants(id) ON DELETE RESTRICT,
  currency char(3) NOT NULL CHECK (currency ~ '^[A-Z]{3}$'),
  status text NOT NULL DEFAULT 'active'
    CHECK (status IN ('active', 'suspended', 'closed')),
  available_minor bigint NOT NULL DEFAULT 0
    CHECK (available_minor BETWEEN 0 AND 9007199254740991),
  held_minor bigint NOT NULL DEFAULT 0
    CHECK (held_minor BETWEEN 0 AND 9007199254740991),
  revision bigint NOT NULL DEFAULT 0
    CHECK (revision BETWEEN 0 AND 9007199254740991),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id),
  UNIQUE (id, tenant_id),
  CHECK (available_minor + held_minor <= 9007199254740991),
  CHECK (status <> 'closed' OR held_minor = 0)
);

CREATE TABLE IF NOT EXISTS billing.customer_charges (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  usage_request_id uuid NOT NULL UNIQUE
    REFERENCES public.usage_requests(id) ON DELETE RESTRICT,
  tenant_id uuid NOT NULL REFERENCES tenants(id) ON DELETE RESTRICT,
  consumer_id uuid NOT NULL REFERENCES consumers(id) ON DELETE RESTRICT,
  api_key_id uuid NOT NULL REFERENCES api_keys(id) ON DELETE RESTRICT,
  account_id uuid,
  plan_version_id uuid NOT NULL REFERENCES plan_versions(id) ON DELETE RESTRICT,
  price_book_id uuid NOT NULL
    REFERENCES billing.customer_price_books(id) ON DELETE RESTRICT,
  price_entry_id uuid NOT NULL
    REFERENCES billing.customer_price_entries(id) ON DELETE RESTRICT,
  enforcement_mode text NOT NULL CHECK (enforcement_mode IN ('shadow', 'enforced')),
  meter_key text NOT NULL CHECK (meter_key ~ '^[a-z][a-z0-9._-]{0,127}$'),
  billing_unit text NOT NULL CHECK (billing_unit = 'request'),
  price_book_key text NOT NULL,
  price_book_version integer NOT NULL CHECK (price_book_version > 0),
  currency char(3) NOT NULL CHECK (currency ~ '^[A-Z]{3}$'),
  unit_price_minor bigint NOT NULL
    CHECK (unit_price_minor BETWEEN 0 AND 9007199254740991),
  multiplier_ppm bigint NOT NULL
    CHECK (multiplier_ppm BETWEEN 0 AND 100000000),
  quoted_minor bigint NOT NULL
    CHECK (quoted_minor BETWEEN 0 AND 9007199254740991),
  charged_minor bigint NOT NULL DEFAULT 0
    CHECK (charged_minor >= 0 AND charged_minor <= quoted_minor),
  status text NOT NULL DEFAULT 'reserved'
    CHECK (status IN ('reserved', 'captured', 'released', 'unknown')),
  pricing_snapshot jsonb NOT NULL CHECK (jsonb_typeof(pricing_snapshot) = 'object'),
  created_at timestamptz NOT NULL DEFAULT now(),
  settled_at timestamptz,
  FOREIGN KEY (account_id, tenant_id)
    REFERENCES billing.credit_accounts(id, tenant_id) ON DELETE RESTRICT,
  CHECK (
    enforcement_mode = 'shadow'
    OR quoted_minor = 0
    OR account_id IS NOT NULL
  ),
  CHECK (
    (status = 'captured' AND settled_at IS NOT NULL)
    OR (status = 'released' AND settled_at IS NOT NULL)
    OR (status IN ('reserved', 'unknown') AND settled_at IS NULL)
  ),
  CHECK (
    (enforcement_mode = 'shadow' AND charged_minor = 0)
    OR (enforcement_mode = 'enforced' AND status = 'captured' AND charged_minor = quoted_minor)
    OR (enforcement_mode = 'enforced' AND status <> 'captured' AND charged_minor = 0)
  )
);

CREATE INDEX IF NOT EXISTS customer_charges_tenant_created_idx
  ON billing.customer_charges (tenant_id, created_at DESC);
CREATE INDEX IF NOT EXISTS customer_charges_consumer_created_idx
  ON billing.customer_charges (consumer_id, created_at DESC);
CREATE INDEX IF NOT EXISTS customer_charges_account_status_idx
  ON billing.customer_charges (account_id, status, created_at DESC)
  WHERE account_id IS NOT NULL;

CREATE TABLE IF NOT EXISTS billing.credit_ledger_entries (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  account_id uuid NOT NULL,
  tenant_id uuid NOT NULL,
  charge_id uuid REFERENCES billing.customer_charges(id) ON DELETE RESTRICT,
  usage_request_id uuid REFERENCES public.usage_requests(id) ON DELETE RESTRICT,
  kind text NOT NULL
    CHECK (kind IN ('topup', 'grant', 'hold', 'capture', 'release', 'refund', 'adjustment')),
  amount_minor bigint NOT NULL
    CHECK (amount_minor BETWEEN 1 AND 9007199254740991),
  available_delta_minor bigint NOT NULL DEFAULT 0
    CHECK (available_delta_minor BETWEEN -9007199254740991 AND 9007199254740991),
  held_delta_minor bigint NOT NULL DEFAULT 0
    CHECK (held_delta_minor BETWEEN -9007199254740991 AND 9007199254740991),
  account_revision bigint NOT NULL
    CHECK (account_revision BETWEEN 1 AND 9007199254740991),
  available_after_minor bigint NOT NULL
    CHECK (available_after_minor BETWEEN 0 AND 9007199254740991),
  held_after_minor bigint NOT NULL
    CHECK (held_after_minor BETWEEN 0 AND 9007199254740991),
  currency char(3) NOT NULL CHECK (currency ~ '^[A-Z]{3}$'),
  idempotency_key text NOT NULL
    CHECK (length(btrim(idempotency_key)) BETWEEN 1 AND 256),
  actor text NOT NULL CHECK (length(btrim(actor)) BETWEEN 1 AND 256),
  reason text NOT NULL
    CHECK (length(btrim(reason)) BETWEEN 1 AND 1024),
  external_reference text,
  metadata jsonb NOT NULL DEFAULT '{}'::jsonb
    CHECK (jsonb_typeof(metadata) = 'object'),
  created_at timestamptz NOT NULL DEFAULT now(),
  FOREIGN KEY (account_id, tenant_id)
    REFERENCES billing.credit_accounts(id, tenant_id) ON DELETE RESTRICT,
  UNIQUE (tenant_id, idempotency_key),
  UNIQUE (account_id, account_revision),
  CHECK (available_after_minor + held_after_minor <= 9007199254740991),
  CHECK (available_delta_minor <> 0 OR held_delta_minor <> 0),
  CHECK (
    (kind IN ('topup', 'grant', 'refund', 'adjustment')
      AND amount_minor::numeric = abs(available_delta_minor::numeric))
    OR (kind IN ('hold', 'capture', 'release')
      AND amount_minor::numeric = abs(held_delta_minor::numeric))
  ),
  CHECK (
    (kind IN ('topup', 'grant', 'refund')
      AND available_delta_minor > 0 AND held_delta_minor = 0)
    OR (kind = 'hold'
      AND available_delta_minor < 0
      AND held_delta_minor = -available_delta_minor)
    OR (kind = 'capture'
      AND available_delta_minor = 0 AND held_delta_minor < 0)
    OR (kind = 'release'
      AND available_delta_minor > 0
      AND held_delta_minor = -available_delta_minor)
    OR (kind = 'adjustment'
      AND available_delta_minor <> 0 AND held_delta_minor = 0)
  ),
  CHECK (
    (kind IN ('hold', 'capture', 'release', 'refund')
      AND charge_id IS NOT NULL AND usage_request_id IS NOT NULL)
    OR (kind IN ('topup', 'grant', 'adjustment')
      AND charge_id IS NULL AND usage_request_id IS NULL)
  )
);

CREATE UNIQUE INDEX IF NOT EXISTS credit_ledger_charge_transition_idx
  ON billing.credit_ledger_entries (charge_id, kind)
  WHERE kind IN ('hold', 'capture', 'release');
CREATE UNIQUE INDEX IF NOT EXISTS credit_ledger_charge_terminal_idx
  ON billing.credit_ledger_entries (charge_id)
  WHERE kind IN ('capture', 'release');
CREATE INDEX IF NOT EXISTS credit_ledger_account_created_idx
  ON billing.credit_ledger_entries (account_id, created_at DESC, id DESC);
CREATE INDEX IF NOT EXISTS credit_ledger_tenant_created_idx
  ON billing.credit_ledger_entries (tenant_id, created_at DESC, id DESC);

-- Balance columns are a transactionally-maintained projection of the
-- append-only ledger.  Direct balance edits are rejected.
CREATE OR REPLACE FUNCTION billing.protect_credit_account_projection()
RETURNS trigger
LANGUAGE plpgsql
AS $function$
DECLARE
  matching_ledger_entry_id uuid;
BEGIN
  IF TG_OP = 'INSERT' THEN
    IF NEW.available_minor <> 0 OR NEW.held_minor <> 0 OR NEW.revision <> 0 THEN
      RAISE EXCEPTION 'new credit accounts must start empty at revision zero'
        USING ERRCODE = '23514';
    END IF;
    RETURN NEW;
  END IF;
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'credit accounts cannot be deleted'
      USING ERRCODE = '55000';
  END IF;
  IF NEW.id IS DISTINCT FROM OLD.id
    OR NEW.tenant_id IS DISTINCT FROM OLD.tenant_id
    OR NEW.currency IS DISTINCT FROM OLD.currency
    OR NEW.created_at IS DISTINCT FROM OLD.created_at THEN
    RAISE EXCEPTION 'credit account identity is immutable'
      USING ERRCODE = '55000';
  END IF;
  IF NEW.revision <> OLD.revision + 1 THEN
    RAISE EXCEPTION 'credit account revision must increase by exactly one'
      USING ERRCODE = '23514';
  END IF;
  IF NEW.available_minor IS DISTINCT FROM OLD.available_minor
    OR NEW.held_minor IS DISTINCT FROM OLD.held_minor THEN
    IF NEW.status IS DISTINCT FROM OLD.status THEN
      RAISE EXCEPTION 'credit account status and balances cannot change together'
        USING ERRCODE = '55000';
    END IF;
    SELECT ledger_entry.id INTO matching_ledger_entry_id
      FROM billing.credit_ledger_entries ledger_entry
     WHERE ledger_entry.account_id = NEW.id
       AND ledger_entry.tenant_id = NEW.tenant_id
       AND ledger_entry.currency = NEW.currency
       AND ledger_entry.account_revision = NEW.revision
       AND ledger_entry.available_after_minor = NEW.available_minor
       AND ledger_entry.held_after_minor = NEW.held_minor
       AND OLD.available_minor + ledger_entry.available_delta_minor = NEW.available_minor
       AND OLD.held_minor + ledger_entry.held_delta_minor = NEW.held_minor;
    IF matching_ledger_entry_id IS NULL THEN
      RAISE EXCEPTION 'credit account balances can only change through the matching ledger revision'
        USING ERRCODE = '55000';
    END IF;
  END IF;
  NEW.updated_at := now();
  RETURN NEW;
END;
$function$;

DROP TRIGGER IF EXISTS credit_accounts_protect_projection
  ON billing.credit_accounts;
CREATE TRIGGER credit_accounts_protect_projection
BEFORE INSERT OR UPDATE OR DELETE ON billing.credit_accounts
FOR EACH ROW
EXECUTE FUNCTION billing.protect_credit_account_projection();

CREATE OR REPLACE FUNCTION billing.apply_credit_ledger_entry()
RETURNS trigger
LANGUAGE plpgsql
AS $function$
DECLARE
  charge billing.customer_charges%ROWTYPE;
  applied_account_id uuid;
  applied_account_revision bigint;
  applied_available_minor bigint;
  applied_held_minor bigint;
  refunded_minor bigint;
  linked_usage_status text;
BEGIN
  IF NEW.charge_id IS NOT NULL THEN
    SELECT * INTO charge
      FROM billing.customer_charges
     WHERE id = NEW.charge_id
     FOR UPDATE;
    IF NOT FOUND THEN
      RAISE EXCEPTION 'customer charge does not exist'
        USING ERRCODE = '23503';
    END IF;
    IF charge.tenant_id <> NEW.tenant_id
      OR charge.account_id IS DISTINCT FROM NEW.account_id THEN
      RAISE EXCEPTION 'ledger entry does not match its customer charge account'
        USING ERRCODE = '23514';
    END IF;
    IF NEW.usage_request_id IS DISTINCT FROM charge.usage_request_id THEN
      RAISE EXCEPTION 'ledger entry does not match its customer charge usage request'
        USING ERRCODE = '23514';
    END IF;
    SELECT request.status INTO linked_usage_status
      FROM public.usage_requests request
     WHERE request.id = charge.usage_request_id;
    IF NOT FOUND THEN
      RAISE EXCEPTION 'ledger entry customer usage request does not exist'
        USING ERRCODE = '23503';
    END IF;
    IF charge.enforcement_mode <> 'enforced' OR charge.quoted_minor <= 0 THEN
      RAISE EXCEPTION 'only a positive enforced customer charge may move wallet funds'
        USING ERRCODE = '23514';
    END IF;
    IF NEW.currency <> charge.currency
      OR (NEW.kind IN ('hold', 'capture', 'release')
          AND NEW.amount_minor <> charge.quoted_minor)
      OR (NEW.kind = 'refund' AND NEW.amount_minor <> NEW.available_delta_minor) THEN
      RAISE EXCEPTION 'ledger amount or currency does not match its customer charge'
        USING ERRCODE = '23514';
    END IF;

    IF NEW.kind = 'hold' AND (
      charge.status <> 'reserved'
      OR linked_usage_status <> 'reserved'
      OR NEW.available_delta_minor <> -charge.quoted_minor
      OR NEW.held_delta_minor <> charge.quoted_minor
    ) THEN
      RAISE EXCEPTION 'invalid hold for customer charge'
        USING ERRCODE = '23514';
    ELSIF NEW.kind = 'capture' AND (
      NOT (
        (charge.status = 'reserved' AND linked_usage_status = 'committed')
        OR (charge.status = 'unknown' AND linked_usage_status IN ('committed', 'unknown'))
      )
      OR NEW.available_delta_minor <> 0
      OR NEW.held_delta_minor <> -charge.quoted_minor
    ) THEN
      RAISE EXCEPTION 'invalid capture for customer charge'
        USING ERRCODE = '23514';
    ELSIF NEW.kind = 'release' AND (
      NOT (
        (charge.status = 'reserved' AND linked_usage_status = 'released')
        OR (charge.status = 'unknown' AND linked_usage_status IN ('released', 'unknown'))
      )
      OR NEW.available_delta_minor <> charge.quoted_minor
      OR NEW.held_delta_minor <> -charge.quoted_minor
    ) THEN
      RAISE EXCEPTION 'invalid release for customer charge'
        USING ERRCODE = '23514';
    ELSIF NEW.kind = 'refund' THEN
      IF charge.status <> 'captured'
        OR NEW.held_delta_minor <> 0
        OR NEW.available_delta_minor <= 0 THEN
        RAISE EXCEPTION 'invalid refund for customer charge'
          USING ERRCODE = '23514';
      END IF;
      SELECT coalesce(sum(available_delta_minor), 0)::bigint INTO refunded_minor
        FROM billing.credit_ledger_entries
       WHERE charge_id = NEW.charge_id AND kind = 'refund';
      IF refunded_minor + NEW.available_delta_minor > charge.charged_minor THEN
        RAISE EXCEPTION 'refund exceeds the captured customer charge'
          USING ERRCODE = '23514';
      END IF;
    END IF;
  END IF;

  SELECT account.id,
         account.revision + 1,
         account.available_minor + NEW.available_delta_minor,
         account.held_minor + NEW.held_delta_minor
    INTO applied_account_id, applied_account_revision,
         applied_available_minor, applied_held_minor
    FROM billing.credit_accounts account
   WHERE account.id = NEW.account_id
     AND account.tenant_id = NEW.tenant_id
     AND account.currency = NEW.currency
     AND account.status <> 'closed'
     AND (NEW.kind <> 'hold' OR account.status = 'active')
   FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'billing_credit_account_unavailable'
      USING ERRCODE = 'P0001',
            DETAIL = 'The ledger tenant or currency does not match an open credit account.';
  END IF;

  IF applied_available_minor < 0 OR applied_held_minor < 0 THEN
    RAISE EXCEPTION 'insufficient_credit'
      USING ERRCODE = 'P0001',
            DETAIL = 'The credit ledger entry would make available or held credit negative.';
  END IF;

  NEW.account_revision := applied_account_revision;
  NEW.available_after_minor := applied_available_minor;
  NEW.held_after_minor := applied_held_minor;
  RETURN NEW;
END;
$function$;

DROP TRIGGER IF EXISTS credit_ledger_entries_apply
  ON billing.credit_ledger_entries;
CREATE TRIGGER credit_ledger_entries_apply
BEFORE INSERT ON billing.credit_ledger_entries
FOR EACH ROW
EXECUTE FUNCTION billing.apply_credit_ledger_entry();

-- Applying the account projection after conflict arbitration is essential:
-- INSERT ... ON CONFLICT DO NOTHING runs BEFORE triggers even for a skipped
-- row.  The BEFORE trigger only validates, locks and prices the prospective
-- revision; this AFTER trigger is the first place that moves money.
-- Hub writers issue one ledger row per INSERT statement.  A multi-row INSERT
-- for one account is intentionally unsupported because its rows can prepare
-- against the same pre-statement account revision.
CREATE OR REPLACE FUNCTION billing.apply_credit_ledger_projection()
RETURNS trigger
LANGUAGE plpgsql
AS $function$
DECLARE
  projected_account_id uuid;
BEGIN
  UPDATE billing.credit_accounts
     SET available_minor = NEW.available_after_minor,
         held_minor = NEW.held_after_minor,
         revision = NEW.account_revision,
         updated_at = now()
   WHERE id = NEW.account_id
     AND tenant_id = NEW.tenant_id
     AND currency = NEW.currency
     AND status <> 'closed'
     AND revision = NEW.account_revision - 1
     AND available_minor + NEW.available_delta_minor = NEW.available_after_minor
     AND held_minor + NEW.held_delta_minor = NEW.held_after_minor
  RETURNING id INTO projected_account_id;

  IF projected_account_id IS NULL THEN
    RAISE EXCEPTION 'billing_credit_projection_conflict'
      USING ERRCODE = '55000',
            DETAIL = 'The locked credit-account revision changed before ledger projection.';
  END IF;
  RETURN NULL;
END;
$function$;

DROP TRIGGER IF EXISTS credit_ledger_entries_project
  ON billing.credit_ledger_entries;
CREATE TRIGGER credit_ledger_entries_project
AFTER INSERT ON billing.credit_ledger_entries
FOR EACH ROW
EXECUTE FUNCTION billing.apply_credit_ledger_projection();

CREATE OR REPLACE FUNCTION billing.validate_terminal_ledger_charge()
RETURNS trigger
LANGUAGE plpgsql
AS $function$
DECLARE
  expected_charge_status text;
BEGIN
  IF NEW.kind NOT IN ('capture', 'release') THEN
    RETURN NULL;
  END IF;
  expected_charge_status := CASE NEW.kind
    WHEN 'capture' THEN 'captured'
    ELSE 'released'
  END;
  PERFORM 1
    FROM billing.customer_charges customer_charge
   WHERE customer_charge.id = NEW.charge_id
     AND customer_charge.status = expected_charge_status;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'terminal ledger entry requires the matching settled customer charge'
      USING ERRCODE = '23514';
  END IF;
  RETURN NULL;
END;
$function$;

DROP TRIGGER IF EXISTS credit_ledger_terminal_charge_consistency
  ON billing.credit_ledger_entries;
CREATE CONSTRAINT TRIGGER credit_ledger_terminal_charge_consistency
AFTER INSERT ON billing.credit_ledger_entries
DEFERRABLE INITIALLY DEFERRED
FOR EACH ROW
EXECUTE FUNCTION billing.validate_terminal_ledger_charge();

CREATE OR REPLACE FUNCTION billing.reject_credit_ledger_mutation()
RETURNS trigger
LANGUAGE plpgsql
AS $function$
BEGIN
  RAISE EXCEPTION 'credit ledger entries are append-only'
    USING ERRCODE = '55000';
END;
$function$;

DROP TRIGGER IF EXISTS credit_ledger_entries_no_row_mutation
  ON billing.credit_ledger_entries;
CREATE TRIGGER credit_ledger_entries_no_row_mutation
BEFORE UPDATE OR DELETE ON billing.credit_ledger_entries
FOR EACH ROW
EXECUTE FUNCTION billing.reject_credit_ledger_mutation();

DROP TRIGGER IF EXISTS credit_ledger_entries_no_truncate
  ON billing.credit_ledger_entries;
CREATE TRIGGER credit_ledger_entries_no_truncate
BEFORE TRUNCATE ON billing.credit_ledger_entries
FOR EACH STATEMENT
EXECUTE FUNCTION billing.reject_credit_ledger_mutation();

-- Charges are generated and settled only by the usage triggers below.  Their
-- pricing columns are immutable request-time snapshots.
CREATE OR REPLACE FUNCTION billing.protect_customer_charge()
RETURNS trigger
LANGUAGE plpgsql
AS $function$
DECLARE
  linked_usage public.usage_requests%ROWTYPE;
  expected_profile_mode text;
  expected_profile_multiplier_ppm bigint;
  expected_plan_version_id uuid;
  expected_price_book_id uuid;
  expected_price_book_key text;
  expected_price_book_version integer;
  expected_currency char(3);
  expected_default_multiplier_ppm bigint;
  expected_billing_unit text;
  expected_unit_price_minor bigint;
  expected_multiplier_ppm bigint;
  expected_quoted_numeric numeric;
  expected_quoted_minor bigint;
  expected_pricing_snapshot jsonb;
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'customer charges cannot be deleted'
      USING ERRCODE = '55000';
  END IF;

  IF TG_OP = 'INSERT' THEN
    -- Exact relational validation is the authority boundary. Trigger nesting
    -- depth is deliberately not used: an unrelated nested trigger is not
    -- proof that the write came from the usage billing state machine.
    PERFORM pg_advisory_xact_lock_shared(
      hashtext('billing:tenant:' || NEW.tenant_id::text)
    );

    SELECT * INTO linked_usage
      FROM public.usage_requests request
     WHERE request.id = NEW.usage_request_id
     FOR KEY SHARE;
    IF NOT FOUND
      OR linked_usage.status <> 'reserved'
      OR linked_usage.tenant_id <> NEW.tenant_id
      OR linked_usage.consumer_id <> NEW.consumer_id
      OR linked_usage.api_key_id <> NEW.api_key_id
      OR linked_usage.billing_meter_key IS DISTINCT FROM NEW.meter_key THEN
      RAISE EXCEPTION 'customer charge does not match a reserved usage request'
        USING ERRCODE = '23514';
    END IF;

    SELECT assignment.plan_version_id, plan_version_record.customer_price_book_id
      INTO expected_plan_version_id, expected_price_book_id
      FROM consumer_plan_assignments assignment
      JOIN plan_versions plan_version_record
        ON plan_version_record.id = assignment.plan_version_id
     WHERE assignment.consumer_id = NEW.consumer_id
     FOR SHARE OF assignment, plan_version_record;
    IF NOT FOUND
      OR expected_plan_version_id IS DISTINCT FROM NEW.plan_version_id
      OR expected_price_book_id IS DISTINCT FROM NEW.price_book_id THEN
      RAISE EXCEPTION 'customer charge does not match the assigned customer price book'
        USING ERRCODE = '23514';
    END IF;

    SELECT profile.mode, profile.multiplier_ppm
      INTO expected_profile_mode, expected_profile_multiplier_ppm
      FROM billing.tenant_billing_profiles profile
     WHERE profile.tenant_id = NEW.tenant_id;
    IF NOT FOUND
      OR expected_profile_mode = 'disabled'
      OR expected_profile_mode IS DISTINCT FROM NEW.enforcement_mode THEN
      RAISE EXCEPTION 'customer charge does not match the tenant billing profile'
        USING ERRCODE = '23514';
    END IF;

    SELECT price_book.price_book_key, price_book.version, price_book.currency,
           price_book.default_multiplier_ppm, price_entry.billing_unit,
           price_entry.unit_price_minor
      INTO expected_price_book_key, expected_price_book_version,
           expected_currency, expected_default_multiplier_ppm,
           expected_billing_unit, expected_unit_price_minor
      FROM billing.customer_price_books price_book
      JOIN billing.customer_price_entries price_entry
        ON price_entry.price_book_id = price_book.id
     WHERE price_book.id = NEW.price_book_id
       AND price_book.status IN ('published', 'retired')
       AND price_entry.id = NEW.price_entry_id
       AND price_entry.meter_key = NEW.meter_key
     FOR SHARE OF price_book, price_entry;
    expected_multiplier_ppm := coalesce(
      expected_profile_multiplier_ppm,
      expected_default_multiplier_ppm
    );
    expected_quoted_numeric := ceil(
      expected_unit_price_minor::numeric
        * expected_multiplier_ppm::numeric / 1000000::numeric
    );
    IF NOT FOUND
      OR expected_price_book_key IS DISTINCT FROM NEW.price_book_key
      OR expected_price_book_version IS DISTINCT FROM NEW.price_book_version
      OR expected_currency IS DISTINCT FROM NEW.currency
      OR expected_billing_unit IS DISTINCT FROM NEW.billing_unit
      OR expected_unit_price_minor IS DISTINCT FROM NEW.unit_price_minor
      OR expected_multiplier_ppm IS DISTINCT FROM NEW.multiplier_ppm
      OR expected_quoted_numeric IS DISTINCT FROM NEW.quoted_minor::numeric THEN
      RAISE EXCEPTION 'customer charge pricing snapshot does not match its price entry'
        USING ERRCODE = '23514';
    END IF;
    expected_quoted_minor := expected_quoted_numeric::bigint;
    expected_pricing_snapshot := jsonb_build_object(
      'meterKey', NEW.meter_key,
      'billingUnit', expected_billing_unit,
      'priceBookKey', expected_price_book_key,
      'priceBookVersion', expected_price_book_version,
      'currency', expected_currency,
      'unitPriceMinor', expected_unit_price_minor,
      'multiplierPpm', expected_multiplier_ppm,
      'quotedMinor', expected_quoted_minor
    );
    IF NEW.status <> 'reserved'
      OR NEW.charged_minor <> 0
      OR NEW.settled_at IS NOT NULL
      OR NEW.pricing_snapshot IS DISTINCT FROM expected_pricing_snapshot THEN
      RAISE EXCEPTION 'new customer charges must be exact reserved pricing snapshots'
        USING ERRCODE = '23514';
    END IF;
    IF expected_profile_mode = 'enforced' AND expected_quoted_minor > 0 THEN
      PERFORM 1
        FROM billing.credit_accounts account
       WHERE account.id = NEW.account_id
         AND account.tenant_id = NEW.tenant_id
         AND account.currency = NEW.currency
         AND account.status = 'active';
      IF NOT FOUND THEN
        RAISE EXCEPTION 'positive enforced charges require the tenant active credit account'
          USING ERRCODE = '23514';
      END IF;
    ELSIF NEW.account_id IS NOT NULL THEN
      RAISE EXCEPTION 'shadow and zero-price charges must not bind a credit account'
        USING ERRCODE = '23514';
    END IF;
    RETURN NEW;
  END IF;

  IF TG_OP = 'UPDATE' AND (
    NEW.id IS DISTINCT FROM OLD.id
    OR NEW.usage_request_id IS DISTINCT FROM OLD.usage_request_id
    OR NEW.tenant_id IS DISTINCT FROM OLD.tenant_id
    OR NEW.consumer_id IS DISTINCT FROM OLD.consumer_id
    OR NEW.api_key_id IS DISTINCT FROM OLD.api_key_id
    OR NEW.account_id IS DISTINCT FROM OLD.account_id
    OR NEW.plan_version_id IS DISTINCT FROM OLD.plan_version_id
    OR NEW.price_book_id IS DISTINCT FROM OLD.price_book_id
    OR NEW.price_entry_id IS DISTINCT FROM OLD.price_entry_id
    OR NEW.enforcement_mode IS DISTINCT FROM OLD.enforcement_mode
    OR NEW.meter_key IS DISTINCT FROM OLD.meter_key
    OR NEW.billing_unit IS DISTINCT FROM OLD.billing_unit
    OR NEW.price_book_key IS DISTINCT FROM OLD.price_book_key
    OR NEW.price_book_version IS DISTINCT FROM OLD.price_book_version
    OR NEW.currency IS DISTINCT FROM OLD.currency
    OR NEW.unit_price_minor IS DISTINCT FROM OLD.unit_price_minor
    OR NEW.multiplier_ppm IS DISTINCT FROM OLD.multiplier_ppm
    OR NEW.quoted_minor IS DISTINCT FROM OLD.quoted_minor
    OR NEW.pricing_snapshot IS DISTINCT FROM OLD.pricing_snapshot
    OR NEW.created_at IS DISTINCT FROM OLD.created_at
  ) THEN
    RAISE EXCEPTION 'customer charge pricing snapshots are immutable'
      USING ERRCODE = '55000';
  END IF;

  IF NEW.status = OLD.status
    AND NEW.charged_minor IS NOT DISTINCT FROM OLD.charged_minor
    AND NEW.settled_at IS NOT DISTINCT FROM OLD.settled_at THEN
    RETURN NEW;
  END IF;
  IF OLD.status IN ('captured', 'released') THEN
    RAISE EXCEPTION 'financially settled customer charges are immutable'
      USING ERRCODE = '55000';
  END IF;

  SELECT * INTO linked_usage
    FROM public.usage_requests request
   WHERE request.id = NEW.usage_request_id;
  IF NEW.status = 'unknown' THEN
    IF linked_usage.status <> 'unknown'
      OR NEW.charged_minor <> 0
      OR NEW.settled_at IS NOT NULL THEN
      RAISE EXCEPTION 'unknown customer charge does not match usage state'
        USING ERRCODE = '23514';
    END IF;
    RETURN NEW;
  END IF;
  IF NEW.status = 'captured' THEN
    IF linked_usage.status NOT IN ('committed', 'unknown')
      OR (linked_usage.status = 'unknown'
        AND (NEW.enforcement_mode <> 'enforced' OR NEW.quoted_minor <= 0))
      OR NEW.charged_minor <> (CASE
        WHEN NEW.enforcement_mode = 'enforced' THEN NEW.quoted_minor
        ELSE 0
      END)
      OR NEW.settled_at IS NULL THEN
      RAISE EXCEPTION 'captured customer charge does not match committed usage'
        USING ERRCODE = '23514';
    END IF;
    IF NEW.enforcement_mode = 'enforced' AND NEW.quoted_minor > 0 THEN
      PERFORM 1
        FROM billing.credit_ledger_entries ledger_entry
       WHERE ledger_entry.charge_id = NEW.id
         AND ledger_entry.kind = 'capture'
         AND ledger_entry.amount_minor = NEW.quoted_minor;
      IF NOT FOUND THEN
        RAISE EXCEPTION 'captured customer charge requires its capture ledger entry'
          USING ERRCODE = '23514';
      END IF;
    END IF;
    RETURN NEW;
  END IF;
  IF NEW.status = 'released' THEN
    IF linked_usage.status NOT IN ('released', 'unknown')
      OR (linked_usage.status = 'unknown'
        AND (NEW.enforcement_mode <> 'enforced' OR NEW.quoted_minor <= 0))
      OR NEW.charged_minor <> 0
      OR NEW.settled_at IS NULL THEN
      RAISE EXCEPTION 'released customer charge does not match released usage'
        USING ERRCODE = '23514';
    END IF;
    IF NEW.enforcement_mode = 'enforced' AND NEW.quoted_minor > 0 THEN
      PERFORM 1
        FROM billing.credit_ledger_entries ledger_entry
       WHERE ledger_entry.charge_id = NEW.id
         AND ledger_entry.kind = 'release'
         AND ledger_entry.amount_minor = NEW.quoted_minor;
      IF NOT FOUND THEN
        RAISE EXCEPTION 'released customer charge requires its release ledger entry'
          USING ERRCODE = '23514';
      END IF;
    END IF;
    RETURN NEW;
  END IF;

  RAISE EXCEPTION 'unsupported customer charge state transition: % to %', OLD.status, NEW.status
    USING ERRCODE = '23514';
END;
$function$;

DROP TRIGGER IF EXISTS customer_charges_protect
  ON billing.customer_charges;
CREATE TRIGGER customer_charges_protect
BEFORE INSERT OR UPDATE OR DELETE ON billing.customer_charges
FOR EACH ROW
EXECUTE FUNCTION billing.protect_customer_charge();

ALTER TABLE public.usage_requests
  ADD COLUMN IF NOT EXISTS billing_meter_key text;

DO $migration$
BEGIN
  IF NOT EXISTS (
    SELECT 1
      FROM pg_constraint
     WHERE conname = 'usage_requests_billing_meter_key_check'
       AND conrelid = 'public.usage_requests'::regclass
  ) THEN
    ALTER TABLE public.usage_requests
      ADD CONSTRAINT usage_requests_billing_meter_key_check
      CHECK (
        billing_meter_key IS NULL
        OR billing_meter_key ~ '^[a-z][a-z0-9._-]{0,127}$'
      ) NOT VALID;
  END IF;
END
$migration$;

CREATE OR REPLACE FUNCTION billing.default_usage_meter_key()
RETURNS trigger
LANGUAGE plpgsql
AS $function$
BEGIN
  IF TG_OP = 'UPDATE' THEN
    IF NEW.billing_meter_key IS DISTINCT FROM OLD.billing_meter_key THEN
      RAISE EXCEPTION 'usage request billing meter key is immutable'
        USING ERRCODE = '55000';
    END IF;
    RETURN NEW;
  END IF;

  IF NEW.billing_meter_key IS NULL OR btrim(NEW.billing_meter_key) = '' THEN
    NEW.billing_meter_key := lower(btrim(CASE
      WHEN NEW.capability IS NOT NULL THEN NEW.capability
      WHEN NEW.platform IS NOT NULL THEN NEW.platform
      ELSE NULL
    END));
  ELSE
    NEW.billing_meter_key := lower(btrim(NEW.billing_meter_key));
  END IF;
  RETURN NEW;
END;
$function$;

DROP TRIGGER IF EXISTS usage_requests_default_billing_meter
  ON public.usage_requests;
CREATE TRIGGER usage_requests_default_billing_meter
BEFORE INSERT OR UPDATE OF billing_meter_key ON public.usage_requests
FOR EACH ROW
EXECUTE FUNCTION billing.default_usage_meter_key();

CREATE OR REPLACE FUNCTION billing.reserve_customer_charge()
RETURNS trigger
LANGUAGE plpgsql
AS $function$
DECLARE
  profile_mode text;
  profile_multiplier_ppm bigint;
  assigned_plan_version_id uuid;
  assigned_price_book_id uuid;
  selected_price_book_key text;
  selected_price_book_version integer;
  selected_currency char(3);
  selected_default_multiplier_ppm bigint;
  selected_price_entry_id uuid;
  selected_billing_unit text;
  selected_unit_price_minor bigint;
  quoted_numeric numeric;
  quoted_minor bigint;
  selected_account_id uuid;
  charge_id uuid;
BEGIN
  IF NEW.status <> 'reserved' OR NEW.billing_meter_key IS NULL THEN
    RETURN NEW;
  END IF;

  -- Profile creation/update takes the same lock.  Whichever transaction wins
  -- defines a clean boundary between legacy-unbilled and priced requests.
  PERFORM pg_advisory_xact_lock_shared(hashtext('billing:tenant:' || NEW.tenant_id::text));

  -- The advisory lock is the profile consistency fence.  Do not also take a
  -- row lock here: a direct UPDATE acquires its row lock before its BEFORE
  -- trigger takes the exclusive advisory lock, so FOR SHARE would invert the
  -- order and permit a deadlock.
  SELECT mode, multiplier_ppm
    INTO profile_mode, profile_multiplier_ppm
    FROM billing.tenant_billing_profiles
   WHERE tenant_id = NEW.tenant_id;
  IF NOT FOUND OR profile_mode = 'disabled' THEN
    RETURN NEW;
  END IF;

  SELECT assignment.plan_version_id, plan_version_record.customer_price_book_id
    INTO assigned_plan_version_id, assigned_price_book_id
    FROM consumer_plan_assignments assignment
    JOIN plan_versions plan_version_record
      ON plan_version_record.id = assignment.plan_version_id
   WHERE assignment.consumer_id = NEW.consumer_id
   FOR SHARE OF assignment, plan_version_record;

  -- This is the grandfathering fence for every plan published before 056.
  IF NOT FOUND OR assigned_price_book_id IS NULL THEN
    RETURN NEW;
  END IF;

  PERFORM 1
    FROM consumers consumer
    JOIN api_keys api_key_record
      ON api_key_record.id = NEW.api_key_id
     AND api_key_record.consumer_id = consumer.id
     AND api_key_record.tenant_id = consumer.tenant_id
   WHERE consumer.id = NEW.consumer_id
     AND consumer.tenant_id = NEW.tenant_id;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'billable usage tenant, consumer and API key scope do not match'
      USING ERRCODE = '23514';
  END IF;

  SELECT price_book.price_book_key, price_book.version, price_book.currency,
         price_book.default_multiplier_ppm, price_entry.id,
         price_entry.billing_unit, price_entry.unit_price_minor
    INTO selected_price_book_key, selected_price_book_version, selected_currency,
         selected_default_multiplier_ppm, selected_price_entry_id,
         selected_billing_unit, selected_unit_price_minor
    FROM billing.customer_price_books price_book
    JOIN billing.customer_price_entries price_entry
      ON price_entry.price_book_id = price_book.id
     AND price_entry.meter_key = NEW.billing_meter_key
   WHERE price_book.id = assigned_price_book_id
     AND price_book.status IN ('published', 'retired')
   FOR SHARE OF price_book, price_entry;

  IF NOT FOUND THEN
    IF profile_mode = 'enforced' THEN
      RAISE EXCEPTION 'customer_price_unavailable'
        USING ERRCODE = 'P0001',
              DETAIL = 'The assigned customer price book has no published entry for this billing meter.';
    END IF;
    -- Shadow mode observes only complete prices and never disrupts traffic.
    RETURN NEW;
  END IF;

  profile_multiplier_ppm := coalesce(
    profile_multiplier_ppm,
    selected_default_multiplier_ppm
  );

  quoted_numeric := ceil(
    selected_unit_price_minor::numeric * profile_multiplier_ppm::numeric / 1000000::numeric
  );
  IF quoted_numeric > 9007199254740991::numeric THEN
    RAISE EXCEPTION 'customer charge exceeds the API safe-integer range'
      USING ERRCODE = '22003';
  END IF;
  quoted_minor := quoted_numeric::bigint;

  IF profile_mode = 'enforced' AND quoted_minor > 0 THEN
    SELECT id INTO selected_account_id
      FROM billing.credit_accounts
     WHERE tenant_id = NEW.tenant_id
       AND currency = selected_currency
       AND status = 'active'
     FOR UPDATE;
    IF NOT FOUND THEN
      RAISE EXCEPTION 'insufficient_credit'
        USING ERRCODE = 'P0001',
              DETAIL = 'An active credit account in the customer price-book currency is required.';
    END IF;
  END IF;

  charge_id := gen_random_uuid();
  INSERT INTO billing.customer_charges
    (id, usage_request_id, tenant_id, consumer_id, api_key_id, account_id,
     plan_version_id, price_book_id, price_entry_id, enforcement_mode,
     meter_key, billing_unit, price_book_key, price_book_version, currency,
     unit_price_minor, multiplier_ppm, quoted_minor, charged_minor, status,
     pricing_snapshot)
  VALUES
    (charge_id, NEW.id, NEW.tenant_id, NEW.consumer_id, NEW.api_key_id,
     selected_account_id, assigned_plan_version_id, assigned_price_book_id,
     selected_price_entry_id, profile_mode, NEW.billing_meter_key,
     selected_billing_unit, selected_price_book_key, selected_price_book_version,
     selected_currency,
     selected_unit_price_minor, profile_multiplier_ppm, quoted_minor, 0,
     'reserved',
     jsonb_build_object(
       'meterKey', NEW.billing_meter_key,
       'billingUnit', selected_billing_unit,
       'priceBookKey', selected_price_book_key,
       'priceBookVersion', selected_price_book_version,
       'currency', selected_currency,
       'unitPriceMinor', selected_unit_price_minor,
       'multiplierPpm', profile_multiplier_ppm,
       'quotedMinor', quoted_minor
     ));

  IF profile_mode = 'enforced' AND quoted_minor > 0 THEN
    INSERT INTO billing.credit_ledger_entries
      (account_id, tenant_id, charge_id, usage_request_id, kind,
       amount_minor, available_delta_minor, held_delta_minor, currency,
       idempotency_key, actor, reason)
    VALUES
      (selected_account_id, NEW.tenant_id, charge_id, NEW.id, 'hold',
       quoted_minor, -quoted_minor, quoted_minor, selected_currency,
       'usage:' || NEW.id || ':hold',
       'usage-trigger', 'Customer charge reservation');
  END IF;

  RETURN NEW;
END;
$function$;

DROP TRIGGER IF EXISTS usage_requests_reserve_customer_charge
  ON public.usage_requests;
CREATE TRIGGER usage_requests_reserve_customer_charge
AFTER INSERT ON public.usage_requests
FOR EACH ROW
EXECUTE FUNCTION billing.reserve_customer_charge();

CREATE OR REPLACE FUNCTION billing.settle_customer_charge()
RETURNS trigger
LANGUAGE plpgsql
AS $function$
DECLARE
  charge billing.customer_charges%ROWTYPE;
BEGIN
  IF NEW.status = OLD.status THEN
    RETURN NEW;
  END IF;

  SELECT * INTO charge
    FROM billing.customer_charges
   WHERE usage_request_id = NEW.id
   FOR UPDATE;
  IF NOT FOUND THEN
    RETURN NEW;
  END IF;

  -- Preserve the existing ambiguity path: if a caller could not observe an
  -- already-committed result, usage may be marked unknown, but the captured
  -- financial fact remains terminal and is never charged or released again.
  IF OLD.status = 'committed' AND NEW.status = 'unknown'
    AND charge.status = 'captured' THEN
    RETURN NEW;
  END IF;

  -- An operator may reconcile only the financial uncertainty while preserving
  -- usage.status = unknown as the delivery truth.  If delivery evidence later
  -- resolves to the same outcome, accept it without a second wallet movement.
  IF OLD.status = 'unknown' AND NEW.status = 'committed'
    AND charge.status = 'captured' THEN
    RETURN NEW;
  END IF;
  IF OLD.status = 'unknown' AND NEW.status = 'released'
    AND charge.status = 'released' THEN
    RETURN NEW;
  END IF;

  IF OLD.status NOT IN ('reserved', 'unknown') THEN
    RAISE EXCEPTION 'a financially settled usage request cannot change billing state'
      USING ERRCODE = '55000';
  END IF;
  IF charge.status NOT IN ('reserved', 'unknown') THEN
    RAISE EXCEPTION 'customer charge is already financially settled'
      USING ERRCODE = '55000';
  END IF;

  IF NEW.status = 'unknown' THEN
    UPDATE billing.customer_charges
       SET status = 'unknown'
     WHERE id = charge.id;
    RETURN NEW;
  END IF;

  IF NEW.status = 'committed' THEN
    IF charge.enforcement_mode = 'enforced' AND charge.quoted_minor > 0 THEN
      INSERT INTO billing.credit_ledger_entries
        (account_id, tenant_id, charge_id, usage_request_id, kind,
         amount_minor, available_delta_minor, held_delta_minor, currency,
         idempotency_key, actor, reason)
      VALUES
        (charge.account_id, charge.tenant_id, charge.id, charge.usage_request_id,
         'capture', charge.quoted_minor, 0, -charge.quoted_minor, charge.currency,
         'usage:' || charge.usage_request_id || ':capture',
         'usage-trigger', 'Committed customer delivery');
    END IF;
    UPDATE billing.customer_charges
       SET status = 'captured',
           charged_minor = CASE
             WHEN enforcement_mode = 'enforced' THEN quoted_minor
             ELSE 0
           END,
           settled_at = now()
     WHERE id = charge.id;
    RETURN NEW;
  END IF;

  IF NEW.status = 'released' THEN
    IF charge.enforcement_mode = 'enforced' AND charge.quoted_minor > 0 THEN
      INSERT INTO billing.credit_ledger_entries
        (account_id, tenant_id, charge_id, usage_request_id, kind,
         amount_minor, available_delta_minor, held_delta_minor, currency,
         idempotency_key, actor, reason)
      VALUES
        (charge.account_id, charge.tenant_id, charge.id, charge.usage_request_id,
         'release', charge.quoted_minor, charge.quoted_minor,
         -charge.quoted_minor, charge.currency,
         'usage:' || charge.usage_request_id || ':release',
         'usage-trigger', 'Released customer charge reservation');
    END IF;
    UPDATE billing.customer_charges
       SET status = 'released', charged_minor = 0, settled_at = now()
     WHERE id = charge.id;
    RETURN NEW;
  END IF;

  RAISE EXCEPTION 'unsupported billed usage state transition: % to %', OLD.status, NEW.status
    USING ERRCODE = '23514';
END;
$function$;

DROP TRIGGER IF EXISTS usage_requests_settle_customer_charge
  ON public.usage_requests;
CREATE TRIGGER usage_requests_settle_customer_charge
AFTER UPDATE OF status ON public.usage_requests
FOR EACH ROW
WHEN (OLD.status IS DISTINCT FROM NEW.status)
EXECUTE FUNCTION billing.settle_customer_charge();

-- Resolve only the financial side of an ambiguous delivery.  The usage row
-- intentionally remains unknown; operator evidence is carried by the unique
-- terminal ledger entry.  Replaying the exact command is read-only, while any
-- reuse with different semantics fails closed.
CREATE OR REPLACE FUNCTION billing.reconcile_unknown_customer_charge(
  p_usage_request_id uuid,
  p_disposition text,
  p_idempotency_key text,
  p_actor text,
  p_reason text
)
RETURNS billing.customer_charges
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, billing
AS $function$
DECLARE
  charge billing.customer_charges%ROWTYPE;
  terminal_entry billing.credit_ledger_entries%ROWTYPE;
  idempotency_entry billing.credit_ledger_entries%ROWTYPE;
  expected_kind text;
  expected_status text;
  normalized_idempotency_key text := btrim(p_idempotency_key);
  normalized_actor text := btrim(p_actor);
  normalized_reason text := btrim(p_reason);
BEGIN
  IF p_disposition NOT IN ('capture', 'release') THEN
    RAISE EXCEPTION 'billing reconciliation disposition must be capture or release'
      USING ERRCODE = '22023';
  END IF;
  IF normalized_idempotency_key IS NULL
    OR length(normalized_idempotency_key) NOT BETWEEN 1 AND 256
    OR normalized_actor IS NULL
    OR length(normalized_actor) NOT BETWEEN 1 AND 256
    OR normalized_reason IS NULL
    OR length(normalized_reason) NOT BETWEEN 1 AND 1024 THEN
    RAISE EXCEPTION 'billing reconciliation requires bounded idempotency, actor and reason text'
      USING ERRCODE = '22023';
  END IF;

  expected_kind := p_disposition;
  expected_status := CASE p_disposition
    WHEN 'capture' THEN 'captured'
    ELSE 'released'
  END;

  SELECT customer_charge.* INTO charge
    FROM billing.customer_charges customer_charge
   WHERE customer_charge.usage_request_id = p_usage_request_id
   FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'customer_charge_not_found'
      USING ERRCODE = 'P0002';
  END IF;
  PERFORM 1
    FROM public.usage_requests request
   WHERE request.id = p_usage_request_id
     AND request.status = 'unknown';
  IF NOT FOUND THEN
    RAISE EXCEPTION 'customer_charge_not_reconcilable'
      USING ERRCODE = 'P0001',
            DETAIL = 'Only a customer charge whose delivery remains unknown may be reconciled.';
  END IF;

  SELECT ledger_entry.* INTO terminal_entry
    FROM billing.credit_ledger_entries ledger_entry
   WHERE ledger_entry.charge_id = charge.id
     AND ledger_entry.kind IN ('capture', 'release');

  IF charge.status IN ('captured', 'released') THEN
    IF charge.status = expected_status
      AND terminal_entry.id IS NOT NULL
      AND terminal_entry.kind = expected_kind
      AND terminal_entry.idempotency_key = normalized_idempotency_key
      AND terminal_entry.actor = normalized_actor
      AND terminal_entry.reason = normalized_reason THEN
      RETURN charge;
    END IF;
    RAISE EXCEPTION 'reconciliation_idempotency_conflict'
      USING ERRCODE = 'P0001',
            DETAIL = 'The charge was already settled with different reconciliation semantics.';
  END IF;

  IF charge.status <> 'unknown'
    OR charge.enforcement_mode <> 'enforced'
    OR charge.quoted_minor <= 0
    OR charge.account_id IS NULL
    OR terminal_entry.id IS NOT NULL THEN
    RAISE EXCEPTION 'customer_charge_not_reconcilable'
      USING ERRCODE = 'P0001',
            DETAIL = 'Only a positive enforced hold with unknown delivery may be reconciled.';
  END IF;

  SELECT ledger_entry.* INTO idempotency_entry
    FROM billing.credit_ledger_entries ledger_entry
   WHERE ledger_entry.tenant_id = charge.tenant_id
     AND ledger_entry.idempotency_key = normalized_idempotency_key;
  IF FOUND THEN
    RAISE EXCEPTION 'reconciliation_idempotency_conflict'
      USING ERRCODE = 'P0001',
            DETAIL = 'The tenant idempotency key already belongs to another ledger movement.';
  END IF;

  INSERT INTO billing.credit_ledger_entries
    (account_id, tenant_id, charge_id, usage_request_id, kind,
     amount_minor, available_delta_minor, held_delta_minor, currency,
     idempotency_key, actor, reason)
  VALUES
    (charge.account_id, charge.tenant_id, charge.id, charge.usage_request_id,
     expected_kind, charge.quoted_minor,
     CASE WHEN expected_kind = 'release' THEN charge.quoted_minor ELSE 0 END,
     -charge.quoted_minor, charge.currency,
     normalized_idempotency_key, normalized_actor, normalized_reason);

  UPDATE billing.customer_charges customer_charge
     SET status = expected_status,
         charged_minor = CASE
           WHEN expected_status = 'captured' THEN quoted_minor
           ELSE 0
         END,
         settled_at = now()
   WHERE customer_charge.id = charge.id
  RETURNING customer_charge.* INTO charge;
  RETURN charge;
END;
$function$;

REVOKE ALL ON FUNCTION billing.reconcile_unknown_customer_charge(
  uuid, text, text, text, text
) FROM PUBLIC;

COMMENT ON TABLE billing.customer_price_books IS
  'Versioned customer sell-price books; provider procurement prices are intentionally separate.';
COMMENT ON TABLE billing.customer_price_entries IS
  'One request price per stable Hub billing meter in a customer price-book version.';
COMMENT ON TABLE billing.tenant_billing_profiles IS
  'Tenant billing rollout mode and integer price multiplier; absence is equivalent to disabled.';
COMMENT ON TABLE billing.credit_accounts IS
  'Tenant wallet projection. total credit is available_minor + held_minor; ledger entries are authoritative.';
COMMENT ON TABLE billing.customer_charges IS
  'Immutable request-time customer price snapshot and its financial settlement state.';
COMMENT ON TABLE billing.credit_ledger_entries IS
  'Append-only customer wallet movements; provider costs never enter this ledger.';
COMMENT ON COLUMN plan_versions.customer_price_book_id IS
  'Nullable immutable sell-price version. NULL preserves pre-056 plans as unbilled.';
COMMENT ON COLUMN public.usage_requests.billing_meter_key IS
  'Provider-neutral customer billing meter; defaults to capability or platform for new rows.';
