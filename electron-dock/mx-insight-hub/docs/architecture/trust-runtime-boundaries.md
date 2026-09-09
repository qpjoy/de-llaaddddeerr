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
- A remaining Hub-to-Night-All compatibility hop requires a workload token when
  Night-All supports it. Network placement alone is not identity.
- Directly integrated TikHub/JustOne provider secrets live in the isolated Hub
  credential control plane, are selected only by the Admin reveal path and public
  dispatch runtime, and never enter an ordinary management or public response.
  Night-All-owned secrets remain outside Hub only for operations Night-All still
  executes during transition.
- Direct PostgreSQL source passwords are the intentional exception: they are
  plaintext Hub catalog data available only to the Admin Token, and make Hub
  database/backup access credential-sensitive.
- UI-managed external-platform credentials follow the same credential-trusted database/backup boundary;
  reveal additionally requires Admin Token reauthentication.
- Public callers cannot select `provider`, provider `endpointId`, credentials or
  private availability/billing controls. Compatibility aliases accept only their
  bounded documented fields; any supplied `businessId` must match the authenticated
  consumer identity.
- Private Admin is not the public data-plane. A public route must not wildcard proxy the admin listener.

## Failure isolation

- Hub readiness reports providers per operation. Night-All unavailability affects
  only remaining compatibility operations, and Launcher’s main dashboard never
  waits indefinitely for Hub.
- A provider/platform failure is recorded per request and must not disable unrelated platforms.
- There is no automatic retry after an ambiguous provider dispatch. A timeout is
  `unknown`, not a “free failure”; caller idempotency and provider-specific replay
  rules remain in force.
- Routine Hub `down` never stops host Night-All or Launcher and never deletes Hub data.
