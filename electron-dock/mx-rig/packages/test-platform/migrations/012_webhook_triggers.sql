-- Firing a task when the repository under test moves.
--
-- The constraint has to be replaced rather than extended: Postgres CHECK
-- constraints are not additive, so the old three-value list would keep
-- rejecting 'webhook' rows no matter what is added alongside it.

ALTER TABLE mxt_tasks DROP CONSTRAINT IF EXISTS mxt_tasks_schedule_check;
ALTER TABLE mxt_tasks ADD CONSTRAINT mxt_tasks_schedule_check CHECK (
  schedule_kind IN ('manual','once','cron','webhook')
  AND (schedule_kind <> 'cron' OR cron_expr IS NOT NULL)
  AND (schedule_kind <> 'once' OR run_at IS NOT NULL)
);

-- Shared secret for verifying incoming webhook signatures.
--
-- Encrypted with the same key as the credential store: anyone holding this can
-- forge a delivery, and the nightly pg_dump goes to object storage.
--
-- Per app rather than per platform, so that revoking one repository's access
-- does not mean re-configuring every other repository's webhook.
ALTER TABLE mxt_apps ADD COLUMN IF NOT EXISTS webhook_secret jsonb;

COMMENT ON COLUMN mxt_apps.webhook_secret IS
  'Encrypted {ciphertext, iv, tag} for the git provider webhook signature.';

-- Deduplicating retried deliveries.
--
-- Keyed on task + commit rather than on the provider's delivery id: that also
-- covers the same commit arriving twice by other routes (a force-push landing
-- on the same sha, a re-delivery pressed by hand), which a delivery id does not.
CREATE UNIQUE INDEX IF NOT EXISTS mxt_runs_webhook_dedupe_idx
  ON mxt_runs (task_id, (source_ref ->> 'gitSha'))
  WHERE trigger = 'webhook' AND task_id IS NOT NULL;
