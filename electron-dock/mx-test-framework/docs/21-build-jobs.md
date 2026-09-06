# 21 · 构建作业

> 五件待办的第四件。[ADR-0006](adr/0006-mxt-absorbs-builds-jenkins-deferred.md) 的结论是
> MXT 吸收"构建"这个动作、Jenkins 暂不启用；`suite.kind` 字段当时就落地了，
> 但**执行语义没做**——build 作业还不会真的产出安装包并登记。这是把它接通。

---

## 1 · 一条继承下来的规则

构建作业不是"零用例的测试作业"。它没有用例、没有目录比对、没有 drift。
但它继承了平台最老的那条规则，换了个形状：

> **零用例不是通过  →  没有产物不是构建成功**

一条构建命令退出码为 0 却什么都没产出，判 `blocked`。
理由和"跑了零个用例不算绿"完全一样：**退出码说成功，实际什么都没发生**。

这不是理论上的谨慎。electron-builder 在配置写错、目标平台不匹配、
签名步骤被跳过时，都可能干净地退出而不产出安装包。
如果那算成功，下游的测试作业就会去测一个不存在的包，
而失败会记在测试头上。

---

## 2 · 为什么和测试作业分开走

如果让 build 走测试那条流水线，会得到：

- `totals: { tests: 0 }` —— 真实但无意义
- 一份目录比对报告，声称**这个应用的每一条用例都未执行**

第二条是有害的：它会污染真正测试用的 suite 的 drift 数字。
所以 `completeRun` 一进来就按 `suite.kind` 分叉，build 走 `ingest/build.mjs`，
记录 `cases: []`、`catalog: {}`。

---

## 3 · 产物怎么找到

suite 上声明 `artifactPath`，是相对 `workingDir` 的 glob：

```json
{ "kind": "build", "workingDir": "po-frontend", "artifactPath": "dist/electron/Packaged/*.exe" }
```

**这样被测仓库一行都不用改。** `dist/electron/Packaged/` 正是 electron-builder
已经在写的地方；要求它把安装包拷进某个平台专属目录，等于又把平台塞回别人的仓库里，
而 [ADR-0007](adr/0007-test-code-ownership.md) 刚把它拿出来。

只支持 `*` 一种通配。完整 glob 实现意味着一个依赖和一片意外行为，
换来的是没人提过的场景。

**匹配到多个文件是错误，不是猜测。** "我们测的是哪个 .exe"必须有唯一答案，
而按字母序取第一个，会在版本号变化后给出不同的答案。

---

## 4 · 校验和由平台算

执行机把产物拷进 `$MXT_ARTIFACTS_DIR/package/`，走正常的产物上传。
**平台对收到的字节自己做 sha256**，不采信执行机报上来的摘要。

理由和 [ADR-0005](adr/0005-federated-identity-and-runner-tokens.md) 不信任 runner
输出是同一条：执行机跑的是被测仓库里的代码，
**它的算术不比它的输出更可信**。

---

## 5 · 谁能下载这个包

安装包由平台自己托管：`GET /runner/v1/runs/<构建 runId>/package`。

鉴权用的是**执行机的 token，不是人的身份**。这一条需要解释：

- 平台其他的产物下载路由走 `identity.resolve`，要求一个人的登录态。
  执行机没有人的身份，所以那条路走不通。
- run token 也不行——文件属于**另一次** run（构建那次），
  而测试那次的 run token 只对自己有效。
- 用执行机 token 是合理的：**一台注册过的执行机，本来就被信任去在真实硬件上
  执行测试代码**。让它下载它即将启动的那个应用，权限严格更小。

另外两点：

- 包**在建 run 时快照进 run**，不在认领时解析（[17 §2](17-one-console.md)）。
  桌面 run 可能排队几小时，期间发布了新包，这次 run 也必须仍是它被创建时那个包的 run。
- 将来接了 Release Center，`package.url` 直接换成它给的地址，
  平台这边不用改——`POST /apps/:app/packages` 一直就是收 URL 的。

---

## 6 · 完整链路

```
MXT 建 build run（kind: build）
        ↓ 派给能力匹配的 Windows 执行机
执行机  fetch 指定 ref → cd workingDir → 装依赖
        → pnpm build:electron:exe
        → 按 artifactPath 找到唯一的 .exe，拷进 package/
        → 上传产物 → 回报 exitCode
        ↓
MXT     对收到的字节算 sha256 → 登记为该应用的 latestPackage
        ↓
MXT 建 test run（kind: test, surface: electron）
        → 建 run 时把当前 latestPackage 快照进这次 run
        ↓
执行机  认领 → 下载安装包 → 校验 sha256 → 设 MXT_APP_PATH → 跑 Playwright
```

实测这条链已经跑通（内存态 + 真实 HTTP），包括校验和一致、
测试 run 认领时拿到正确的包。

---

## 7 · 罗盘的三条 suite

`onboard-luopan.mjs` 现在登记三条，它们共用一台 Windows 机器但是三个不同的作业：

| suite | kind | 跑在哪 | 做什么 |
| --- | --- | --- | --- |
| `web-mock` | test | 服务端 k8s Job | Cypress，`pnpm e2e:local` 自建目标 |
| `win-installer` | **build** | 本地执行机（Windows） | `pnpm build:electron:exe` → `.exe` |
| `electron-smoke` | test | 本地执行机（Windows） | Playwright `_electron`，测上面那个 `.exe` |

`win-installer` 的 `engine` 填 `generic`：**构建不驱动任何东西，它需要的是工具链
不是浏览器**。engine 只决定服务端运行时的默认镜像，这条是本地作业，所以无所谓。

---

## 8 · 需要斟酌的点

**① 构建和测试之间没有自动串联。** 建了 `win-installer` 的 run 之后，
不会自动触发 `electron-smoke`。这是**故意的**——串联就是流水线，
而多阶段流水线正是 [ADR-0006](adr/0006-mxt-absorbs-builds-jenkins-deferred.md)
写死的"该启用 Jenkins"的触发条件之一。
现在的做法：两条 cron，构建排在测试前面，中间留足时间。

**② 一次只保留一个 latestPackage。** 发布新包会覆盖旧的指针，
但旧包的字节还在它那次构建 run 的产物目录里，直到保留期到期。
"回滚到上一个版本再测一次"目前要手工指定，没有界面。

**③ 产物保留期会连带影响可测性。** 安装包存在构建 run 的产物目录下，
默认 30 天清理。清掉之后 `latestPackage.url` 会 404——
run 记录还在，但包没了。如果需要长期保留发布节点的包，
按 [14 §2](14-ci-runners-and-stack.md) 备份到 OSS 并把 URL 换成 OSS 地址。

**④ Windows 执行机上的构建缓存不受平台管理。** `node_modules`、
electron 的运行时缓存都在 `~/.mxt/checkouts/<app>` 里增量复用。
好处是构建快，代价是那台机器上的磁盘要人自己盯。

---

## 9 · 还没做的

| 项 | 说明 |
| --- | --- |
| 服务端容器里的 build 作业 | 现在只有本地执行机路径接了产物收集。Linux 上构建（比如出 Docker 镜像）还没接 |
| 界面上触发构建 | 和测试任务一样走任务列表，但没有"构建"这个视觉区分 |
| 多产物 | 一次构建同时出 `.exe` 和 `.msi` 会被判成"无法确定"。真需要时改成产物列表 |
| 与 Release Center 对接 | `POST /apps/:app/packages` 已经能收外部 URL，但没有实际接过 |
