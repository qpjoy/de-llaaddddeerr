-- Only the original, explicitly paced LCY key may create new overdraft.
-- No account, price, balance, Key setting or historical receipt is rewritten.
CREATE FUNCTION billing.lcy_work_quota_exempt(p_tenant uuid, p_consumer uuid, p_key uuid)
RETURNS boolean LANGUAGE sql STABLE AS $$
  SELECT EXISTS (
    SELECT 1 FROM public.api_keys k WHERE k.id=p_key AND k.tenant_id=p_tenant AND k.consumer_id=p_consumer
      AND k.id='fd2f8cc9-0ff1-4052-a538-8cc8150bde83'
      AND k.tenant_id='277bf8a4-5ed5-414d-b429-d72fcd7d36b6'
      AND k.consumer_id='be7d07fe-3d98-4db3-b00d-e5cbe5a76190'
      AND k.hub_rate_limit_exempt IS TRUE AND k.hub_supplier_admission='priority'
      AND k.environment='live' AND k.status='active' AND k.expires_at>now()
  )
$$;

-- Existing rows satisfy the old, strictly stronger lower bounds. NOT VALID
-- enforces the replacements on new writes without scanning the entire ledger.
ALTER TABLE billing.credit_accounts
  DROP CONSTRAINT credit_accounts_available_minor_check,
  ADD CONSTRAINT credit_accounts_available_minor_check CHECK (
    available_minor BETWEEN -9007199254740991 AND 9007199254740991
    AND (available_minor >= 0 OR tenant_id='277bf8a4-5ed5-414d-b429-d72fcd7d36b6')
  ) NOT VALID;
ALTER TABLE billing.credit_ledger_entries
  DROP CONSTRAINT credit_ledger_entries_available_after_minor_check,
  ADD CONSTRAINT credit_ledger_entries_available_after_minor_check CHECK (
    available_after_minor BETWEEN -9007199254740991 AND 9007199254740991
    AND (available_after_minor >= 0 OR tenant_id='277bf8a4-5ed5-414d-b429-d72fcd7d36b6')
  ) NOT VALID;

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

  -- Only a priced hold from this Key can deepen an overdraft. A capture
  -- against existing held funds, a release, refund or top-up must still work
  -- while in debt, including after the Key is revoked or the switch is off.
  IF applied_held_minor < 0 OR (applied_available_minor < 0 AND NEW.available_delta_minor < 0
    AND NOT (NEW.kind = 'hold' AND billing.lcy_work_quota_exempt(charge.tenant_id, charge.consumer_id, charge.api_key_id))) THEN
    RAISE EXCEPTION 'insufficient_credit'
      USING ERRCODE = 'P0001',
            DETAIL = 'Insufficient available credit for this entry or insufficient held funds.';
  END IF;

  NEW.account_revision := applied_account_revision;
  NEW.available_after_minor := applied_available_minor;
  NEW.held_after_minor := applied_held_minor;
  RETURN NEW;
END;
$function$;

CREATE TABLE hub_commerce.subscription_overage (
  request_id uuid PRIMARY KEY REFERENCES public.usage_requests(id),
  subscription_id uuid NOT NULL REFERENCES hub_commerce.subscriptions(id)
);
COMMENT ON TABLE hub_commerce.subscription_overage IS
  'Beyond included units. Usage status and customer charge ledger determine settlement; no included quota is consumed.';

CREATE OR REPLACE FUNCTION hub_commerce.reserve_ip_subscription() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE selected_id uuid; scope_consumer uuid; scope_channel text;
BEGIN
  IF NEW.billing_meter_key IS NULL OR NEW.billing_meter_key NOT IN ('ip.risk.subscription.v2','ip.risk.subscription.product') THEN RETURN NEW; END IF;
  IF NEW.status <> 'reserved' OR NEW.units_reserved <> 1 THEN RAISE EXCEPTION 'commerce_invalid_reservation'; END IF;
  scope_channel := CASE WHEN NEW.billing_meter_key='ip.risk.subscription.product' THEN 'product' ELSE 'baidu-v2' END;
  scope_consumer := CASE WHEN scope_channel='product' THEN NULL ELSE NEW.consumer_id END;
  -- Serialize selection with payment delivery and preference writes across replicas.
  PERFORM pg_advisory_xact_lock(hashtext('commerce-subscription:'||coalesce(scope_consumer,NEW.tenant_id)::text||':'||scope_channel));
  SELECT c.id INTO selected_id FROM hub_commerce.subscription_candidates(NEW.tenant_id,scope_consumer,scope_channel) c WHERE c.available LIMIT 1;
  IF selected_id IS NULL THEN
    IF billing.lcy_work_quota_exempt(NEW.tenant_id, NEW.consumer_id, NEW.api_key_id) THEN
      SELECT c.id INTO selected_id FROM hub_commerce.subscription_candidates(NEW.tenant_id,scope_consumer,scope_channel) c LIMIT 1;
      IF selected_id IS NOT NULL THEN
        INSERT INTO hub_commerce.subscription_overage(request_id,subscription_id) VALUES(NEW.id,selected_id);
        RETURN NEW;
      END IF;
    END IF;
    IF NOT EXISTS (SELECT 1 FROM hub_commerce.subscription_candidates(NEW.tenant_id,scope_consumer,scope_channel)) THEN
      RAISE EXCEPTION 'commerce_subscription_required' USING ERRCODE='P0001';
    ELSIF EXISTS (SELECT 1 FROM hub_commerce.subscriptions s WHERE s.tenant_id=NEW.tenant_id AND s.channel=scope_channel
      AND s.consumer_id IS NOT DISTINCT FROM scope_consumer AND s.starts_at<=now() AND s.ends_at>now() AND s.used+s.held<s.quota) THEN
      RAISE EXCEPTION 'commerce_daily_limit_exhausted' USING ERRCODE='P0001';
    ELSE RAISE EXCEPTION 'commerce_quota_exhausted' USING ERRCODE='P0001'; END IF;
  END IF;
  -- A settlement may only release availability. This row lock also fences it.
  UPDATE hub_commerce.subscriptions SET held=held+1 WHERE id=selected_id;
  INSERT INTO hub_commerce.usage(request_id,subscription_id,state) VALUES(NEW.id,selected_id,'held');
  RETURN NEW;
END $$;

CREATE OR REPLACE FUNCTION billing.reserve_customer_charge()
RETURNS trigger LANGUAGE plpgsql AS $function$
DECLARE
  price record;
  selected_account_id uuid;
  charge_id uuid;
BEGIN
  IF NEW.status <> 'reserved' OR NEW.billing_meter_key IS NULL THEN RETURN NEW; END IF;
  -- The subscription trigger executes after reserve_commerce, which has
  -- atomically selected either a prepaid unit or a separately billable overage.
  IF TG_NAME = 'usage_requests_reserve_subscription_overage'
     AND NOT EXISTS (SELECT 1 FROM hub_commerce.subscription_overage WHERE request_id=NEW.id) THEN RETURN NEW; END IF;
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

-- The ordinary subscription exclusion remains in place. In-quota consumption
-- is never charged twice; overage uses exactly the active contract/default.
CREATE TRIGGER usage_requests_reserve_subscription_overage AFTER INSERT ON public.usage_requests
FOR EACH ROW WHEN (NEW.api_key_id='fd2f8cc9-0ff1-4052-a538-8cc8150bde83'
  AND NEW.billing_meter_key IN ('ip.risk.subscription.v2','ip.risk.subscription.product'))
EXECUTE FUNCTION billing.reserve_customer_charge();
