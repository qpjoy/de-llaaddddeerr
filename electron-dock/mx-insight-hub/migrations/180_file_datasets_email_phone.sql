-- File datasets "邮箱库" and "手机号库" (scenario apps -> 文件数据集).
--
-- They reuse the control tables of migration 178: account_dictionary holds
-- every file dataset (one row in datasets, versions keyed by dataset_key).
-- PostgreSQL only: no canonical records, outbox, Elasticsearch, HanLP or
-- embeddings. The dictionary worker creates each version's partitioned
-- tables and indexes outside the startup migration.
--
-- A source may be one file inside a .zip on the server (source_entry). The
-- worker reads it as a stream without extracting it; byte_offset then counts
-- uncompressed bytes of that entry, while source_bytes / SHA-256 / identity
-- still describe the archive file on disk.
ALTER TABLE account_dictionary.datasets
  ADD COLUMN IF NOT EXISTS source_entry text CHECK (source_entry IS NULL OR source_entry <> '');
ALTER TABLE account_dictionary.versions
  ADD COLUMN IF NOT EXISTS source_entry text CHECK (source_entry IS NULL OR source_entry <> ''),
  ADD COLUMN IF NOT EXISTS source_entry_bytes bigint CHECK (source_entry_bytes IS NULL OR source_entry_bytes > 0);

-- No expected fingerprint is seeded: operators point these at the server's
-- archive (e.g. email-phone.zip) and enter its SHA-256 on the task page.
INSERT INTO account_dictionary.datasets (dataset_key, display_name, purpose)
VALUES
  ('email-directory', '邮箱库', '内部授权查询：来源文件中的邮箱地址名录'),
  ('phone-directory', '手机号库', '内部授权查询：来源文件中的国际手机号名录')
ON CONFLICT (dataset_key) DO NOTHING;

COMMENT ON SCHEMA account_dictionary IS
  'File datasets cleaned from operator files on the server (Twitter user e-mail, e-mail list, phone list). PostgreSQL only.';
