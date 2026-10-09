CREATE TABLE mx_device.device_apps (
 id text PRIMARY KEY,
 mode text NOT NULL CHECK(mode IN ('sim','real')),
 device_id uuid NOT NULL REFERENCES mx_device.devices(id),
 app_id text NOT NULL CHECK(app_id IN ('xhs','weibo')),
 account_key text NOT NULL,
 document jsonb NOT NULL,
 UNIQUE(device_id,app_id),
 UNIQUE(mode,app_id,account_key),
 CHECK(mode = 'sim' OR app_id = 'xhs')
);
CREATE INDEX device_apps_mode ON mx_device.device_apps(mode);

-- Preserve old device-wide cooldowns. App-specific history begins after upgrade.
INSERT INTO mx_device.device_apps(id,mode,device_id,app_id,account_key,document)
SELECT d.id::text || '/' || a.app_id, d.mode, d.id, a.app_id,
 CASE WHEN a.app_id='xhs' THEN d.account_key ELSE 'sim:' || d.id::text || ':weibo' END,
 jsonb_build_object(
   'id', d.id::text || '/' || a.app_id, 'mode', d.mode, 'deviceId', d.id,
   'appId', a.app_id,
   'accountKey', CASE WHEN a.app_id='xhs' THEN d.account_key ELSE 'sim:' || d.id::text || ':weibo' END,
   'cooldownMs', 0, 'cooldownUntil', 0, 'revision', 1,
   'lastClaimedAt', NULL, 'lastDispatchedAt', NULL, 'lastFinishedAt', NULL,
   'lastSucceededAt', NULL, 'lastAttemptId', NULL
 )
FROM mx_device.devices d
CROSS JOIN (VALUES ('xhs'),('weibo')) AS a(app_id)
WHERE d.mode='sim' OR (d.document->>'adapter'='legacy-poc' AND a.app_id='xhs');
