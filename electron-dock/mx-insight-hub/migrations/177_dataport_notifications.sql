-- Add owner-only employee events and enterprise ticket receipts without rewriting old messages.
ALTER TABLE hub_commerce.messages DROP CONSTRAINT messages_kind_check;
ALTER TABLE hub_commerce.messages ADD CONSTRAINT messages_kind_check CHECK
  (kind IN ('scheduled','active','expiring_7d','expiring_1d','expired','ticket_updated',
    'member_created','member_enabled','member_disabled','ticket_updated_owner'));
ALTER TABLE hub_commerce.messages DROP CONSTRAINT messages_recipient_scope;
ALTER TABLE hub_commerce.messages ADD CONSTRAINT messages_recipient_scope CHECK
  ((kind IN ('ticket_updated','member_created','member_enabled','member_disabled','ticket_updated_owner')
      AND subscription_id IS NULL AND recipient_id IS NOT NULL)
   OR (kind IN ('scheduled','active','expiring_7d','expiring_1d','expired')
      AND subscription_id IS NOT NULL AND recipient_id IS NULL));
CREATE UNIQUE INDEX dataport_owner_message_event ON hub_commerce.messages
  (tenant_id,recipient_id,kind,(document->>'eventId'))
  WHERE kind IN ('member_created','member_enabled','member_disabled','ticket_updated_owner');
