-- Host Agents (V2-3). An Agent connects out with its own token (only the
-- SHA-256 hash is stored) and executes the devices bound to it
-- (devices.document->>'agentId'). Nothing existing changes: no device is
-- bound to an Agent until an administrator adopts it.
CREATE TABLE IF NOT EXISTS mx_device.agents (
 id uuid PRIMARY KEY,
 mode text NOT NULL CHECK(mode IN ('sim','real')),
 status text NOT NULL CHECK(status IN ('active','disabled')),
 document jsonb NOT NULL,
 version bigint NOT NULL DEFAULT 1,
 CHECK(document->>'id'=id::text AND document->>'status'=status AND document ? 'tokenHash')
);
CREATE INDEX IF NOT EXISTS devices_by_agent ON mx_device.devices((document->>'agentId')) WHERE document ? 'agentId';
