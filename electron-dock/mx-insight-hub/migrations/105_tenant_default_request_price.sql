-- A tenant default is opt-in for existing tenants (zero preserves free unlisted
-- operations). Explicit immutable plan entries, including zero, always win.
ALTER TABLE billing.tenant_billing_profiles
  ADD COLUMN default_unit_price_minor bigint NOT NULL DEFAULT 0
    CHECK (default_unit_price_minor BETWEEN 0 AND 9007199254740991),
  ADD COLUMN default_currency char(3) NOT NULL DEFAULT 'CNY'
    CHECK (default_currency ~ '^[A-Z]{3}$');

-- Default-price charges cite the revisioned profile in their immutable snapshot,
-- rather than fabricating a customer price book or rewriting existing contracts.
ALTER TABLE billing.customer_charges
  ALTER COLUMN price_book_id DROP NOT NULL,
  ALTER COLUMN price_entry_id DROP NOT NULL,
  ALTER COLUMN price_book_key DROP NOT NULL,
  ALTER COLUMN price_book_version DROP NOT NULL,
  ADD CONSTRAINT customer_charge_price_reference CHECK (
    (price_book_id IS NOT NULL AND price_entry_id IS NOT NULL
      AND price_book_key IS NOT NULL AND price_book_version IS NOT NULL)
    OR (price_book_id IS NULL AND price_entry_id IS NULL
      AND price_book_key IS NULL AND price_book_version IS NULL
      AND (pricing_snapshot->>'priceSource') IS NOT DISTINCT FROM 'tenant_default')
  );

-- Shared by reservation and INSERT validation; authorization remains in the
-- existing usage reservation path. No fee for deliberately unmetered parents.
CREATE OR REPLACE FUNCTION billing.customer_price_for_usage(
  p_tenant_id uuid, p_consumer_id uuid, p_meter_key text
) RETURNS TABLE (
  plan_version_id uuid, price_book_id uuid, price_entry_id uuid,
  enforcement_mode text, billing_unit text, price_book_key text,
  price_book_version integer, currency char(3), unit_price_minor bigint,
  multiplier_ppm bigint, quoted_minor bigint, pricing_snapshot jsonb
) LANGUAGE plpgsql AS $function$
DECLARE
  profile billing.tenant_billing_profiles%ROWTYPE;
  book billing.customer_price_books%ROWTYPE;
  entry billing.customer_price_entries%ROWTYPE;
  assigned_book_id uuid;
  quote numeric;
BEGIN
  IF p_meter_key IS NULL THEN RETURN; END IF;
  PERFORM pg_advisory_xact_lock_shared(hashtext('billing:tenant:' || p_tenant_id::text));
  SELECT * INTO profile FROM billing.tenant_billing_profiles WHERE tenant_id = p_tenant_id;
  IF NOT FOUND OR profile.mode = 'disabled' THEN RETURN; END IF;

  SELECT assignment.plan_version_id, version.customer_price_book_id
    INTO plan_version_id, assigned_book_id
    FROM consumer_plan_assignments assignment
    JOIN plan_versions version ON version.id = assignment.plan_version_id
   WHERE assignment.consumer_id = p_consumer_id
   FOR SHARE OF assignment, version;
  IF NOT FOUND THEN RETURN; END IF;

  IF assigned_book_id IS NOT NULL THEN
    SELECT * INTO book FROM billing.customer_price_books
     WHERE id = assigned_book_id AND status IN ('published', 'retired') FOR SHARE;
    IF NOT FOUND THEN
      IF profile.mode = 'enforced' THEN
        RAISE EXCEPTION 'customer_price_unavailable' USING ERRCODE = 'P0001';
      END IF;
      RETURN;
    END IF;
    SELECT * INTO entry FROM billing.customer_price_entries candidate
     WHERE candidate.price_book_id = assigned_book_id AND candidate.meter_key = p_meter_key FOR SHARE;
  END IF;

  enforcement_mode := profile.mode;
  billing_unit := 'request';
  IF entry.id IS NOT NULL THEN
    price_book_id := book.id;
    price_entry_id := entry.id;
    price_book_key := book.price_book_key;
    price_book_version := book.version;
    currency := book.currency;
    unit_price_minor := entry.unit_price_minor;
    multiplier_ppm := coalesce(profile.multiplier_ppm, book.default_multiplier_ppm);
  ELSE
    -- A zero fallback remains metered without generating new zero-charge rows.
    IF profile.default_unit_price_minor = 0 THEN RETURN; END IF;
    currency := profile.default_currency;
    unit_price_minor := profile.default_unit_price_minor;
    multiplier_ppm := 1000000;
  END IF;
  quote := ceil(unit_price_minor::numeric * multiplier_ppm::numeric / 1000000::numeric);
  IF quote > 9007199254740991::numeric THEN
    RAISE EXCEPTION 'customer charge exceeds the API safe-integer range' USING ERRCODE = '22003';
  END IF;
  quoted_minor := quote::bigint;
  pricing_snapshot := jsonb_build_object(
    'meterKey', p_meter_key, 'billingUnit', billing_unit,
    'priceBookKey', price_book_key, 'priceBookVersion', price_book_version,
    'currency', currency, 'unitPriceMinor', unit_price_minor,
    'multiplierPpm', multiplier_ppm, 'quotedMinor', quoted_minor
  );
  IF price_entry_id IS NULL THEN
    pricing_snapshot := pricing_snapshot || jsonb_build_object(
      'priceSource', 'tenant_default', 'billingProfileRevision', profile.revision
    );
  END IF;
  RETURN NEXT;
END;
$function$;

CREATE OR REPLACE FUNCTION billing.protect_customer_charge()
RETURNS trigger
LANGUAGE plpgsql
AS $function$
DECLARE
  linked_usage public.usage_requests%ROWTYPE;
  expected_price record;
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

    SELECT * INTO expected_price FROM billing.customer_price_for_usage(
      NEW.tenant_id, NEW.consumer_id, NEW.meter_key
    );
    IF NOT FOUND
      OR NEW.plan_version_id IS DISTINCT FROM expected_price.plan_version_id
      OR NEW.price_book_id IS DISTINCT FROM expected_price.price_book_id
      OR NEW.price_entry_id IS DISTINCT FROM expected_price.price_entry_id
      OR NEW.enforcement_mode IS DISTINCT FROM expected_price.enforcement_mode
      OR NEW.billing_unit IS DISTINCT FROM expected_price.billing_unit
      OR NEW.price_book_key IS DISTINCT FROM expected_price.price_book_key
      OR NEW.price_book_version IS DISTINCT FROM expected_price.price_book_version
      OR NEW.currency IS DISTINCT FROM expected_price.currency
      OR NEW.unit_price_minor IS DISTINCT FROM expected_price.unit_price_minor
      OR NEW.multiplier_ppm IS DISTINCT FROM expected_price.multiplier_ppm
      OR NEW.quoted_minor IS DISTINCT FROM expected_price.quoted_minor
      OR NEW.pricing_snapshot IS DISTINCT FROM expected_price.pricing_snapshot
      OR NEW.status <> 'reserved' OR NEW.charged_minor <> 0 OR NEW.settled_at IS NOT NULL THEN
      RAISE EXCEPTION 'new customer charge must match its exact reserved pricing snapshot'
        USING ERRCODE = '23514';
    END IF;
    IF expected_price.enforcement_mode = 'enforced' AND expected_price.quoted_minor > 0 THEN
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

CREATE OR REPLACE FUNCTION billing.reserve_customer_charge()
RETURNS trigger LANGUAGE plpgsql AS $function$
DECLARE
  price record;
  selected_account_id uuid;
  charge_id uuid;
BEGIN
  IF NEW.status <> 'reserved' OR NEW.billing_meter_key IS NULL THEN RETURN NEW; END IF;
  SELECT * INTO price FROM billing.customer_price_for_usage(
    NEW.tenant_id, NEW.consumer_id, NEW.billing_meter_key
  );
  IF NOT FOUND THEN RETURN NEW; END IF;

  PERFORM 1 FROM consumers consumer JOIN api_keys api_key_record
    ON api_key_record.id = NEW.api_key_id AND api_key_record.consumer_id = consumer.id
    AND api_key_record.tenant_id = consumer.tenant_id
   WHERE consumer.id = NEW.consumer_id AND consumer.tenant_id = NEW.tenant_id;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'billable usage tenant, consumer and API key scope do not match' USING ERRCODE = '23514';
  END IF;
  IF price.enforcement_mode = 'enforced' AND price.quoted_minor > 0 THEN
    SELECT id INTO selected_account_id FROM billing.credit_accounts
     WHERE tenant_id = NEW.tenant_id AND currency = price.currency AND status = 'active' FOR UPDATE;
    IF NOT FOUND THEN
      RAISE EXCEPTION 'insufficient_credit' USING ERRCODE = 'P0001',
        DETAIL = 'An active credit account in the request price currency is required.';
    END IF;
  END IF;
  charge_id := gen_random_uuid();
  INSERT INTO billing.customer_charges
    (id, usage_request_id, tenant_id, consumer_id, api_key_id, account_id,
     plan_version_id, price_book_id, price_entry_id, enforcement_mode,
     meter_key, billing_unit, price_book_key, price_book_version, currency,
     unit_price_minor, multiplier_ppm, quoted_minor, charged_minor, status, pricing_snapshot)
  VALUES
    (charge_id, NEW.id, NEW.tenant_id, NEW.consumer_id, NEW.api_key_id, selected_account_id,
     price.plan_version_id, price.price_book_id, price.price_entry_id, price.enforcement_mode,
     NEW.billing_meter_key, price.billing_unit, price.price_book_key, price.price_book_version, price.currency,
     price.unit_price_minor, price.multiplier_ppm, price.quoted_minor, 0, 'reserved', price.pricing_snapshot);
  IF price.enforcement_mode = 'enforced' AND price.quoted_minor > 0 THEN
    INSERT INTO billing.credit_ledger_entries
      (account_id, tenant_id, charge_id, usage_request_id, kind,
       amount_minor, available_delta_minor, held_delta_minor, currency, idempotency_key, actor, reason)
    VALUES
      (selected_account_id, NEW.tenant_id, charge_id, NEW.id, 'hold',
       price.quoted_minor, -price.quoted_minor, price.quoted_minor, price.currency,
       'usage:' || NEW.id || ':hold', 'usage-trigger', 'Customer charge reservation');
  END IF;
  RETURN NEW;
END;
$function$;
