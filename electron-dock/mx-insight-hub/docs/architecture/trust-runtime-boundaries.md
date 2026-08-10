# Trust and runtime boundaries

## Domain and route semantics

| Name | Reachability | Meaning | Status |
| --- | --- | --- | --- |
| `night-all.mxinfo-inc.cn` | MX-H2I private split DNS | Existing Night-All Console/origin. It is not a customer API contract. | Existing |
| `insight.mxinfo-inc.cn` | Proposed MX-H2I private split DNS | MX Insight operator Admin UI. Must route only to the admin Service. | Proposed |
| `gate.night-all.mxinfo-inc.cn` | Proposed MX-H2I private split DNS | Private caller entry to the Hub public Service, never direct Night-All. | Proposed |
| `insight-api.minsight-ai.com` | Future public DNS/TLS | Public customer API candidate, independent of Night-All branding. | Not approved |

`gate.night-all.mxinfo-inc.cn` is semantically acceptable for the private MVP, but it is a two-level subdomain. A certificate for `*.mxinfo-inc.cn` does not cover it. Use an exact SAN, `*.night-all.mxinfo-inc.cn`, or rename it to a one-level host such as `night-all-gate.mxinfo-inc.cn` before enabling HTTPS.

## Split listeners

The same image runs in three modes:

- `public`: health and `/api/v1/**` only, port `18150`.
- `admin`: health, static Admin UI and `/internal/v1/admin/**` only, port `18151`.
- `combined`: both surfaces for local development only, port `18180`.

The public Kubernetes Service never selects an admin-mode Pod. This matters because the current gateway routes by host and does not itself enforce MX Insight API-key semantics.

## Security boundaries

- Public API keys are checked inside MX Insight on every request; gateway metadata is not authorization.
- Launcher-to-Hub management calls use a separate admin token and short timeout.
- Hub-to-Night-All requires a workload token when Night-All supports it. Network placement alone is not identity.
- Night-All provider secrets never enter the Hub database or public response.
- Direct PostgreSQL source passwords are the intentional exception: they are
  plaintext Hub catalog data available only to the Admin Token, and make Hub
  database/backup access credential-sensitive.
- Public requests reject `businessId`, `provider`, `endpointId`, `availabilityMode`, arbitrary `params`, and raw-response flags.
- Private Admin is not the public data-plane. A public route must not wildcard proxy the admin listener.

## Failure isolation

- Hub readiness can report Night-All unavailable, but Launcher’s main dashboard never waits indefinitely for Hub.
- A provider/platform failure is recorded per request and must not disable unrelated platforms.
- There is no automatic retry after Night-All dispatch until Night-All supports an end-to-end idempotency token. A timeout is `unknown`, not “free failure”.
- Routine Hub `down` never stops host Night-All or Launcher and never deletes Hub data.
