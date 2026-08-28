-- A missing LLM default is a durable, revisioned state. Keeping a nullable
-- binding row avoids CAS ABA and prevents an older process from recreating the
-- former environment bootstrap binding with ON CONFLICT DO NOTHING.
ALTER TABLE control.agent_consumer_bindings
  ALTER COLUMN sequence_key DROP NOT NULL;

UPDATE control.agent_consumer_bindings
   SET sequence_key = NULL,
       revision = revision + 1,
       updated_by = 'explicit-default-migration',
       updated_at = now()
 WHERE updated_by = 'environment-bootstrap'
   AND (
     (consumer_key = 'hub.chat.default'
       AND kind = 'chat'
       AND sequence_key = 'mx-default-chat')
     OR
     (consumer_key = 'hub.embedding.default'
       AND kind = 'embedding'
       AND sequence_key = 'mx-default-embedding')
   );
