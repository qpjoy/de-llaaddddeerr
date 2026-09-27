-- Administrative drafts and atomic batch receipts only. No seeded prices,
-- grants, key changes, wallet mutations or supplier activation.
CREATE TABLE IF NOT EXISTS control.procurement_price_drafts (
  id uuid PRIMARY KEY,
  provider_key text NOT NULL CHECK (provider_key IN ('qixin','justone','tikhub')),
  specification jsonb NOT NULL,
  specification_hash text NOT NULL,
  created_by text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE IF NOT EXISTS control.provisioning_batches (
  id uuid PRIMARY KEY,
  specification jsonb NOT NULL,
  preview jsonb NOT NULL,
  preview_hash text NOT NULL,
  status text NOT NULL DEFAULT 'preview' CHECK (status IN ('preview','completed')),
  result jsonb,
  created_by text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  expires_at timestamptz NOT NULL,
  applied_at timestamptz,
  CHECK ((status = 'completed') = (result IS NOT NULL))
);
CREATE TABLE IF NOT EXISTS control.procurement_price_references (
  provider_key text NOT NULL,
  operation_key text NOT NULL,
  price_book_version bigint NOT NULL,
  draft_id uuid NOT NULL REFERENCES control.procurement_price_drafts(id),
  batch_id uuid NOT NULL REFERENCES control.provisioning_batches(id),
  PRIMARY KEY (provider_key, operation_key, price_book_version)
);
CREATE INDEX IF NOT EXISTS procurement_drafts_provider_date_idx ON control.procurement_price_drafts(provider_key, created_at DESC);
REVOKE ALL ON control.procurement_price_drafts, control.provisioning_batches, control.procurement_price_references FROM PUBLIC;
