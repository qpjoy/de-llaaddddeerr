-- Row versions for optimistic writes: a transaction updates a row only if it is
-- still the version it loaded, so per-device work no longer needs the realm lock.
ALTER TABLE mx_device.devices ADD COLUMN IF NOT EXISTS version bigint NOT NULL DEFAULT 0;
ALTER TABLE mx_device.jobs ADD COLUMN IF NOT EXISTS version bigint NOT NULL DEFAULT 0;
ALTER TABLE mx_device.attempts ADD COLUMN IF NOT EXISTS version bigint NOT NULL DEFAULT 0;
ALTER TABLE mx_device.device_apps ADD COLUMN IF NOT EXISTS version bigint NOT NULL DEFAULT 0;
ALTER TABLE mx_device.execution_commands ADD COLUMN IF NOT EXISTS version bigint NOT NULL DEFAULT 0;
ALTER TABLE mx_device.resource_policies ADD COLUMN IF NOT EXISTS version bigint NOT NULL DEFAULT 0;
ALTER TABLE mx_device.loop_policies ADD COLUMN IF NOT EXISTS version bigint NOT NULL DEFAULT 0;
-- Scoped (per-device) loads.
CREATE INDEX IF NOT EXISTS attempts_device_live ON mx_device.attempts(device_id) WHERE status IN ('running','yielded');
-- Single active scheduler: the holder of the session advisory lock bumps epoch;
-- scheduling transactions verify their epoch under FOR SHARE (fencing).
CREATE TABLE IF NOT EXISTS mx_device.scheduler_leader (
 id smallint PRIMARY KEY CHECK (id=1),
 epoch bigint NOT NULL,
 holder text,
 acquired_at bigint
);
INSERT INTO mx_device.scheduler_leader(id,epoch) VALUES(1,0) ON CONFLICT(id) DO NOTHING;
