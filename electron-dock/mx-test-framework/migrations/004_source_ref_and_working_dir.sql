-- Two columns that a real repository turned out to need.
--
-- default_branch: which ref a run checks out when it does not name one itself.
-- Without it every run got the remote's default branch tip, so "which commit
-- was that failure on" had no answer and mxt_runs.source_ref stayed empty.
--
-- working_dir: the project root inside the repository. po-frontend is a
-- monorepo — package.json, pnpm-lock.yaml and cypress/ all live under
-- po-frontend/, not at the top level. A runner that always works at the
-- checkout root cannot install or run anything there.

ALTER TABLE mxt_apps   ADD COLUMN IF NOT EXISTS default_branch text;
ALTER TABLE mxt_suites ADD COLUMN IF NOT EXISTS working_dir    text;

COMMENT ON COLUMN mxt_apps.default_branch IS
  'Ref checked out when a run does not pin one. NULL means the remote default.';
COMMENT ON COLUMN mxt_suites.working_dir IS
  'Project root relative to the checkout, e.g. "po-frontend". NULL means the root.';

-- target_mode: where the system under test comes from.
--
-- 'external' — the suite drives a deployed instance, so a task must name a
--              target URL. This is the existing behaviour and stays the default.
-- 'self'     — the suite brings up its own target. 罗盘's `pnpm e2e:local` runs
--              a production Quasar build, serves dist/spa on a loopback port and
--              points Cypress at that. Demanding a URL for those runs would be
--              asking for a value nothing reads, and would make the first
--              server-side run depend on a deployed instance being up.
ALTER TABLE mxt_suites ADD COLUMN IF NOT EXISTS target_mode text NOT NULL DEFAULT 'external';

COMMENT ON COLUMN mxt_suites.target_mode IS
  'external = task must supply targetUrl; self = the suite starts its own target.';
