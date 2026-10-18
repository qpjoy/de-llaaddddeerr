-- Callers of the Job API v1 (V2-5). A client authenticates with its own API
-- key (only the SHA-256 hash is stored); its row also holds its scopes, quotas,
-- fair-share weight and virtual runtime. Nothing existing changes: jobs
-- submitted through /api keep working and belong to no client.
CREATE TABLE IF NOT EXISTS mx_device.clients (
 id uuid PRIMARY KEY,
 mode text NOT NULL CHECK(mode IN ('sim','real')),
 status text NOT NULL CHECK(status IN ('active','disabled')),
 document jsonb NOT NULL,
 version bigint NOT NULL DEFAULT 1,
 CHECK(document->>'id'=id::text AND document->>'status'=status AND document ? 'keyHash')
);
CREATE INDEX IF NOT EXISTS clients_mode ON mx_device.clients(mode);
-- Measured-service corrections, appended by execution transactions (which do
-- not lock client rows) and folded into the client rows by the next
-- realm-wide transaction.
CREATE TABLE IF NOT EXISTS mx_device.client_usage (
 seq bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
 mode text NOT NULL,
 client_id uuid NOT NULL REFERENCES mx_device.clients(id),
 at bigint NOT NULL,
 document jsonb NOT NULL
);
CREATE INDEX IF NOT EXISTS client_usage_mode ON mx_device.client_usage(mode, seq);
-- Callback deliveries: written in the transaction that ends a job, sent after
-- commit with an HMAC signature; the id is the delivery id receivers dedupe on.
CREATE TABLE IF NOT EXISTS mx_device.outbox (
 id uuid PRIMARY KEY,
 mode text NOT NULL CHECK(mode IN ('sim','real')),
 client_id uuid NOT NULL REFERENCES mx_device.clients(id),
 job_id uuid NOT NULL REFERENCES mx_device.jobs(id),
 event text NOT NULL,
 status text NOT NULL CHECK(status IN ('pending','delivered','dead')),
 attempts integer NOT NULL DEFAULT 0,
 next_at bigint NOT NULL,
 locked_until bigint NOT NULL DEFAULT 0,
 created_at bigint NOT NULL,
 document jsonb NOT NULL,
 UNIQUE(job_id, event)
);
CREATE INDEX IF NOT EXISTS outbox_due ON mx_device.outbox(next_at) WHERE status='pending';
CREATE INDEX IF NOT EXISTS outbox_by_client ON mx_device.outbox(client_id, created_at DESC);
-- A client's own jobs, newest first (client views and listings).
CREATE INDEX IF NOT EXISTS jobs_by_client ON mx_device.jobs((document->'client'->>'id'), created_at DESC) WHERE document ? 'client';
