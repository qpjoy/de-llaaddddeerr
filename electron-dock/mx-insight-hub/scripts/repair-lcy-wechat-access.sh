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

echo '[wechat-access] Apply only migration 140 from stdin with the existing migration lock and checksum ledger'
"${pod[@]}" node --input-type=module -e '
  import { createHash } from "node:crypto";
  import pg from "pg";
  import { acquireMigrationLock } from "./server/migrate.mjs";
  const filename = "140_lcy_wechat_mp_grants.sql";
  const client = new pg.Client({ connectionString: process.env.DATABASE_URL, connectionTimeoutMillis: 10000 });
  let transaction = false;
  try {
    let sql = "";
    for await (const chunk of process.stdin) sql += chunk;
    if (!sql.trim()) throw new Error("LCY WeChat grants refused: empty migration input");
    if (!process.env.DATABASE_URL) throw new Error("LCY WeChat grants refused: DATABASE_URL missing");
    const checksum = createHash("sha256").update(sql).digest("hex");
    await client.connect();
    await acquireMigrationLock(client);
    await client.query("BEGIN");
    transaction = true;
    const applied = await client.query("SELECT checksum FROM schema_migrations WHERE filename=$1", [filename]);
    if (applied.rows[0] && applied.rows[0].checksum !== checksum) throw new Error(`Applied migration changed: ${filename}`);
    if (!applied.rows[0]) {
      await client.query(sql);
      await client.query("INSERT INTO schema_migrations(filename,checksum) VALUES($1,$2)", [filename, checksum]);
    }
    await client.query("COMMIT");
    transaction = false;
    console.log(`${applied.rows[0] ? "already applied" : "applied"} ${filename}`);
  } catch (error) {
    if (transaction) await client.query("ROLLBACK").catch(() => {});
    const safe = /^(LCY WeChat grants|Another MX Insight Hub migration|Applied migration changed:)/.test(error.message);
    console.error(safe ? error.message : "WeChat migration failed; database details withheld");
    process.exitCode = 1;
  } finally { await client.end(); }
' < migrations/140_lcy_wechat_mp_grants.sql

echo '[wechat-access] Fill missing procurement prices at 0.01 in the original currency; preserve existing prices'
"${pod[@]}" node --input-type=module - "${price_args[@]}" --apply < scripts/migrate-missing-operation-prices.mjs
echo '[wechat-access] Final read-only verification; runtime readiness does not prove supplier health'
"${pod[@]}" node --input-type=module - < scripts/check-lcy-wechat-access.mjs
