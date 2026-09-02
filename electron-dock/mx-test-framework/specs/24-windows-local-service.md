# 24 · Windows 本地服务版

> **这份文档描述的是一台 Windows 机器上跑完整平台的形态**，用途是**做测试与出 demo**。
>
> 它和正式形态**不是同一件事**，也不该被当成它的简化版：
>
> | | 本地服务版（本文） | 正式形态（[10](10-deployment.md)、[15](15-server-side-first-run.md)） |
> | --- | --- | --- |
> | 平台跑在哪 | 这台 Windows 的 Docker Desktop | 内网 **Linux** 服务器的 Kubernetes |
> | 执行机 | **同一台机器**（既是服务端又是执行机） | Linux 容器跑 Web；Windows / macOS 机器跑桌面端 |
> | 数据库 | compose 起的一个容器 | namespace 内独立 StatefulSet |
> | 谁用 | 你自己，验证和演示 | 团队，无人值守 |
> | 数据能不能丢 | **能**，随时重来 | 不能，趋势的唯一来源 |
>
> 两者共用同一份代码、同一个镜像、同一套迁移。**不同的只有部署拓扑。**

---

## 1 · 为什么要单独有这一份

三个理由，都是这一轮实跑出来的：

**① 它是唯一能在没有服务器时验证整条链的方式。** 罗盘的 Web 与 Electron 两条流程
第一次跑通就是在这个形态下（[23](23-local-verification.md)）。

**② 桌面端本来就只能在桌面上验。** Electron 的 `.exe` 在 Linux 集群里跑不了。
正式形态下那是"Windows 执行机连内网平台"；在这里是"同一台机器自己连自己"。
**验证的东西完全一样**，链路短一截。

**③ Windows 的坑和 Linux 不一样，而且不写下来就会重复踩。** 见 [§5](#5-windows-特有的坑)。

---

## 2 · 起步

### 2.1 前提

| 项 | 要求 | 怎么确认 |
| --- | --- | --- |
| Docker Desktop | 运行中 | `docker ps` 有响应 |
| **C 盘可用空间** | **≥ 15 GB** | 见 [§5.1](#51-系统盘会被吃光而且报错完全看不出是这个原因)，这是最容易忽略的一条 |
| Node | ≥ 22 | `node --version` |
| 被测仓库 | 已检出 | 见 §3 |

Kubernetes **不需要**。本地服务版走 docker compose，比 k8s 少一层，
且不受 Docker Desktop 的 kubeconfig 证书过期影响（[23 §4](23-local-verification.md)）。

### 2.2 起平台

```bash
cd electron-dock/mx-test-framework
bash scripts/manage.sh local up
```

拉起两个容器：PostgreSQL 与 server，中间跑一次迁移 Job。跑完打开
<http://127.0.0.1:8790>，**账号随便填，密码 `local-admin-change-me`**。

其余命令：

```bash
bash scripts/manage.sh local logs     # 跟日志
bash scripts/manage.sh local down     # 停掉（保留数据卷）
```

> 本地栈的配置写死在 `deploy/compose/docker-compose.yml` 里，包括一个固定的
> `MXT_SECRET_KEY`。**这是故意的**：这套栈是一次性的。正式部署会自己生成密钥
> 并留在 k8s Secret 里（[20 §2](20-secret-store.md)）。

---

## 3 · 接入罗盘

### 3.1 检出 public 分支

Cypress 用例只在 `public` 分支上，`main` 上 `test` 还是 `exit 0`。用 worktree，
**不要切你 `main` 的工作树**：

```bash
git -C E:/world/workspace/mingxi/luopan worktree add ../luopan-e2e public
cd E:/world/workspace/mingxi/luopan-e2e/po-frontend
pnpm install
```

### 3.2 登记到平台

```bash
cd electron-dock/mx-test-framework
MXT_BASE_URL=http://127.0.0.1:8790 \
MXT_ADMIN_TOKEN=local-admin-change-me \
LUOPAN_CHECKOUT=E:/world/workspace/mingxi/luopan-e2e \
  node scripts/onboard-luopan.mjs
```

`LUOPAN_CHECKOUT` 不能省：**它决定用例目录是从仓库里读真的，还是根本不同步**。
早先这个脚本里编了 5 条占位目录，结果 19 条真实用例被判成 `unmapped`——
drift 检测在报告脚本自己制造的问题（[23 §3](23-local-verification.md)）。

---

## 4 · 跑两条流程

### 4.1 Web（自包含，不需要后端）

```bash
cd E:/world/workspace/mingxi/luopan-e2e/po-frontend
pnpm e2e:local
```

`e2e:local` 自己做完三件事：`quasar build` 出生产 SPA → 起静态服务器在
`127.0.0.1:55955` → Cypress 打它。**mock 轨不需要任何账号密码、不需要网络。**

实测 23/23，约 1 分钟（含构建）。

### 4.2 Electron

```bash
# 出包，约 90 秒
cd E:/world/workspace/mingxi/luopan-e2e/po-frontend
pnpm build:electron:installer

# 跑用例（测试团队自己的仓库，po-frontend 零改动）
cd E:/world/workspace/mingxi/luopan-qa-e2e
npm install
MXT_APP_PATH="E:/world/workspace/mingxi/luopan-e2e/po-frontend/dist/electron/Packaged/win-unpacked/罗盘AI情报系统.exe" \
  npx playwright test --config playwright.electron.config.mjs
```

实测 4/4，16.9 秒。用例位置遵循 [ADR-0007](adr/0007-test-code-ownership.md)：
黑盒 e2e 归测试团队的仓库，不往被测仓库提 PR。

### 4.3 让平台自己派活（完整闭环）

上面两条是手工跑。要让**平台派活、执行机自己认领**：

```bash
cd electron-dock/mx-test-framework
node bin/mxt-runner.mjs login --server http://127.0.0.1:8790 --username 你 --password local-admin-change-me
node bin/mxt-runner.mjs register --name "本机 Windows" --engines cypress,playwright-electron --surfaces web,electron

# 数据目录必须指到非系统盘，理由见 §5.1
MXT_RUNNER_DATA_DIR=E:/mxt-runner node bin/mxt-runner.mjs watch
```

然后在界面上建任务、点「立即执行」，执行机会自己：
检出指定 ref → 装依赖 → 跑命令 → 上传产物 → 回报结果。

> **内网免 mx-launcher**：平台登录接受 admin token 当密码，
> `runners:register` 只要 `operator` 角色而 admin token 满足。
> 正式形态下如果配了 `MXT_LAUNCHER_URL`，就走 launcher 联邦登录。

---

## 5 · Windows 特有的坑

这一节是这份文档存在的主要理由。**下面每一条都是实际踩到的，不是设想。**

### 5.1 系统盘会被吃光，而且报错完全看不出是这个原因

执行机默认把**检出、`node_modules`、被测安装包、产物**全放在 `~/.mxt`——
主目录，Windows 上通常是 C: 系统盘。**一个应用就 1.4 GB**，罗盘这种带 Electron
的更多。

第一次真跑就把 C: 填到 0，pnpm 报的是：

```
[ERROR] disk I/O error
```

那读起来像包存储损坏，**完全看不出是"没空间了"**。而且磁盘一满，Docker 引擎也会
卡死，`docker ps` 直接超时——整台机器看起来像坏了。

**必须做**：

```bash
MXT_RUNNER_DATA_DIR=E:/mxt-runner      # 或 --data-dir E:/mxt-runner
```

顺带记住这几个也在 C: 上、且只增不减的缓存：

| 位置 | 实测占用 |
| --- | --- |
| `%LOCALAPPDATA%\Cypress\Cache` | 1.32 GB（**按版本累加，没人会主动清**） |
| `%LOCALAPPDATA%\npm-cache` | 1.24 GB |
| `%LOCALAPPDATA%\electron\Cache` | 1.09 GB |
| Docker 镜像与构建缓存 | 每次 `local up` 重建都留一份悬空镜像 |

`bash scripts/manage.sh clean` 会做 `docker image prune` + `builder prune`
并打印 `docker system df`。**磁盘已经满了之后再 prune 会卡住**——
所以这条要在还有空间时定期跑。

### 5.2 Docker 引擎卡死后的恢复

磁盘满会让引擎进入无响应状态，此时 `docker ps` / `docker system df` 全部超时。
Docker Desktop 进程还活着，WSL 发行版也显示 Running，但引擎不干活。

```powershell
wsl.exe --shutdown        # 只有 docker-desktop 一个发行版时是安全的
```

之后 Docker Desktop 会重新拉起后端，需要几分钟。先确认没有别的 WSL 发行版在用：
`wsl --list --verbose`。

### 5.3 Kubernetes 的客户端证书会过期

Docker Desktop 的 kubeconfig 客户端证书有效期一年。过期后 `kubectl` 全部返回
`the server has asked for the client to provide credentials`，
**但集群本身还在跑**（`docker ps` 能看到 `k8s_*` 容器），很容易误判成集群挂了。

```bash
# 确认是不是这个原因
openssl x509 -in <(...) -noout -dates      # 或看 kubeconfig 里的 client-certificate-data
```

修法：Docker Desktop → Settings → Kubernetes → **Reset Kubernetes Cluster**。
集群 CA 通常有效期一百年，过期的只是客户端证书。

**本地服务版用不到 k8s**，这条是给想在本机试 `manage.sh deploy` 的人。

### 5.4 中文与编码

Git Bash 传中文参数给 `curl -d` 会乱码（平台侧存下来是 `????`）。
写脚本时把 payload 先写进文件再 `--data-binary @file`，
或者干脆用 `node -e` 构造。**平台本身处理中文没有问题**——
乱码只发生在 shell 传参这一段。

### 5.5 执行机的 PATH 可能缺 PowerShell

Cypress 在 Windows 上会 `spawn powershell.exe` 做浏览器探测。从 Git Bash 之类的
shell 启动执行机时，PATH 里有 `System32` 却**没有
`System32\WindowsPowerShell\v1.0`**，于是报：

```
spawn powershell.exe ENOENT
```

这个错从 Cypress 内部抛出，读起来像测试坏了，而不像 PATH 坏了。

**执行机现在自己补齐系统目录**（`System32`、`Wbem`、`WindowsPowerShell\v1.0`），
追加而不是前置，运维自己配的 PATH 仍然优先。所以这条不需要你做什么，
写在这里是因为**在别的 Windows agent 上遇到同类报错时，先看 PATH**。

### 5.6 `E2E_ARTIFACTS_DIR` 是根目录，不是 run 目录

compass 的 `scripts/e2e-runtime.mjs` 把它当**根**，再拼 `E2E_RUN_ID`：

```js
runDir = path.join(process.env.E2E_ARTIFACTS_DIR, runId)
```

平台早先把它和 `MXT_ARTIFACTS_DIR` 设成了同一个值（run 目录），
结果套件写到了 `<runId>/<runId>`，平台在上一层找不到 `summary.json`，
**把一次实际通过的执行判成了 `blocked`**。

现在 `MXT_ARTIFACTS_DIR` 是 run 目录，`E2E_ARTIFACTS_DIR` 是它的父目录，
两者拼回来正好相等。接入别的套件时留意这个区别——**同名不同义的变量最容易踩**。

### 5.7 `pnpm install` 在不同盘上的行为不同

pnpm 的 store 是按盘分的。E: 上装过一次之后，同一台机器在 C: 上装是**全新下载**
（`reused 0`），慢很多，也更容易在空间紧张时失败。

把执行机数据目录和被测检出放在**同一个盘**，能共用 store。

---

## 6 · 这个形态验证不了什么

诚实地列出来，免得拿它当"全都验过了"：

| 验证不了 | 为什么 |
| --- | --- |
| **k8s Job 派发** | 本地服务版走 compose，服务端执行机那条路径不经过 |
| **Linux 容器里的浏览器** | Cypress 在这里跑的是 Windows 上的 Chromium，不是 `cypress/included` 镜像里的 |
| **mx-launcher 联邦登录** | 用的是 admin token 直登 |
| **多执行机的派活与排队** | 只有一台机器 |
| **macOS 的 `_electron`** | 签名 + hardened runtime 的 `.app` 可能拒绝 `--inspect`，需要一台 Mac 单独 spike |
| **通知真的发到群里** | 需要一个可达的 webhook 地址 |

反过来，它**能**验证的是：平台的完整数据链路（派活 → 认领 → 检出 → 执行 → 产物 →
归一 → 目录比对 → 报告）、Cypress 与 Playwright 两种引擎的接入、JUnit 与
`summary.json` 两种结果格式、Electron 打包产物的驱动能力。

**这些恰好是"上服务器之后能不能直接出 demo"要回答的全部问题。**

---

## 7 · 迁到正式形态时会变什么

| 这里 | 正式形态 | 要改的东西 |
| --- | --- | --- |
| `manage.sh local up` | `manage.sh deploy` | 无——同一个镜像、同一套迁移 |
| compose 里写死的 `MXT_SECRET_KEY` | deploy 自动生成，存 k8s Secret | 无 |
| `repoUrl` 指向本机路径 | 指向 GitHub / 内网 Git | 改 suite 配置，加 `MXT_GIT_TOKEN` |
| 同一台机器既是服务端又是执行机 | 服务端在 Linux，执行机连过来 | 执行机 `login --server http://<内网 IP>:30879` |
| Web 套件 `runnerKind: local` | `runnerKind: server`（k8s Job 跑） | 改 suite 配置 |
| Electron 套件 | **不变**，仍然是 Windows 执行机 | 无 |

**Electron 那条链在两种形态下是同一条**——这是本地服务版最有价值的地方：
桌面端你在这里验过什么，上服务器之后就是什么。
