-- Platform accounts as a pacing scope that follows the account across devices.
-- Each existing device App row already names exactly one account (unique per
-- App); seed one active account per row with empty usage. Earned deadlines on
-- devices and device Apps are unchanged.
CREATE TABLE IF NOT EXISTS mx_device.accounts (
 id text PRIMARY KEY,
 mode text NOT NULL CHECK(mode IN ('sim','real')),
 app_id text NOT NULL,
 account_key text NOT NULL,
 status text NOT NULL CHECK(status IN ('active','limited','review','retired')),
 document jsonb NOT NULL,
 version bigint NOT NULL DEFAULT 1,
 UNIQUE(mode,app_id,account_key),
 CHECK(document->>'id'=id AND document->>'status'=status)
);
INSERT INTO mx_device.accounts(id,mode,app_id,account_key,status,document,version)
SELECT a.mode||'/'||a.app_id||'/'||a.account_key, a.mode, a.app_id, a.account_key, 'active',
 jsonb_build_object(
  'id', a.mode||'/'||a.app_id||'/'||a.account_key, 'mode', a.mode, 'appId', a.app_id,
  'accountKey', a.account_key, 'status', 'active', 'statusReason', NULL, 'statusAt', NULL,
  'revision', 1, 'cooldownUntil', 0, 'restReason', NULL, 'runs', '[]'::jsonb,
  'hourly', jsonb_build_object('hour', 0, 'counts', '[]'::jsonb),
  'totals', jsonb_build_object('sessions', 0, 'serviceMs', 0),
  'signals', '[]'::jsonb, 'lastDispatchedAt', NULL, 'lastFinishedAt', NULL),
 1
FROM mx_device.device_apps a
ON CONFLICT DO NOTHING;
