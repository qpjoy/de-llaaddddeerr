# mx-pay implementation boundary

- Preserve the package's original `.` rule exports: Hub's existing embedded recharge path still imports them. The independent runtime/SDK is additive; deploying it does not switch Hub or migrate historical money.
- `scripts/manage.sh deploy` is the per-product unattended contract: explicit target, deploy lock, immutable image/config, migration-before-rollout, readiness, nonzero on failure. Never restart Launcher/Hub, use their database, provision all mx-common services, enable real collection, or delete persistent data as a side effect.
- Dedicated PostgreSQL owns payment facts. Confirm + outbox commit atomically; consumers commit their own inbox + business ledger before acknowledging. Keep request keys, application/environment isolation, provider receipt uniqueness, unknown outcomes and immutable audit evidence.
- Machine credentials are distinct from Launcher human sessions and Hub API/Admin tokens. The independent API currently has no human console/SSO, official payment channels, refunds or invoice authority. Never infer those capabilities from the planning docs.
- Kubernetes is the production deployment target; Compose is a development/transition option. Tests with command substitutes do not establish actual rollout availability. Preserve existing credentials and fail on database identity drift.
- Read README.md for current delivery, first-run setup and remaining Hub single-writer cutover. Test financial changes against a disposable PostgreSQL database, never a live business database.
