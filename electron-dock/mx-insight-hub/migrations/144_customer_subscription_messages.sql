-- Customer messages are separate from private supplier incidents and payment inboxes.
CREATE TABLE hub_commerce.messages (
  id bigserial PRIMARY KEY,
  tenant_id uuid NOT NULL REFERENCES tenants(id),
  subscription_id uuid NOT NULL REFERENCES hub_commerce.subscriptions(id),
  kind text NOT NULL CHECK (kind IN ('scheduled','active','expiring_7d','expiring_1d','expired')),
  document jsonb NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE(subscription_id,kind)
);
CREATE INDEX commerce_messages_tenant ON hub_commerce.messages(tenant_id,id DESC);
CREATE TRIGGER commerce_messages_immutable BEFORE UPDATE OR DELETE ON hub_commerce.messages
FOR EACH ROW EXECUTE FUNCTION hub_commerce.immutable();
CREATE TABLE hub_commerce.message_reads (
  message_id bigint NOT NULL REFERENCES hub_commerce.messages(id),
  member_id uuid NOT NULL REFERENCES iam.members(id),
  read_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY(message_id,member_id)
);
