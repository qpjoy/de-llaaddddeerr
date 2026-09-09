-- Keep provider credentials and their source/revision metadata out of any
-- role that inherits PostgreSQL's PUBLIC privileges. The current Hub
-- application role owns these tables and therefore still has access; this is
-- privilege hardening, not application-level encryption or workload isolation.
REVOKE ALL ON TABLE control.external_platform_provider_credentials FROM PUBLIC;
REVOKE ALL ON TABLE control.external_platform_provider_settings FROM PUBLIC;

COMMENT ON TABLE control.external_platform_provider_credentials IS
  'Plaintext external-platform credentials. PUBLIC has no privileges; database owners and backups remain secret-bearing.';
