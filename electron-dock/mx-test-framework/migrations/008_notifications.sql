-- Notification channels and the outbox that delivers to them.
--
-- Two tables rather than one because they answer different questions.
-- The channel table answers "where should alerts go"; the outbox answers
-- "was that alert actually delivered", which is the only question anyone
-- asks after saying "I never got the message".

CREATE TABLE IF NOT EXISTS mxt_notification_channels (
  id          text PRIMARY KEY,
  -- NULL means every app. A platform-wide ops channel is the common case, so
  -- it must not require registering the same webhook once per application.
  app_id      text REFERENCES mxt_apps(id) ON DELETE CASCADE,
  name        text NOT NULL,
  kind        text NOT NULL,                        -- webhook | feishu | wecom
  config      jsonb NOT NULL DEFAULT '{}'::jsonb,   -- {url, secret}
  -- Which transitions this channel wants. Splitting them is what lets
  -- `blocked` go to the ops group while `failure` goes to the product group.
  events      jsonb NOT NULL DEFAULT '["failure","recovery","blocked"]'::jsonb,
  enabled     boolean NOT NULL DEFAULT true,
  created_by  text,
  created_at  timestamptz NOT NULL DEFAULT now(),
  updated_at  timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS mxt_notification_channels_app_idx
  ON mxt_notification_channels (app_id) WHERE enabled;

-- The outbox. A notification is written here in the same breath as the run
-- result, then delivered by the scheduler tick.
--
-- Writing first and sending later is deliberate: sending inline would make the
-- runner's `:complete` call wait on someone else's chat server, and a restart
-- between "run recorded" and "alert sent" would lose the alert silently.
CREATE TABLE IF NOT EXISTS mxt_notifications (
  id            text PRIMARY KEY,
  channel_id    text NOT NULL REFERENCES mxt_notification_channels(id) ON DELETE CASCADE,
  run_id        text REFERENCES mxt_runs(id) ON DELETE CASCADE,
  event         text NOT NULL,                      -- failure | recovery | blocked
  payload       jsonb NOT NULL DEFAULT '{}'::jsonb, -- the composed message
  status        text NOT NULL DEFAULT 'pending',    -- pending | sent | failed
  attempts      integer NOT NULL DEFAULT 0,
  last_error    text,
  created_at    timestamptz NOT NULL DEFAULT now(),
  delivered_at  timestamptz
);

CREATE INDEX IF NOT EXISTS mxt_notifications_pending_idx
  ON mxt_notifications (created_at) WHERE status = 'pending';
