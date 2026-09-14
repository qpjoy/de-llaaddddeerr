# Compass Electron Playwright test pack

这是 Compass / Luopan 打包桌面应用的外部 QA test-pack，Catalog Suite slug 固定为
`compass-electron-smoke`。它在 MX Autotest 启动阶段暂存于本仓库；进入独立团队维护前，
应移动到专用 QA Git 仓库，并在 mx-auto-server 中冻结准确 commit。

本目录仍是待执行实现，不表示 Compass Electron 已通过验收。

## 两条执行轨

bootstrap smoke 是默认轨，只验证打包应用能够穿过 `startup-loading.html`，进入真实登录页
或已认证主页，并记录 renderer/main-process 诊断：

```sh
pnpm install --frozen-lockfile
COMPASS_E2E_NETWORK_MODE=dedicated-runner \
MX_AUTO_APP_PATH=/absolute/path/to/the/Compass/executable \
pnpm test
```

`MX_AUTO_APP_PATH` 必须是可执行文件，不是 `.dmg`、NSIS installer 或 macOS `.app` 目录。
平台 Desktop Runner 负责校验安装包 sha256、安装/解包，再把可执行路径传给 pack。V0 Runner
仍可使用兼容名 `MXT_APP_PATH` 与 `MXT_ARTIFACTS_DIR`。

formal auth 是独立轨，不会混入默认 smoke，也没有 `skip` 后仍让 Run 变绿的路径：

```sh
COMPASS_E2E_NETWORK_MODE=dedicated-runner \
COMPASS_AUTH_CAPTCHA_MODE=reviewed-test-hook \
COMPASS_E2E_ACCOUNT=... \
COMPASS_E2E_PASSWORD=... \
MX_AUTO_APP_PATH=/absolute/path/to/the/Compass/executable \
pnpm test:auth
```

平台使用同一个 `compass-electron-smoke` Suite 和 `pnpm test` 命令时，`profile=mock` 映射为
bootstrap，V0 合法值 `profile=real` 映射为 formal auth；命令行 `--lane` 或
`MX_AUTO_ELECTRON_LANE` 只用于 adapter/本地显式覆盖。这样可以建立两个独立 Task/Run，且无需
临时改写 Suite command。

其中：

- 账号必须是权限受限、数据隔离的专用测试账号；
- `reviewed-test-hook` 只表示本次使用的是另行审核过的非生产 acceptance build，不会把任何
  验证码开关传给目标应用；
- 若真实页面仍显示 production captcha，formal auth 写出 blocked preflight 并返回 exit 2；
- 未提供账号、密码、隔离网络确认或验证码合同，同样在启动目标应用前 blocked；
- production build 不得为了自动化关闭验证码或系统权限边界。

不提供绕过 wrapper 的 direct script；Playwright config 会校验 wrapper guard。测试开发也使用
`pnpm test:bootstrap` / `pnpm test:auth`，确保 network/preflight、环境清洗和 auth 隐私保护不会
因诊断命令被跳过。

## 网络与凭据边界

Compass 启动会初始化 Launcher、代理或隧道。运行前必须显式选择：

- `COMPASS_E2E_NETWORK_MODE=dedicated-runner`：专用测试机，MX-H2I 与真实用户会话不在该机运行；
- `COMPASS_E2E_NETWORK_MODE=reviewed-isolated-build`：经评审、可证明不修改真实数据面的隔离构建。

普通开发机未满足任一条件时，wrapper 只产出基础 sidecar 与 `preflight.json`，不会启动 Compass。

平台提供的 artifact 根目录必须是本 Run 独占的空目录；发现 **任何** 既有文件或目录（包括
测试包不认识的名字）都会在启动前 blocked，避免旧证据或秘密被旧 Runner 遍历上传。本地未
显式配置根目录时，pack 只清理自己管理的 `artifacts/` 默认目录。

只有 formal auth 的 Playwright controller 可以读取专用凭据并填表；bootstrap controller 会主动
剔除 Suite 级 secretRefs 下发的账号、密码以及 token/secret 环境。Electron child 使用严格系统变量
allowlist，且 HOME、USERPROFILE、APPDATA、LOCALAPPDATA、TEMP 和 XDG 数据目录都重定向到
本次临时 profile。账号、密码、Git token、平台 token、代理凭据、`NODE_OPTIONS` 及其他调用方
环境变量不会传给被测进程。临时 profile 在应用关闭后删除。

## Readiness 与结论

取得第一个 BrowserWindow 不等于可用。pack 会等待以下真实 renderer sentinel：

- 登录页同时出现 `#account`、`#password`、`.login-button`；或
- 已认证页面出现 `.ai-home-page` 或 `.arco-main-layout`。

`startup-loading.html` 的 `.panel.failed`、窗口提前关闭、90 秒内没有 renderer、Electron 无法
启动、验证码前置条件未满足，都会写 `preflight.json`；wrapper 即使收到 Playwright 的普通
失败码，也最终返回 exit 2。Playwright 在任何 Case 记录证据前退出同样归为 blocked；真实
renderer 内的产品断言失败才返回 exit 1。

V0 Runner 依靠 exit 2 把这类结果归为 blocked；`preflight.json` 保存具体 stage/reason。直接
绕过 wrapper 时旧 Runner 无法可靠区分 blocked 与 failed，因此不得把 direct run 宣称为验收。

## 证据

证据根目录使用 `MX_AUTO_ARTIFACTS_DIR`（V0 兼容 `MXT_ARTIFACTS_DIR`）：

```text
junit/compass-electron.xml
mx-autotest.sidecar.json
preflight.json                 # 仅 blocked 时
report/
videos/CPS-EL-BOOT-001.webm
screenshots/
traces/
logs/electron-metadata.json
logs/<caseId>-diagnostics.json
```

视频使用 Case ID 作为文件名，并在 sidecar 中逐 Case 绑定，避免旧报告把唯一视频错误挂到所有
用例。sidecar 记录 source/toolchain 可确认信息、coverageMode、相对路径、大小和 sha256；Catalog
指纹使用 `mx-catalog-canonical-v1`，排除 `catalogFile` 等部署位置字段，并稳定排序 Case 与集合；若
runner 没提供应用 artifact digest，或 test-pack 不在 clean Git checkout，它会写 warning，绝不
伪造 digest。

runtime metadata 不包含本机绝对 appPath，只记录应用版本、OS、arch、Electron、Chromium、
Electron Node 与 Playwright 版本。V0 尚不执行 sidecar 的 restricted ACL，因此 auth 轨不生成
HTML report、页面 snapshot、截图、trace、视频或 renderer/main-process 原文诊断；只保留 JUnit、
runtime metadata 与 Case sidecar。Playwright 的自动失败页面 snapshot 也由固定版本保护开关关闭，
每次结束后删除 Playwright context 目录并扫描 JUnit 中的精确凭据变体；命中时删除该结果并
blocked。若升级后无法验证保护开关或扫描/清理失败，auth 同样 blocked。

Playwright Electron API 仍是实验性能力。OS 原生 Open/Save、Keychain、UAC、安装器、系统权限
弹窗和真实 VPN 行为不计为自动覆盖；Catalog/sidecar 将其标为 manual-witness 或 unsupported。
