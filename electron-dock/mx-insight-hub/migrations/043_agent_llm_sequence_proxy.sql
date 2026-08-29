-- Optional per-LLM-Sequence Proxy routing. Existing Sequences deliberately
-- remain unbound and continue to inherit Provider -> Hub -> system egress.

ALTER TABLE control.agent_llm_sequences
  ADD COLUMN IF NOT EXISTS proxy_sequence_key text,
  ADD COLUMN IF NOT EXISTS verified_proxy_fingerprint char(64);

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1
      FROM pg_constraint
     WHERE conname = 'agent_llm_sequences_proxy_sequence_fk'
       AND conrelid = 'control.agent_llm_sequences'::regclass
  ) THEN
    ALTER TABLE control.agent_llm_sequences
      ADD CONSTRAINT agent_llm_sequences_proxy_sequence_fk
      FOREIGN KEY (proxy_sequence_key)
      REFERENCES control.agent_proxy_sequences(sequence_key)
      ON UPDATE RESTRICT
      ON DELETE RESTRICT;
  END IF;

  IF NOT EXISTS (
    SELECT 1
      FROM pg_constraint
     WHERE conname = 'agent_llm_sequences_verified_proxy_fingerprint_check'
       AND conrelid = 'control.agent_llm_sequences'::regclass
  ) THEN
    ALTER TABLE control.agent_llm_sequences
      ADD CONSTRAINT agent_llm_sequences_verified_proxy_fingerprint_check
      CHECK (
        verified_proxy_fingerprint IS NULL
        OR verified_proxy_fingerprint ~ '^[0-9a-f]{64}$'
      );
  END IF;
END $$;

CREATE INDEX IF NOT EXISTS agent_llm_sequences_proxy_sequence_idx
  ON control.agent_llm_sequences (proxy_sequence_key)
  WHERE proxy_sequence_key IS NOT NULL;
