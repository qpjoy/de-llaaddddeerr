# Instagram account acquisition: 54156c46

## Saved evidence

The operator exported request `54156c46-247b-4783-ba5a-24a070be6b88`, provider call
`5f00a6f4-7575-4b02-a805-e285bc2883fb`, upstream request
`7c36b8fe-c8ab-4c3c-9b3d-ccd701c4b9af`. The first call was TikHub
`native.t.api_622ad609d30f9780` (`GET /api/v1/instagram/v2/fetch_user_info`).
Hub saved HTTP 502 / `invalid_social_contract`; supplier HTTP and business code
were 200, and the provider ledger says `billed=true`.

The restricted archive is 1,336 bytes, with verified SHA256
`212216a9cdac8e6381af466530a9af130624008ffb1b81c9bb598af4ba3df18d`.
Its outer envelope contains `code`, `message`, and an object `data`. The first
shape export exposed only `data.status` as a boolean and counted two other
fields. Their names and values, including the boolean value, were not exported.
Offline production projection failed with `profile_identity_missing`.

The deployed `hub-social-compat.mjs` SHA256 is
`9dfac24a1dadbb6b657caf9da22721f532c62b06f292b693fde789f344d06b7d`, equal to the
local source after converting CRLF to LF. This failure means the parser could
not find a supported account identity. It does not establish that the account
does not exist. Do not map this evidence alone to `social_account_not_found`.

## Authorized verification

The user authorized a few paid verification requests on 2026-11-20. This batch
is capped at **three supplier attempts**, including attempts whose billing or
transport result is unknown. No paid request has been made from the local
Windows workspace. The operator chose execution on the production kubectl host.

| Slot | Account | Hub native POST route |
| --- | --- | --- |
| 1 | Original account, reconstructed privately from the saved request | `/api/v1/data/native/t.api_622ad609d30f9780` |
| 2 | Official example username `instagram` | `/api/v1/data/native/t.api_622ad609d30f9780` |
| 3, only if needed | Original account's known username | `/api/v1/data/native/t.instagram_v3_get_user_profile` |

Each route forwards one profile request. There is no crawl, pagination, or
automatic transport retry. V3 is skipped when the original input only provides
a numeric user ID. The control is skipped when the original username is already
`instagram`, avoiding a duplicate purchase. A usable original profile or an
unambiguous missing-account signal ends verification early; a signal still
requires review before changing the public error mapping. Unknown outcomes stop
the batch.

The original Key's temporary demo credential retains its existing consumer,
permissions, limits and charges. Native access requires the `social` platform
and exact native capability; the original crawl permission alone is insufficient.
The probe does not grant access, change a price or route, switch callers, or
modify Launcher, SSO, MX-H2I login or networking. Native HTTP 200 is evaluated
against its archived data rather than treated as proof of usable profile data.

## Operator command

Sync both new files into the server checkout:

- `server/ops/probe-instagram-account-54156c46.sh`
- `server/ops/probe-instagram-account-54156c46.mjs`

No image rollout or migration is needed. From `electron-dock/mx-insight-hub` on
the production kubectl host, execute the authorized batch once:

```bash
bash server/ops/probe-instagram-account-54156c46.sh --execute
```

For read-only inspection, including after an interrupted run:

```bash
bash server/ops/probe-instagram-account-54156c46.sh --inspect
```

The wrapper claims this batch under
`${XDG_STATE_HOME:-$HOME/.local/state}/mx-insight-hub/instagram-account-54156c46/`
before entering the Admin Pod. The marker survives Pod replacement; the program
also checks its fixed idempotency keys and saved receipts. Preserve markers even
if the command fails or no receipt is immediately visible. Do not clear markers,
change host/state directory, or rerun the underlying execute command to repurchase.

Return the sanitized JSON report. Do not paste API keys, the full restricted
archive, or the original account request. Probe results do not rewrite the
original failed response or charges, and do not by themselves deploy a fix.

## Local validation

The probe is tested offline using the actual deployed-contract source, synthetic
archives, fake Hub HTTP/database responses, and real temporary attempt files.
Coverage includes the three-call ceiling, caller identity, readiness, early
stopping, unknown outcomes, old/expired receipts, persistent markers, read-only
inspection, archive integrity and sanitized output. The Bash wrapper was tested
with stub commands for inspection, invalid input, repeat execution and failures.
These checks do not establish production readiness or consume the paid budget.
