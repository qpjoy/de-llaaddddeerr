-- Separate from business delivery ACKs: every reader owns its own checkpoint.
-- No historical backfill in this DDL transaction. The snapshot API bootstraps
-- existing orders, then replays changes from its starting watermark.
SET LOCAL lock_timeout = '3s';
SET LOCAL statement_timeout = '30s';
CREATE TABLE pay.reporting_source (
  singleton boolean PRIMARY KEY DEFAULT true CHECK (singleton),
  id uuid NOT NULL DEFAULT gen_random_uuid(),
  created_at timestamptz NOT NULL DEFAULT now()
);
INSERT INTO pay.reporting_source(singleton) VALUES (true);
CREATE TRIGGER reporting_source_immutable BEFORE UPDATE OR DELETE ON pay.reporting_source
  FOR EACH ROW EXECUTE FUNCTION pay.immutable_record();
CREATE TABLE pay.reporting_heads (
  app_id text NOT NULL,
  environment text NOT NULL CHECK (environment IN ('test','live')),
  position bigint NOT NULL CHECK (position > 0),
  PRIMARY KEY (app_id,environment)
);
CREATE TABLE pay.reporting_changes (
  app_id text NOT NULL,
  environment text NOT NULL,
  position bigint NOT NULL,
  order_id uuid NOT NULL REFERENCES pay.orders(id),
  revision bigint NOT NULL,
  document jsonb NOT NULL,
  recorded_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (app_id,environment,position),
  UNIQUE (order_id,revision)
);
CREATE TRIGGER reporting_changes_immutable BEFORE UPDATE OR DELETE ON pay.reporting_changes
  FOR EACH ROW EXECUTE FUNCTION pay.immutable_record();
CREATE INDEX pay_reporting_snapshot ON pay.orders(app_id,environment,id);
CREATE FUNCTION pay.reporting_document(d jsonb) RETURNS jsonb
  LANGUAGE sql IMMUTABLE STRICT SET search_path = pg_catalog AS $$
  SELECT jsonb_build_object(
    'id',d->'id','appId',d->'appId','environment',d->'environment',
    'businessOrderId',d->'businessOrderId','customerRef',d->'customerRef',
    'revision',d->'revision','status',d->'status','provider',d->'provider',
    'merchantAccountId',d->'merchantAccountId','currency',d->'currency',
    'amountMinor',d->'amountMinor','receivedAmountMinor',d->'settlement'->'amountMinor',
    'feeMinor',d->'settlement'->'feeMinor','paidAt',d->'settlement'->'paidAt',
    'confirmedAt',d->'settlement'->'confirmedAt','createdAt',d->'createdAt','updatedAt',d->'updatedAt'
  )
$$;
CREATE FUNCTION pay.record_reporting_change() RETURNS trigger
  LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, pay, pg_temp AS $$
DECLARE next_position bigint;
BEGIN
  IF TG_OP='UPDATE' AND NEW.document IS NOT DISTINCT FROM OLD.document THEN RETURN NEW; END IF;
  -- A transactional per-application/environment row, NOT a sequence/serial:
  -- later positions cannot commit before an earlier holder of this row lock.
  INSERT INTO pay.reporting_heads AS h(app_id,environment,position)
    VALUES (NEW.app_id,NEW.environment,1)
    ON CONFLICT(app_id,environment) DO UPDATE SET position=h.position+1
    RETURNING position INTO next_position;
  INSERT INTO pay.reporting_changes(app_id,environment,position,order_id,revision,document)
    VALUES (NEW.app_id,NEW.environment,next_position,NEW.id,(NEW.document->>'revision')::bigint,pay.reporting_document(NEW.document));
  RETURN NEW;
END $$;
REVOKE ALL ON FUNCTION pay.record_reporting_change() FROM PUBLIC;
-- Also captures writes from old API replicas during a rolling upgrade.
CREATE TRIGGER pay_reporting_change AFTER INSERT OR UPDATE ON pay.orders
  FOR EACH ROW EXECUTE FUNCTION pay.record_reporting_change();
