-- Consumers that never configured tokenize receive the same default that Hub
-- applies atomically when it creates a new consumer. A policy row with no grant
-- is an explicit disable and must stay disabled. API keys remain separate
-- credentials: this migration never creates or exposes a key.

-- Serialize the backfill with consumer creation and Admin capability writes.
-- Without this transaction-scoped lock, a concurrent explicit disable can miss
-- the uncommitted grant below, persist its policy, and then be undone when this
-- transaction commits the grant. Reads remain available while the short
-- backfill runs.
LOCK TABLE consumers, capability_grants, consumer_capability_policies
  IN SHARE ROW EXCLUSIVE MODE;

INSERT INTO capability_grants (consumer_id, capability)
SELECT c.id, 'nlp.tokenize'
  FROM consumers c
 WHERE NOT EXISTS (
   SELECT 1
     FROM consumer_capability_policies p
    WHERE p.consumer_id = c.id
      AND p.capability = 'nlp.tokenize'
 )
ON CONFLICT (consumer_id, capability) DO NOTHING;

INSERT INTO consumer_capability_policies
  (tenant_id, consumer_id, capability, max_requests, window_seconds)
SELECT c.tenant_id, c.id, 'nlp.tokenize', 1000, 3600
  FROM consumers c
 WHERE NOT EXISTS (
   SELECT 1
     FROM consumer_capability_policies p
    WHERE p.consumer_id = c.id
      AND p.capability = 'nlp.tokenize'
 )
ON CONFLICT (consumer_id, capability) DO NOTHING;
