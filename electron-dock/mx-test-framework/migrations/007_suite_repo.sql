-- Where a suite's test code lives, when that is not the application's own repo.
--
-- The application repo is the right home for tests that share fixtures, mocks or
-- types with the code under test — they drift the moment they are separated.
--
-- Everything else (black-box e2e, API, perf, desktop smoke, LLM evals) is better
-- owned by the test team in its own repository: deciding how to test is their
-- call, and needing a pull request into someone else's repo to change a
-- selector makes them wait on people who did not ask to be involved.
--
-- NULL falls back to the app's repo_url / default_branch, so nothing changes for
-- suites that were already co-located. See specs/adr/0007-test-code-ownership.md.

ALTER TABLE mxt_suites ADD COLUMN IF NOT EXISTS repo_url       text;
ALTER TABLE mxt_suites ADD COLUMN IF NOT EXISTS default_branch text;

COMMENT ON COLUMN mxt_suites.repo_url IS
  'Test repository for this suite. NULL means use the application repo.';
