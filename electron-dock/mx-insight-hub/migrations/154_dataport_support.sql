-- Additive DataPort support workflow; original tickets and subscription receipts remain intact.
ALTER TABLE dataport.tickets ADD COLUMN revision integer NOT NULL DEFAULT 1;
ALTER TABLE dataport.tickets ADD COLUMN updated_at timestamptz NOT NULL DEFAULT now();
CREATE TABLE dataport.ticket_updates (
  id uuid PRIMARY KEY,
  ticket_id uuid NOT NULL REFERENCES dataport.tickets(id),
  tenant_id uuid NOT NULL REFERENCES tenants(id),
  fingerprint text NOT NULL,
  status text NOT NULL CHECK(status IN ('saved','processing','closed')),
  reply text NOT NULL DEFAULT '',
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX dataport_ticket_updates_ticket ON dataport.ticket_updates(tenant_id,ticket_id,created_at,id);
ALTER TABLE hub_commerce.messages ALTER COLUMN subscription_id DROP NOT NULL;
ALTER TABLE hub_commerce.messages DROP CONSTRAINT messages_kind_check;
ALTER TABLE hub_commerce.messages ADD CONSTRAINT messages_kind_check
  CHECK(kind IN ('scheduled','active','expiring_7d','expiring_1d','expired','ticket_updated'));
ALTER TABLE hub_commerce.messages ADD COLUMN recipient_id uuid REFERENCES iam.members(id);
ALTER TABLE hub_commerce.messages ADD CONSTRAINT messages_recipient_scope CHECK
  ((kind='ticket_updated' AND subscription_id IS NULL AND recipient_id IS NOT NULL)
   OR (kind<>'ticket_updated' AND subscription_id IS NOT NULL AND recipient_id IS NULL));
