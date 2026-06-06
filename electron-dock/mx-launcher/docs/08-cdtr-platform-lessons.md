# CDTR / DRTC Lessons for MX Launcher

Source reviewed: `/Users/qpjoy/workspace/mingxi/dock-ppt-show/DRTC`.

The DRTC folder is a CDTR planning deck. CDTR means Config, Deploy, Test, and
Release. The useful part for MX Launcher is not the slide UI itself, but the
platform framing: Launcher should become a governed delivery platform, not only
a desktop installer.

## Lessons To Fold Into MX Launcher

### 1. Four Centers

MX Launcher should absorb the CDTR chain as server/backend modules:

| CDTR Center | MX Launcher Module | Launcher Meaning |
| --- | --- | --- |
| Config | `server/config-center` | product config, env, secrets, feature flags, DNS zones, signed snapshots |
| Deploy | `server/deploy-center` / `runner-controller` | D/I/O site setup, K8s baseline, scripts, runner jobs, status and logs |
| Test | `server/test-center` | smoke, E2E, release gates, client/network validation |
| Release | `server/release-center` | desktop packages, service binaries, server images, config snapshots, staged rollout and rollback |

This maps cleanly to the current MX Launcher goal: one platform manages desktop,
server, site agents, product resources, and customer delivery kits.

### 2. Standard Objects

CDTR emphasizes standard objects instead of technology-specific coupling. MX
Launcher should use the same idea:

- `Project`: MX Launcher ecosystem or a customer tenant project.
- `Application`: HDO, Tunnel, future products, admin console, server modules.
- `Environment`: dev, shadow, staging, production, customer demo.
- `Site`: Internal, Domestic, Oversea, H endpoint.
- `Config Set`: product/env/site/user/device/install scoped config.
- `Operation`: build, deploy, enroll, test, release, rollback, repair.
- `Release`: a business delivery plan spanning desktop, server, config, runner,
  DNS, and access nodes.

### 3. K8s Quality Baseline

The deck argues for K8s as a quality baseline where hardware allows it. For MX
Launcher:

- Internal uses K8s for Postgres-adjacent services, Elastic, config, release,
  runner-controller, admin, and HDO control plane.
- Domestic remains lightweight because 4G memory is enough for edge/proxy/cache.
- Oversea runs only access/site-agent/runner-worker beside
  `hysteria2-mihomo-stack`.
- K8s manifests and compose profiles should both be generated from site profile
  declarations under `deploy/`.

### 4. Project / App Self-Registration

CDTR avoids building a service discovery platform in V1. It asks applications
to self-register facts. MX Launcher can use this directly:

- `qp-tunnel-cli mx site enroll` registers D/I/O site facts.
- MX Launcher desktop registers install/device facts.
- Site agents register version, capabilities, local endpoints, runner mode,
  logs, and health.
- Future SDKs can register non-HDO applications into the same platform.

### 5. Gates Before Release

Release Center should block risky releases unless gates pass:

- config snapshot is valid and signed;
- desktop package is signed/notarized where required;
- server image has digest and migration plan;
- runner dry-run passed;
- smoke/E2E tests passed for the target site;
- rollback plan exists;
- audit actor and approval are recorded.

### 6. Gray Release And Experiment Conditions

CDTR's gray strategy maps to Launcher rollout:

- by tenant/org/user/device/install;
- by platform and client version;
- by site role and geography;
- by channel: shadow, beta, stable, customer-demo;
- by failure budget and health metrics;
- by feature flag or config snapshot version.

### 7. Unified Status And Audit

Every action should leave a fact trail:

- who changed config;
- who enrolled a site;
- which runner job touched Oversea;
- which package was delivered to which install;
- which config snapshot a user received;
- which test gate allowed release;
- how rollback was triggered.

Audit truth lives in Postgres. Elastic is for search and operations.

### 8. Agent Path

CDTR suggests proving automation in Codex first, then turning stable actions
into server-side agents and runners. MX Launcher should follow that:

1. Use Codex/operator scripts to prove D/I/O setup and migration.
2. Convert repeated steps into `scripts/manage.sh`.
3. Expose the same actions in admin console.
4. Move heavy site operations into `site-agent` and runner jobs.
5. Require approvals for production mutations.

## V1 Implications

MX Launcher V1 should include:

- internal user center and permissions;
- product/app registry;
- site registry for Internal/Domestic/Oversea;
- config center with versioned signed snapshots;
- deploy center with runner jobs and logs;
- smoke/E2E gate records;
- release center with artifacts, channels, gray rollout, and rollback;
- observability and audit views;
- CLI and admin console over the same operation model.

V1 should not include:

- full service discovery;
- uncontrolled agent changes to production;
- SDKs doing dynamic routing;
- unreviewed repository scans becoming final deployment plans.

These lessons should guide future work under `electron-dock/mx-launcher`, not a
separate platform project.
