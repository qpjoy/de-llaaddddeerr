-- Fence an old worker after recovery, approval hand-off or a follow-up.
ALTER TABLE rig_missions ADD COLUMN IF NOT EXISTS execution_epoch bigint NOT NULL DEFAULT 0;
