-- Record which tokenizer actually produced the live search index.
--
-- A strict rebuild verifies that every token came from the *configured* backend.
-- It does not, and cannot, verify that the configured backend was the intended
-- one. When MX_COMMON_HANLP_URL was empty the required backend resolved to
-- jieba, strict verification passed, and an index was rebuilt end to end in six
-- minutes -- fast precisely because no HanLP call was ever made. Nothing in the
-- product could report that afterwards: the index looked healthy, the task
-- looked successful, and only search quality knew otherwise.
--
-- Provenance closes that. It is written by whatever pass last projected the
-- index, so the control plane can state what the live projection is made of
-- rather than what this process happens to be configured for.

ALTER TABLE control.search_rebuild_progress
  ADD COLUMN IF NOT EXISTS segmenter_backend text;

COMMENT ON COLUMN control.search_rebuild_progress.segmenter_backend IS
  'Tokenizer backend whose verified output populated index_name. NULL means the '
  'projection predates provenance tracking and its tokens cannot be attributed.';
