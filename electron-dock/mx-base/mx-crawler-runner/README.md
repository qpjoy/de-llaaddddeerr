# mx-crawler-runner

Runs reviewed collection packages (the delivered `adapter.py` projects) for mx-insight-hub. Each invocation is one adapter process. Hub calls the runner through engines of kind `runner`.

Design and decisions: [spider_man 07 §12](../../mx-insight-hub/docs/architecture/spider_man/07-collect-engines.md#12-阶段-4runner-与应用商店).

## What it will and will not do

- **Allowlist only.** It runs only the slots in [packages.json](packages.json), and only each slot's listed operations.
- **Integrity checks.** It runs a package only while the package tree still matches the recorded sha256. A mismatched or uninstalled package is refused with HTTP 424; the other packages keep working.
- **Vendored upstream libraries are hash-checked too.** A changed library disables exactly the packages that import it.
- **Requests never carry code, commands, interpreters or paths.** `work_dir`, `run_dir` and `runtime_dir` are always set by the runner. A request that tries to set them, or `proxy` / `node_path`, is rejected.
- **Durable registration.** Every invocation is written to disk and fsynced before its process starts. A 404 therefore means the runner never started that `dispatchId`.
- **Process groups.** Each adapter runs in its own process group. At the deadline, on abort or on shutdown, the whole group is stopped, including the Scrapy worker and the Node backend.
- **Restarts.** On restart, records still marked running are marked `interrupted`.
- **Minimal child environment.** Children get `PATH`, `HOME` and `TMPDIR` (both inside the work directory), UTF-8 settings and `PYTHONPATH=<package>/src`.
  - Children never see the runner token.
  - A proxy is passed only to packages that allow one (Google Play), and only when Hub sends it.
  - The proxy URL is never written to records or logs, and it is redacted from both stderr and the adapter's own output.
- **Limits.**
  - At most 24 processes at once, and at most 4 per slot. Beyond that the runner answers 429 and registers nothing, and Hub fails that job (not charged). Keep the total execution slots of all Hub runner engines at or below 24; the standard set uses 18.
  - Adapter stdout is capped at 4 MiB − 64 KiB.
  - Records and work directories are kept for 24 hours.

## HTTP (Hub only, bearer token)

| Request | Answer |
|---|---|
| `GET /v1/health` | `{ ok, protocol, version, capacity, running, slots: [{ slotId, available, reason, operations, proxy }] }` |
| `POST /v1/invocations` | Body: `{ protocol: "mx-crawler-runner.v1", dispatchId, slotId, operation, params, deadlineMs, proxyUrl? }`, or `steps: [{ operation, params }]` (1–4) instead of `operation`/`params`. Steps run in order in one work directory; a step runs only if the previous one returned `success` or `partial`. The result's `envelope`/`failure` is the last step that ran, and `steps` lists every step.<br>Returns 202 when accepted; 200 when the same request was sent before.<br>Errors: 409 a different request reused the `dispatchId`; 424 package unavailable; 429 busy; 400/404 invalid request. |
| `GET /v1/invocations/{dispatchId}` | `accepted` / `running` / `completed`.<br>A completed invocation has `envelope` (the adapter's JSON) or `failure: { code }`. Failure codes: `deadline_exceeded`, `aborted`, `interrupted`, `output_unusable`, `output_too_large`, `spawn_failed`, `workdir_unavailable`. |
| `POST /v1/invocations/{dispatchId}/abort` | Stops the process group and answers once the process has ended. |

## Packages

| Slot | Package | Operations | Egress |
|---|---|---|---|
| `market-195` | Xiaomi app store | `collect` | direct |
| `market-197` | vivo app store | `collect` | direct |
| `market-198` | Tencent App Store (应用宝) | `collect` | direct |
| `market-216` | Baidu Mobile Assistant (百度手机助手) | `collect` | direct |
| `market-217` | Lenovo app store | `collect` | direct |
| `market-219` | Wandoujia (豌豆荚) | `collect` | direct |
| `market-193` | Google Play | `app`, `search`, `reviews`, `list`, `developer`, `suggest`, `similar`, `permissions`, `datasafety` (`categories` never passed acceptance and is not offered) | proxy chosen by Hub |
| `pinterest-94` | Pinterest (gallery-dl) | `collect` | proxy chosen by Hub |
| `medium-96` | Medium (medium-scraper) | `collect` | proxy chosen by Hub |
| `snapchat-98` | Snapchat Spotlight (yt-dlp) | `collect` | proxy chosen by Hub |
| `dailymotion-101` | Dailymotion (yt-dlp) | `collect` | proxy chosen by Hub |
| `kick-104` | Kick (yt-dlp) | `collect` | proxy chosen by Hub |
| `substack-105` | Substack (substack_api) | `collect` | proxy chosen by Hub |
| `wordpress-107` | WordPress.com (blog2epub) | `collect` | proxy chosen by Hub |
| `xiaoyuzhou-45` | 小宇宙 (audio) | `discover`, `collect` | direct |
| `ximalaya-46` | 喜马拉雅 (audio) | `discover`, `collect` | direct |
| `applepodcasts-220` | Apple Podcasts (audio) | `discover`, `collect` | proxy chosen by Hub |
| `librivox-222` | LibriVox (audio) | `discover`, `collect` | proxy chosen by Hub |

Packages are copied unchanged from the delivery, except that their bundled upstream checkouts (`upstream/`, which include `.git`) are left out.

Upstream libraries:

- **Location and loading.** Each library sits in [upstream/](upstream) as `<name>@<commit12>/`. It holds only the import package, taken with `git archive` at the commit the supplier validated, plus its LICENSE and a `SOURCE.json`. The library is put on `PYTHONPATH` after the package source; it is never built or installed.
- **Sharing.** One copy serves every package that uses that commit. Snapchat, Dailymotion and Kick all use the same yt-dlp.
- **Credential scrub.** Upstream extractors hard-code some third-party credentials, such as yt-dlp's Shahid AWS keys and several public Google API keys. GitHub push protection blocks those, and none of our packages calls those extractors.
  - `scripts/scrub-upstream.mjs` empties each such literal in place, marks the line, and lists it under `scrubbed` in the upstream's `SOURCE.json`; `--check` only reports.
  - It skips what our packages actually use: yt-dlp's Dailymotion client credential is a lowercase hex value, which the rules do not match.
- **Updating.** Run `node scripts/vendor-upstream.mjs --package <delivered dir> --name <name> --paths <import dir>,LICENSE` (it scrubs before hashing), then `lock-packages --write`, then reinstall.
- **WordPress (107).** It installs from [overrides/107/requirements.linux.txt](overrides/107/requirements.linux.txt): the delivered lock minus the Kivy, Windows and Android packages its crawl path never imports.

- `node scripts/lock-packages.mjs` checks every package against `packages.json`.
- After reviewing a package change, `--write` records the new hashes.

## Local run

```bash
node scripts/install-packages.mjs --index-url https://mirrors.aliyun.com/pypi/simple/ --npm-registry https://registry.npmmirror.com
mkdir -p .data && openssl rand -hex 24 > .data/token
node src/main.mjs --listen 127.0.0.1:18190 --data-dir .data/runtime --token-file .data/token
npm test
```

`install-packages.mjs` does the following:

- Verifies every package against its recorded hash.
- Creates one Python environment per distinct lock, under `.venvs/`, and links it as `packages/<id>/.venv`. Packages with identical locks share one environment; the six domestic markets do.
- Uses Python 3.13, the version the supplier validated every package on. Locally, `uv`'s CPython works: pass `--python <path>/python3.13`.
- Imports every vendored upstream with that environment, so a dependency missing from a lock fails at install time.
- Installs the Google Play Node backend with `npm ci`.
- Runs each package's offline `test_adapter.py`.

## Deploy (Internal, Hub node)

```bash
# from electron-dock, after the Hub deploy, with the same PROXY:
PROXY=127.0.0.1:7788 bash scripts/manage.sh deploy mx-crawler-runner   # short name: runner
# equivalent, from this directory:
PROXY=127.0.0.1:7788 bash scripts/deploy.sh all     # build → import into containerd → token Secret → apply → health
```

- **Unified entry.** `scripts/manage.sh` here is the adapter it calls: `deploy` runs `deploy.sh all`, and any other subcommand is passed through.
- **Not part of `deploy all`.** Every rollout restarts the runner, so deploy it only when its code or packages change.

Full rollout and acceptance steps, including the Hub side, are in [collect-engines-rollout.md](../../mx-insight-hub/docs/operations/collect-engines-rollout.md).

- **Build network.** `PROXY` (or `MX_INSIGHT_BUILD_PROXY`) is normalized the same way as the unified `electron-dock/scripts/manage.sh` entry and reuses the proxy-scoped buildx builder that the Hub deploy creates, so deploy Hub first with the same value. Without a proxy, `MX_INSIGHT_BUILD_NETWORK=host` builds on the host network.

- The deployment manifest is [deploy/k8s/mx-crawler-runner.yaml](deploy/k8s/mx-crawler-runner.yaml).
  - It is separate from Hub's kustomization, so Hub deploys never touch it.
  - It runs with hostNetwork on 127.0.0.1:18190, on the same node as Hub Admin.
  - Records are kept on the host at `/var/lib/mx-crawler-runner`.
- In Hub, open 自建引擎 and create one runner engine per package slot:
  - Address: `http://127.0.0.1:18190`.
  - Credential key: `collect-runner`. `node scripts/collect-acceptance.mjs runner-token` (in mx-insight-hub) copies the token from the `mx-crawler-runner-token` Secret without printing it.
  - Probe the engine, then bind its routes.
