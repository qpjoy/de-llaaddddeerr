-- Persist an explicit three-state application egress policy without copying the
-- deployment-owned Docker daemon snapshot into PostgreSQL. Existing non-null
-- Proxy Sequence bindings remain explicit; existing null bindings inherit the
-- deployment baseline.

ALTER TABLE control.agent_llm_sequences
  ADD COLUMN IF NOT EXISTS egress_mode text;

UPDATE control.agent_llm_sequences
   SET egress_mode = CASE
     WHEN proxy_sequence_key IS NULL THEN 'inherit'
     ELSE 'proxy-sequence'
   END
 WHERE egress_mode IS NULL;

ALTER TABLE control.agent_llm_sequences
  ALTER COLUMN egress_mode SET DEFAULT 'inherit',
  ALTER COLUMN egress_mode SET NOT NULL;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1
      FROM pg_constraint
     WHERE conname = 'agent_llm_sequences_egress_mode_check'
       AND conrelid = 'control.agent_llm_sequences'::regclass
  ) THEN
    ALTER TABLE control.agent_llm_sequences
      ADD CONSTRAINT agent_llm_sequences_egress_mode_check
      CHECK (egress_mode IN ('inherit', 'system-egress', 'proxy-sequence'));
  END IF;

  IF NOT EXISTS (
    SELECT 1
      FROM pg_constraint
     WHERE conname = 'agent_llm_sequences_egress_binding_check'
       AND conrelid = 'control.agent_llm_sequences'::regclass
  ) THEN
    ALTER TABLE control.agent_llm_sequences
      ADD CONSTRAINT agent_llm_sequences_egress_binding_check
      CHECK (
        (egress_mode = 'proxy-sequence' AND proxy_sequence_key IS NOT NULL)
        OR
        (egress_mode IN ('inherit', 'system-egress') AND proxy_sequence_key IS NULL)
      );
  END IF;
END $$;

ALTER TABLE control.agent_proxy_settings
  ADD COLUMN IF NOT EXISTS egress_mode text;

UPDATE control.agent_proxy_settings
   SET egress_mode = CASE
     WHEN global_sequence_key IS NULL THEN 'inherit'
     ELSE 'proxy-sequence'
   END
 WHERE egress_mode IS NULL;

ALTER TABLE control.agent_proxy_settings
  ALTER COLUMN egress_mode SET DEFAULT 'inherit',
  ALTER COLUMN egress_mode SET NOT NULL;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1
      FROM pg_constraint
     WHERE conname = 'agent_proxy_settings_egress_mode_check'
       AND conrelid = 'control.agent_proxy_settings'::regclass
  ) THEN
    ALTER TABLE control.agent_proxy_settings
      ADD CONSTRAINT agent_proxy_settings_egress_mode_check
      CHECK (egress_mode IN ('inherit', 'system-egress', 'proxy-sequence'));
  END IF;

  IF NOT EXISTS (
    SELECT 1
      FROM pg_constraint
     WHERE conname = 'agent_proxy_settings_egress_binding_check'
       AND conrelid = 'control.agent_proxy_settings'::regclass
  ) THEN
    ALTER TABLE control.agent_proxy_settings
      ADD CONSTRAINT agent_proxy_settings_egress_binding_check
      CHECK (
        (egress_mode = 'proxy-sequence' AND global_sequence_key IS NOT NULL)
        OR
        (egress_mode IN ('inherit', 'system-egress') AND global_sequence_key IS NULL)
      );
  END IF;
END $$;

COMMENT ON COLUMN control.agent_llm_sequences.egress_mode IS
  'inherit uses compatibility bindings then deployment baseline; system-egress bypasses all proxies; proxy-sequence selects proxy_sequence_key.';
COMMENT ON COLUMN control.agent_proxy_settings.egress_mode IS
  'Hub compatibility fallback: inherit deployment baseline, force system egress, or select global_sequence_key.';
