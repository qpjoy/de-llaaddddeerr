# 23 · 本机验证记录

> 2026-09-01。第一次把平台**真正部署起来**，并让罗盘的 web 与 electron 两条流程
> 端到端跑通。此前二十多轮的所有结论都是内存态 + 单元测试得出的；这一轮把它们
> 放到真容器、真 PostgreSQL、真打包应用上检验。
>
> **结果：六个真 bug，其中三个会同样发生在 k8s 上。** 外加一个悬了很久的
> spike 有了答案，以及完整无人值守闭环第一次跑通。

---

## 0 · 验证到什么程度

| 环节 | 结果 |
| --- | --- |
| 镜像构建 | ✅ 第一次真正构建（此前从未跑过） |
| 部署（docker compose：server + PostgreSQL） | ✅ 12 个迁移全部应用，14 张表 |
| 服务健康 | ✅ `/readyz` → `{"status":"ready","store":"postgres"}` |
| 罗盘 **Web** e2e | ✅ Cypress 23/23，16 秒 |
| 罗盘 **Electron** 打包 | ✅ `罗盘AI情报系统 Setup 0.1.0.exe` |
| 罗盘 **Electron** e2e | ✅ Playwright `_electron` 4/4，16.9 秒 |
| 两条结果进 MXT | ✅ Web 23/23、Electron 4/4，目录执行率 100%，unmapped 0 |
| **完整无人值守闭环** | ✅ 平台派活 → 执行机认领 → 检出指定 ref → 装依赖 → 构建 → 跑用例 → 传 13 个产物 → 回报，全程无人 |
| Kubernetes 部署 | ✅ 见 [§4](#4-kubernetes跑通了代价是七个部署期缺陷)，代价是七个部署期缺陷 |
| **k8s 上跑完整闭环** | ✅ 构建安装包 → 静默安装 → Electron 冒烟 → 回报，全程无人 |

---

## 1 · Spike 有答案了：`_electron` 可用

[13 §5.2](13-platform-review-and-redesign.md) 把这条列为**唯一有可能推翻整个桌面端方案
的未知数**，[14 §3](14-ci-runners-and-stack.md) 又把它排进第一周：

> `_electron.launch()` 到底能不能拉起打包后的 `.exe`？

**能。** 对 electron-builder 产出的 `win-unpacked/罗盘AI情报系统.exe`：

```
✓ LP-EL-BOOT-001 打包应用能冷启动并拿到主窗口        1.6s
✓ LP-EL-BOOT-002 主进程确认这是打包产物而不是开发态   4.7s
✓ LP-EL-BOOT-003 启动后没有停在空白页                3.9s
✓ LP-EL-BOOT-004 启动过程没有向渲染进程抛未捕获错误   6.0s
```

`app.evaluate()` 在主进程里跑通了（`isPackaged: true`），这正是 Playwright 相对
WebdriverIO 的独有能力。**不需要退到方案 B。**

> macOS 仍然未知。签名 + hardened runtime 的 `.app` 可能拒绝 `--inspect`，
> 那是另一次 spike，需要一台 Mac。

用例写在**测试团队自己的仓库** `luopan-qa-e2e`（[ADR-0007](adr/0007-test-code-ownership.md)），
po-frontend 一行没改。

---

## 2 · 六个真 bug

### ① Dockerfile：`pg` 从 mx-common 里解析不到

**症状**：迁移容器起来即挂。

```
Error [ERR_MODULE_NOT_FOUND]: Cannot find package 'pg'
  imported from /app/mx-common/src/postgres/index.mjs
```

**原因**：`@qpjoy/mx-common` 是 `file:` 依赖，npm 把它装成**软链**指向
`/app/mx-common`。Node 解析那个包自己的 import 时，是从它的**真实位置**向上找：
`/app/mx-common/node_modules` → `/app/node_modules` → `/node_modules`，
**永远不会看 `/app/mx-test-framework/node_modules`**，而 `pg` 恰恰在那里。

**修法**：`ln -s /app/mx-test-framework/node_modules /app/node_modules`，
把已安装的树放到那条向上查找的路径上。

**为什么重要**：这个 bug 在 **k8s 上会一模一样地发生**——迁移 Job 用的是同一个镜像。
而且它**只在运行时暴露**，镜像构建本身是成功的。如果先上服务器，这就是第一个卡点。

### ② compose 的构建上下文写错了

`context: ../..` 从 `deploy/compose/` 算落在 `mx-test-framework/`，
于是 `dockerfile: mx-test-framework/Dockerfile` 解析成
`mx-test-framework/mx-test-framework/Dockerfile`——不存在。

正确是 `../../..`（`electron-dock/`），因为 Dockerfile 要 `COPY mx-common/`。

**这条本机部署路径从来没有人跑通过。**

### ③ 目录比对是按应用做的，不是按套件

**症状**：Electron 那次执行报 `未执行 23` ——它把 web 套件的 23 条用例算了进来。

**原因**：`completeRun` 里 `store.listCases(run.appId)` 取的是**整个应用**的目录，
而一次执行只属于其中一条套件。

**后果**：一个应用只要有第二条套件，`notRun` 这个信号就废了。罗盘有三条。
这条恰恰是平台最看重的判断之一（"零用例不是通过"的同族）——
它悄悄失效比它不存在更糟。

**修法**：按 `run` 的套件过滤。没有归属套件的用例仍然计入——
一条登记了却不挂在任何套件上的用例，不该靠"不指定"从每次统计里隐身。

修复前后可以在执行记录里直接看出来：早两分钟的那条写着 `通过 4/4 未执行 23`，
之后的写着 `通过 4/4`。

---

### ④ 执行机把大文件放系统盘

`~/.mxt` 是主目录，Windows 上通常是 C:。一个应用 1.4 GB，第一次真跑就把 C: 填到 0，
pnpm 报的是 `disk I/O error`——**读起来像包存储损坏，完全看不出是没空间**，
而且磁盘一满 Docker 引擎也会卡死。

已加 `--data-dir` / `MXT_RUNNER_DATA_DIR`。**默认值放主目录对一台工作机是错的。**

### ⑤ `sourceRef` 归一层被丢掉

[14 §2](14-ci-runners-and-stack.md) 把"`source_ref` 声明了但从不写入"列为已修，
但只修了执行机那一半：它确实 `git rev-parse HEAD` 读回了 sha，
**平台的归一层没有处理这个字段，写库时直接丢了**。

于是 `mxt_runs.source_ref` 依旧永远是空的，"上周三那次失败在哪个 commit"
仍然答不出来——而那正是当初要修它的理由。

现在归一层会带上并做校验（不是十六进制的 sha 直接丢弃，
因为一个假的 provenance 比没有更糟），写库时以执行机报的为准
（webhook run 虽然创建时就钉了 sha，但**实际检出才是真相**）。

修好之后的记录：

```
sourceRef : {"ref":"public","gitSha":"48af4908771071e79d2774de11b4fb9257d620f9"}
```

### ⑥ `E2E_ARTIFACTS_DIR` 与 `MXT_ARTIFACTS_DIR` 同名不同义

见 [24 §5.6](24-windows-local-service.md)。平台把两者设成同一个值，
套件写到了 `<runId>/<runId>`，**一次实际通过的执行被判成 `blocked`**。

---

## 3 · 顺带确认的几件事

- **compose 缺 `MXT_INSECURE_COOKIES`**：不加的话 session cookie 带 Secure 标志，
  走 HTTP 传不回来——浏览器能登录，然后立刻显示未登录。已补，连同
  `MXT_PUBLIC_URL` 和 `MXT_SECRET_KEY`。
- **`onboard-luopan.mjs` 原来编了 5 条假目录**：跑真实结果时 19 条用例被判 `unmapped`
  ——那是 drift 检测在报告**脚本自己制造的问题**。已改成从仓库读真实目录
  （frontend 17 条 + agents 6 条 = 23 条，和实际执行数正好对上）。
- **JUnit 通道在真实数据上生效**：Playwright 的 JUnit 输出零适配进了 MXT，
  case ID 靠标题正则关联上（[16 §1](16-multi-stack-platform.md) 的第 2 级）。
- **脱敏偏保守**：`LP-FE-AUTH-003 ... 携带 Bearer Token` 里的 "Token" 被抹成
  `Bearer [REDACTED]`。那不是凭据，只是标题里的词。过度脱敏是安全的方向，
  但报告里会看到。

---

## 4 · Kubernetes：跑通了，代价是七个部署期缺陷

> 2026-09-02。证书问题用 Docker Desktop 的 **Reset Kubernetes Cluster** 解决
> （客户端证书 2026-05-04 过期，集群 CA 本身有效到 2125）。

重置之后 `manage.sh deploy` 连跑五次才成功，**每一次都暴露出恰好一个此前从未被
执行过的部署路径缺陷**。这是本轮最值得记住的一件事：这些代码全都通过了单元测试，
也全都读起来是对的——它们只在真集群上才错。

| # | 症状 | 根因 | 会不会在内网 Linux 上重演 |
| --- | --- | --- | --- |
| ⑦ | `error reading /proc/self/fd/0`，接着 `no objects passed to apply` | `kubectl create secret --from-env-file=/dev/stdin`：kubectl 在 Windows 上是原生程序，打不开 Git Bash 的 `/dev/stdin` | 不会（Linux 上可用），但改法两边都对 |
| ⑧ | 迁移 Job `getaddrinfo EAI_AGAIN mx-test-framework-postgres` | `owns_database()` 判断的变量正是 `resolve_database()` 刚刚设过的，于是自建数据库被静默跳过 | **会**，且症状会指向一个根本不存在的主机名 |
| ⑨ | `mkdir: can't create directory '.../pgdata': Permission denied` | hostPath 卷不套用 `fsGroup`——Kubernetes 只对支持它的卷类型调所有权 | **会**，任何用 hostPath 的地方都会 |
| ⑩ | Pod 一直 `Pending`：`unbound immediate PersistentVolumeClaims` | PV 是 `Retain` 策略：PVC 删掉后 PV 变 `Released` 并**保留旧的 claimRef**，不会自动重新绑定 | **会**，见下方运维提示 |
| ⑪ | 全部检查通过之后才报 `forward_pid: unbound variable`，deploy 退出码非零 | `trap ... RETURN` 触发时 `local` 变量已出作用域，`set -u` 就报错 | **会** |
| ⑫ | 通知链接指向 `http://192.168.65.3:30879`，主机打不开 | 取的是节点 InternalIP。在内网服务器上那就是局域网地址（对的），在 Docker Desktop 上那是 VM 内部地址（错的） | 不会，但**未验证的推导本身是错的做法** |
| ⑬ | `register --server <新地址>` 报 `fetch failed` | `--server` 被接受但忽略，实际去打上一次 `login` 写下的地址 | **会**，而且更隐蔽：换个平台地址时会"注册成功"到旧平台 |

| ⑭ | **`deploy` 报 `verify passed`，但跑的是旧代码** | 镜像永远是 `:latest`，重新构建后 Pod 模板一字未变，`kubectl apply` 正确地什么都不做，`rollout status` 于是对**已经在跑的那批 pod** 报告"成功" | **会**，而且这是最危险的一个 |
| ⑮ | 套件登记错了改不了 | 平台只有创建接口，没有修改接口；onboarding 脚本的"已存在，跳过"因此是个永久决定 | **会** |
| ⑯ | `workingDir: "."` 被拒 | 校验只认子目录。测试团队自有仓库不分子目录，"仓库根"只能靠**省略字段**表达，而调用方无从知道 | **会** |

### ⑭ 值得单独说：绿色的谎报

这是一个部署脚本能犯的最坏的错误——**它安静、它是绿的、而且它让之后每一次代码
改动都看起来没生效**。发现它靠的是一个不起眼的对照：

```
pod 启动于     2026-09-02T07:00:29Z
镜像构建于     2026-09-02T07:15:36Z
```

**pod 比它声称运行的镜像还老 15 分钟。**

改法两步：
1. 把镜像 ID 盖在 Pod 模板的注解上——镜像没变则补丁是空操作、不重启；
   镜像变了则触发真正的滚动更新。
2. 加一条断言：滚动完成后，**正在跑的镜像必须就是刚构建的那个**，否则 `deploy`
   直接失败。没有这条，第 1 步自己哪天悄悄失效，症状还是同一个。

> 顺带：这条注解能在后续 `kubectl apply -k` 中存活，因为它从来不在 apply 的
> 配置里——三方合并只裁剪它自己曾经写过的字段。

---

### ⑩ 的运维提示：`Retain` 的代价

`Retain` 是[有意选的](../deploy/k8s/internal/15-postgres.yaml)——`manage.sh down`
绝不能成为丢掉执行历史的原因。代价是**删 PVC 之后必须手动放行 PV**，否则新 Pod
永远调度不上：

```bash
kubectl patch pv mx-test-framework-postgres-pv -p '{"spec":{"claimRef":null}}'
```

这不是 bug，是这条策略的固有行为。写在这里是因为它**看起来**像 bug：
Pod 卡在 `Pending`，事件里只说 PVC 未绑定，不会告诉你 PV 手上还攥着旧的 claimRef。

### ⑫ 的改法：探测，而不是推导

`resolve_public_url()` 现在按"这个链接能被多少人打开"排序逐个探测候选地址，
取第一个真的应答的；落到 `127.0.0.1` 时会明确警告"只有本机能打开"。

**一个没人能打开的链接比没有链接更糟**——它把一条能用的告警变成一次求助。

### 结果

```
  ok   health endpoint responds          ok   runner registered
  ok   database is reachable             ok   runner claimed the run
  ok   control plane requires a token    ok   compass-compatible E2E_* 变量已注入
  ok   application registered            ok   summary ingested
  ok   suite registered                  ok   run passed
  ok   catalog synced                    ok   未执行的用例被报成 notRun
  ok   task created                      ok   case results are queryable
  ok   task ran on demand                ok   step timeline is queryable
verify passed
```

界面：`http://127.0.0.1:30879`（账号随便填，密码用 `MXT_ADMIN_TOKEN`）。

---

## 4.5 · 平台第一次真跑构建，就替业务仓库找出一个缺陷

`pnpm build:electron:exe` 在执行机上失败：

```
'D:\Program' 不是内部或外部命令，也不是可运行的程序
Error: D:\Program Files
odejs
ode.exe scripts/copy-electron-portable.mjs failed
```

Electron 打包本身**是成功的**（`Build succeeded`）。断在 po-frontend 自己的
`scripts/build-electron-portable.mjs`：

```js
run(process.execPath, ['scripts/copy-electron-portable.mjs'], { ... })
// spawnSync(command, args, { shell: process.platform === 'win32' })
```

`shell: true` 时 Windows 把整条命令交给 `cmd`，而 `process.execPath` 没有加引号。
**只要 Node 装在 `Program Files` 这类带空格的路径下就必然失败**——本机开发者的
Node 恰好装在没有空格的位置，所以从没人碰到过。

这条不该由 MXT 修（[ADR-0007](adr/0007-test-code-ownership.md)：测试平台不进
别人的仓库改代码），应当作为一条缺陷提给罗盘。这里记下来是因为它正是**为什么
要有一台干净的构建机**：本机能过不等于能构建。

演示用的构建套件已改为 `pnpm build:electron:installer`，那条链路完整可用。

---

## 4.6 · 桌面端的两个真实条件：安装包、和进不去

跑通之后又暴露两件只有在真机上才会遇到的事。

### 平台不能把安装包当成应用递给用例

构建套件发布的是 NSIS 安装包——那是用户真正拿到的东西。而
`_electron.launch()` 需要的是应用本身。直接把安装包路径递过去的结果是：
安装向导弹出来等人点，每条用例干等 60 秒，报

```
electron.launch: Timeout 60000ms exceeded
```

**这条报错完全没有指向真实原因。**

改法是执行机按自己的系统把包变成可启动的应用，**装到自己的数据目录里**：

| 系统 | 包 | 做法 |
| --- | --- | --- |
| Windows | NSIS `.exe` | `/S /D=<目录>`（`/D=` 必须放最后且不能加引号） |
| macOS | `.dmg` | `hdiutil attach` → 拷出 `.app` → detach（**未验证，需要一台 Mac**） |
| Linux | `.AppImage` | `chmod +x` 直接用 |
| 其他 | — | 明确报错说不支持，而不是启动一个必然起不来的文件 |

两条刻意的设计：

- **路径一律不写死。** 安装位置来自执行机自己的数据目录（本来就每台机器
  各自配置），可执行文件是**在装完的目录里找出来的**——应用的文件名随项目、
  随版本、随平台都不一样。找到多个或找不到，都直接报出候选清单，
  而不是猜一个然后在后面某处失败。
- **按 sha256 缓存。** 同样的字节不重复安装，第二次起省掉约 30 秒。

> 为什么是"装了再测"而不是"测免安装版"：安装器是桌面发版里最容易坏、
> 又最没人测的一环。测免安装版等于把它永远绕过去。

### 进不去主界面，未必是产品坏了

两种情况必须分开判：

| 现象 | 结论 | 依据 |
| --- | --- | --- |
| 进主界面前要过若干次权限确认 | 正常形态，**等它、点它** | 次数取决于这台机器上一次留下的状态，写死等几秒或点几下在别的机器上就会错 |
| 本机开着 WireGuard 全局通道，应用取配置不通 | **受阻**，不是失败 | 不是产品坏了，是这台机器现在测不了 |

做法：

- 浏览器层面的权限**在主进程 session 上直接放行**，不等弹窗。等弹窗要靠
  "点得够快""窗口在前台"，这两个条件在无人值守时都不成立。
- 应用自己的确认框走轮询点击，有总预算（`LUOPAN_E2E_ENTER_BUDGET_MS`，默认 60 秒）。
- 超预算后看渲染进程报了什么：是网络类错误 → 受阻；否则 → 失败，
  并在失败信息里带上**已经点掉了哪些确认框**，便于判断是不是产品多了一步。

受阻怎么传回平台：Playwright 只会给 0 或 1，它没有"环境不具备"这个概念。
QA 仓库因此有一个自己的执行入口 `scripts/run-electron-e2e.mjs`，
把受阻翻译成**退出码 2**——正是 MXT 的契约。三条路径都实测过：

```
应用不存在              → 退出码 2  ⚠ 受阻（不是失败）
要求联网但探测不通      → 退出码 2  「这通常是本机开着 WireGuard 全局通道」
运行中写下受阻标记      → 退出码 2  （playwright 自己报的是 1 failed）
正常                    → 退出码 0  4 passed
```

---

## 5 · 复现这一轮

```bash
# 1. 罗盘：检出 public 分支（不动 main 的工作树）
git -C <luopan> worktree add ../luopan-e2e public
cd <luopan-e2e>/po-frontend && pnpm install

# 2. Web e2e（自包含：quasar build → 起静态服务 → cypress）
pnpm e2e:local                      # 23/23，约 1 分钟

# 3. Electron 打包
pnpm build:electron:installer       # 约 90 秒

# 4. Electron e2e（测试团队仓库，po-frontend 零改动）
cd <luopan-qa-e2e> && npm install
MXT_APP_PATH="<luopan-e2e>/po-frontend/dist/electron/Packaged/win-unpacked/罗盘AI情报系统.exe" \
  npx playwright test --config playwright.electron.config.mjs

# 5. 部署平台
cd <mx-test-framework> && bash scripts/manage.sh local up
#    界面 http://127.0.0.1:8790，账号随便填，密码 local-admin-change-me

# 6. 接入罗盘（同步真实用例目录）
MXT_BASE_URL=http://127.0.0.1:8790 MXT_ADMIN_TOKEN=local-admin-change-me \
  LUOPAN_CHECKOUT=<luopan-e2e> node scripts/onboard-luopan.mjs
```

### 磁盘

| 项 | 占用 |
| --- | --- |
| luopan worktree + node_modules | 1.6 G |
| Cypress 二进制缓存（两个版本） | 1.5 G |
| Electron 打包产物 | 约 0.5 G |

Cypress 缓存按版本累加且**没人会主动清理**——[14 §2](14-ci-runners-and-stack.md)
里"每个引擎只留 2 个版本"那条规则，对执行机同样适用。

---

## 6 · 还差什么

| 项 | 说明 |
| --- | --- |
| ~~k8s 部署~~ | **已跑通**，见 §4 |
| macOS 的安装包处理 | `.dmg` 那条路写了但没验证过，需要一台 Mac |
| 关掉全局通道后的 Electron | 受阻判定实测过（造标记、造探测失败），但**"关掉 WG 后应用真能进主界面"这件事还没在真机上跑过** |
| ~~执行机自动跑~~ | **已跑通**。`mxt-runner once` 完整走完认领到回报；`watch` 常驻是同一条路径加一个轮询循环 |
| 定时触发 | 任务改成 cron 即可，但需要执行机常驻。本机验证时用的是手动触发 |
| macOS 的 `_electron` spike | 需要一台 Mac |
| 罗盘 Electron 的业务用例 | 现在只有 4 条启动冒烟。登录、隧道状态这些要等桩掉 launcher 出网之后（[13 §5.5](13-platform-review-and-redesign.md)） |
