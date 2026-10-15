-- Device capabilities, calibration and pool policies live in existing JSON documents.
-- This additive migration registers only a simulated workflow; no real capability is enabled.
ALTER TABLE mx_device.device_apps DROP CONSTRAINT device_apps_app_id_check;
ALTER TABLE mx_device.device_apps ADD CONSTRAINT device_apps_app_id_check
 CHECK(app_id IN ('xhs','weibo','xianyu'));
-- The existing CHECK(mode='sim' OR app_id='xhs') still protects real devices.
INSERT INTO mx_device.task_definitions VALUES (
 'sim:xianyu.refresh:1','sim','xianyu.refresh',1,
 '{"id":"sim:xianyu.refresh:1","mode":"sim","code":"xianyu.refresh","name":"闲鱼 · 下拉刷新","appId":"xianyu","loop":"small","steps":[{"code":"app.open","repeat":1},{"code":"xianyu.refresh","repeat":1}],"resumable":false,"version":1,"createdAt":0,"executionModel":"checkpoint-session.v1"}'::jsonb
);
