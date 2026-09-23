-- Additive management metadata. No existing identity, grant, price or ledger rows change.
CREATE TABLE control.capability_inventory (
  id text PRIMARY KEY,
  kind text NOT NULL CHECK (kind IN ('route', 'connector', 'product')),
  definition jsonb NOT NULL,
  definition_hash char(64) NOT NULL,
  status text NOT NULL DEFAULT 'registered' CHECK (status IN ('registered', 'retired')),
  revision bigint NOT NULL DEFAULT 1,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE control.external_platform_pricing_templates (
  provider_key text NOT NULL,
  version integer NOT NULL CHECK (version > 0),
  spec_hash char(64) NOT NULL,
  specification jsonb NOT NULL,
  reason text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (provider_key, version),
  UNIQUE (provider_key, spec_hash)
);

CREATE TABLE control.external_platform_pricing_bindings (
  provider_key text NOT NULL,
  operation_key text NOT NULL,
  template_version integer NOT NULL,
  operation_revision bigint NOT NULL,
  PRIMARY KEY (provider_key, operation_key),
  FOREIGN KEY (provider_key, template_version) REFERENCES control.external_platform_pricing_templates(provider_key, version)
);

CREATE FUNCTION control.reject_pricing_template_mutation()
RETURNS trigger LANGUAGE plpgsql AS $function$
BEGIN
  RAISE EXCEPTION 'procurement pricing templates are immutable' USING ERRCODE = '55000';
END;
$function$;

CREATE TRIGGER external_platform_pricing_templates_immutable
BEFORE UPDATE OR DELETE ON control.external_platform_pricing_templates
FOR EACH ROW EXECUTE FUNCTION control.reject_pricing_template_mutation();

-- Consumption pages reuse customer_charges_tenant_created_idx from 056.
-- Avoid a blocking index build over the existing financial history at rollout.

-- Prevent a priced canonical meter from also charging new aggregate parents.
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

  -- New aggregate parents are orchestration only; children retain priced meters.
  IF NEW.billing_meter_key = 'data.aggregate.refresh' THEN
    IF NEW.capability IS DISTINCT FROM 'data.canonical-search' OR NEW.platform IS NOT NULL THEN
      RAISE EXCEPTION 'invalid aggregate billing scope';
    END IF;
    NEW.billing_meter_key := NULL;
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
