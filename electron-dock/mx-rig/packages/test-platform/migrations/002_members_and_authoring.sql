-- Members (who may use the platform) and case authoring by testers.
--
-- Identity stays with mx-launcher: this table holds authorization only, keyed by
-- the launcher principal. No passwords, no user profile, no second account
-- system. See specs/adr/0005-federated-identity-and-runner-tokens.md.

CREATE TABLE IF NOT EXISTS mxt_members (
  principal_id  text PRIMARY KEY,
  display_name  text NOT NULL,
  -- viewer: read runs and reports.
  -- operator: also create/edit cases and tasks, and run them.
  -- admin: also register apps, suites and runners.
  role          text NOT NULL DEFAULT 'viewer',
  launcher_sub  text,
  last_seen_at  timestamptz,
  created_at    timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT mxt_members_role_check CHECK (role IN ('viewer', 'operator', 'admin'))
);

-- Case authoring.
--
-- A tester writes what should be tested; an engineer later writes the code that
-- tests it. Those are different jobs, and the platform already distinguishes
-- them: a case with no implementation simply reports `notRun` until a spec
-- claims its id. So authoring needs no new state machine — only somewhere to put
-- the human-readable intent.
ALTER TABLE mxt_cases
  -- `catalog` came from a synced file in the repository (git is the truth for
  -- those); `platform` was written here in the UI. Sync only retires cases from
  -- the catalog file it is syncing, so the two origins never fight.
  ADD COLUMN IF NOT EXISTS origin text NOT NULL DEFAULT 'catalog',
  -- Ordered natural-language steps: [{ "action": "...", "expect": "..." }]
  ADD COLUMN IF NOT EXISTS steps jsonb NOT NULL DEFAULT '[]'::jsonb,
  ADD COLUMN IF NOT EXISTS preconditions text,
  ADD COLUMN IF NOT EXISTS notes text,
  ADD COLUMN IF NOT EXISTS created_by text,
  ADD COLUMN IF NOT EXISTS updated_at timestamptz NOT NULL DEFAULT now();

CREATE INDEX IF NOT EXISTS mxt_cases_origin_idx ON mxt_cases (app_id, origin)
  WHERE retired_at IS NULL;
