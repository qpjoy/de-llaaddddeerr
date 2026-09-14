-- Unlisted customer meters are free without changing published price books.
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

  -- Missing rates are free; an invalid assigned price book is still an error.
  PERFORM 1 FROM billing.customer_price_books
   WHERE id = assigned_price_book_id AND status IN ('published', 'retired')
   FOR SHARE;
  IF NOT FOUND THEN
    IF profile_mode = 'enforced' THEN
      RAISE EXCEPTION 'customer_price_unavailable'
        USING ERRCODE = 'P0001', DETAIL = 'The assigned customer price book is unavailable.';
    END IF;
    RETURN NEW;
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
    -- Authorization and usage quotas are enforced independently. No customer
    -- charge or credit hold is created for an operation without a price entry.
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
