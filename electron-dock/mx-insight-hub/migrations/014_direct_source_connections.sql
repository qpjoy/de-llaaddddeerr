-- Collapse database providers into their source registrations.
--
-- Provider passwords were encrypted with an application key and cannot be
-- safely decrypted inside a SQL migration. Preserve every non-secret
-- coordinate, pause affected sources, and require an admin-token operator to
-- enter the plaintext password through the source API before reactivation.

UPDATE catalog.external_sources AS source
   SET connection = (source.connection - 'dsnEnv') || provider.config,
       status = 'paused',
       updated_at = now()
  FROM catalog.source_providers AS provider
 WHERE source.provider_id = provider.id;

-- Keep the legacy relationship and encrypted envelope as deprecated recovery
-- metadata. Runtime code no longer reads either object, but deleting them in a
-- rollout would make rollback and credential recovery impossible.
COMMENT ON TABLE catalog.source_providers IS
  'Deprecated recovery metadata. Runtime source connections live in catalog.external_sources.connection.';

COMMENT ON COLUMN catalog.external_sources.provider_id IS
  'Deprecated recovery link retained for rollback; ignored by current runtime code.';

-- Migration 008 documented the original dsnEnv-only contract. Direct source
-- administration now intentionally stores the complete connection, including
-- its plaintext password, in this column; only the Hub admin-token surface may
-- read or change it.
COMMENT ON COLUMN catalog.external_sources.connection IS
  'Direct source connection metadata, including plaintext password by operator policy; restricted to admin-token management. Legacy dsnEnv remains supported.';
