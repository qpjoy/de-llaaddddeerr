-- Raise the Hub service request quota on rows that still carry the old default.
--
-- The default was 1,000 requests per hour, chosen before these data products
-- existed. A cache hit consumes this quota exactly as a live acquisition does,
-- and a product page fans out into many requests, so a handful of people in one
-- customer company browsing at the same time exhausted an hour's window. The
-- new default is 100,000.
--
-- Two deliberate limits on what this touches:
--
--   1. Only rows whose value is exactly the old default (1000) are raised. A
--      row an operator tuned to anything else -- a trial tenant held at 100, a
--      heavy consumer already at 5,000 -- is left alone. Blanket-raising every
--      row would silently discard those decisions, which is the same mistake as
--      overwriting a reviewed price book.
--
--   2. Plan limits (plan_versions.limits) are NOT touched. Those are commercial
--      terms a customer bought; changing them here would hand out capacity
--      nobody agreed to sell.
--
-- API-key entitlements are included. The scope frozen at issuance is *which*
-- platforms and capabilities a key may reach -- a security boundary this does
-- not move. A rate ceiling on an already-granted resource is capacity, not
-- authorization, and leaving keys at 1,000 would make the change ineffective:
-- the consumer window would be wide while every key still capped at the old
-- value and returned api_key_quota_exceeded.
--
-- Re-running is a no-op: the predicate no longer matches once a row is raised.

SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '5min';

UPDATE consumer_platform_policies
   SET max_requests = 100000,
       updated_at = now()
 WHERE max_requests = 1000;

UPDATE consumer_capability_policies
   SET max_requests = 100000,
       updated_at = now()
 WHERE max_requests = 1000;

UPDATE api_key_platform_entitlements
   SET max_requests = 100000
 WHERE max_requests = 1000;

UPDATE api_key_capability_entitlements
   SET max_requests = 100000
 WHERE max_requests = 1000;
