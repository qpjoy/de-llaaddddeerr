-- Auditable operator evidence for source-writer guarantees that PostgreSQL
-- schema inspection cannot prove (watermark advancement, soft deletes and
-- commit ordering). A new row is written for every explicit activation; rows
-- are never updated so historical approvals remain attributable.

CREATE TABLE IF NOT EXISTS catalog.pipeline_writer_contract_attestations (
  id uuid PRIMARY KEY,
  pipeline_key text NOT NULL,
  contract_version text NOT NULL,
  contract_digest char(64) NOT NULL
    CHECK (contract_digest ~ '^[0-9a-f]{64}$'),
  contract_summary jsonb NOT NULL
    CHECK (jsonb_typeof(contract_summary) = 'object'),
  attested_by text NOT NULL,
  attested_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS pipeline_writer_contract_attestations_latest_idx
  ON catalog.pipeline_writer_contract_attestations (pipeline_key, attested_at DESC);

-- Existing deployments could have activated the two child sources before the
-- writer guarantees became auditable. Require one explicit pipeline-level
-- activation under the new contract before periodic work can resume.
UPDATE catalog.external_sources
   SET status = 'paused', updated_at = now()
 WHERE source_key IN ('telegram-monitor-chats', 'telegram-monitor-messages');
