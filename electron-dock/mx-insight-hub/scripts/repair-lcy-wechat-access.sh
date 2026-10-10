#!/usr/bin/env bash
# Run on the Internal server from an updated Hub checkout. No rollout or supplier call.
set -euo pipefail
cd "$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
mode="${1:---preview}"
if [ "$#" -gt 1 ] || { [ "$mode" != --preview ] && [ "$mode" != --apply ]; }; then
  echo 'Usage: bash scripts/repair-lcy-wechat-access.sh [--preview|--apply]' >&2
  exit 2
fi
pod=(kubectl -n mx-insight-hub exec -i deployment/mx-insight-hub-admin --)
price_args=(--provider tikhub --missing-budget-minor 100000)
for operation in \
  native.wechat.mp.article-detail \
  native.wechat.mp.article-detail-h5 \
  native.wechat.mp.article-stats-h5 \
  native.wechat.mp.article-stats \
  native.wechat.mp.article-comments \
  native.wechat.mp.comment-replies \
  native.wechat.mp.related-articles \
  native.wechat.mp.article-ad \
  native.wechat.mp.account-profile \
  native.wechat.mp.account-articles \
  native.wechat.mp.account-services \
  native.wechat.search.search; do
  price_args+=(--operation "$operation")
done

echo '[wechat-access] Current Key grants, runtime controls and customer quotes (read-only)'
"${pod[@]}" node --input-type=module - < scripts/check-lcy-wechat-access.mjs
echo '[wechat-access] Missing procurement price preview (read-only, only the 12 selected operations)'
"${pod[@]}" node --input-type=module - "${price_args[@]}" < scripts/migrate-missing-operation-prices.mjs
if [ "$mode" = --preview ]; then exit 0; fi

echo '[wechat-access] Apply only migration 140 through the existing checksum/advisory-lock migrator'
"${pod[@]}" node --input-type=module -e '
  import { mkdtemp, writeFile, rm } from "node:fs/promises";
  import { tmpdir } from "node:os";
  import { join } from "node:path";
  import { runMigrations } from "./server/migrate.mjs";
  const directory = await mkdtemp(join(tmpdir(), "lcy-wechat-140-"));
  try {
    let sql = "";
    for await (const chunk of process.stdin) sql += chunk;
    await writeFile(join(directory, "140_lcy_wechat_mp_grants.sql"), sql, { mode: 0o600 });
    await runMigrations({ connectionString: process.env.DATABASE_URL, migrationsDir: directory });
  } catch (error) {
    const safe = /^(LCY WeChat grants|Another MX Insight Hub migration|Applied migration changed:)/.test(error.message);
    console.error(safe ? error.message : "WeChat migration failed; database details withheld");
    process.exitCode = 1;
  } finally { await rm(directory, { recursive: true, force: true }); }
' < migrations/140_lcy_wechat_mp_grants.sql

echo '[wechat-access] Fill missing procurement prices at 0.01 in the original currency; preserve existing prices'
"${pod[@]}" node --input-type=module - "${price_args[@]}" --apply < scripts/migrate-missing-operation-prices.mjs
echo '[wechat-access] Final read-only verification; runtime readiness does not prove supplier health'
"${pod[@]}" node --input-type=module - < scripts/check-lcy-wechat-access.mjs
