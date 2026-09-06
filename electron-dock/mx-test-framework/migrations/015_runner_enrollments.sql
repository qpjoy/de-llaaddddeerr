-- Turning a machine into an execution machine without logging in on it.
--
-- The old path was `mxt-runner login` — type your mx-launcher password into a
-- terminal on whatever computer you happen to be at. This replaces it with a
-- code the platform issues to a person who is already logged in *in a browser*,
-- and which that person pastes into one command. See docs/25 §6.
--
-- Why a separate short-lived credential rather than the person's own token:
-- the command ends up in shell history, in a chat message, on a sticky note.
-- Fifteen minutes and one use is a blast radius; a session token is not.

CREATE TABLE IF NOT EXISTS mxt_runner_enrollments (
  id           text PRIMARY KEY,
  -- Only the hash, like every other credential in this schema. A leaked backup
  -- must not contain anything that can enrol a machine.
  code_sha256  char(64) NOT NULL UNIQUE,
  -- Who the machine will belong to. Taken from the browser session that asked
  -- for the code, never from the machine that redeems it.
  principal    text NOT NULL,
  expires_at   timestamptz NOT NULL,
  -- Single use. `used_at IS NULL` in the redeem UPDATE is what enforces it, so
  -- two machines racing on the same code cannot both win.
  used_at      timestamptz,
  runner_id    text REFERENCES mxt_runners(id) ON DELETE SET NULL,
  created_at   timestamptz NOT NULL DEFAULT now()
);

-- The redeem path looks up by hash; the browser polls by id. Nothing else
-- queries this table, and expired rows are swept with the runs.
CREATE INDEX IF NOT EXISTS mxt_runner_enrollments_expiry_idx
  ON mxt_runner_enrollments (expires_at);

COMMENT ON TABLE mxt_runner_enrollments IS
  'One-shot codes that let a machine register itself without a person signing in on it.';
