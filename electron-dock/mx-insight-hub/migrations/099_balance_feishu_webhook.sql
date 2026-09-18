-- Feishu bot hooks move from deployment environment to operator-editable policy
-- (2026-09-18). The notifier reads this column on every pass, so changing a hook
-- in the Admin console takes effect within one pass and never needs a restart.
ALTER TABLE external_platform.balance_monitors ADD COLUMN feishu_webhook text;

-- Seed the groups that were already receiving these alerts from the standalone
-- script, so the first deploy is not silent. Only a row that has no hook yet is
-- touched, which keeps this safe to re-run and never overwrites an operator edit.
UPDATE external_platform.balance_monitors SET feishu_webhook =
  'https://open.feishu.cn/open-apis/bot/v2/hook/6093808e-6a97-4160-8f3c-af97b1f1d151'
WHERE provider_key = 'tikhub' AND feishu_webhook IS NULL;
UPDATE external_platform.balance_monitors SET feishu_webhook =
  'https://open.feishu.cn/open-apis/bot/v2/hook/1790e6fa-fe18-4501-b55e-2de84d0c2fb1'
WHERE provider_key = 'justone' AND feishu_webhook IS NULL;

COMMENT ON COLUMN external_platform.balance_monitors.feishu_webhook IS
  'Bot hook for this platform. Secret-bearing: never returned by an API, logged or copied into observations/audit records.';
