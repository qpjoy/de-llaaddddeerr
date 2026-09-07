# 05 · 工具链与产物

> 状态：提议。具体版本必须在实现时从官方 release 与兼容矩阵确认，本文不把示例版本写成“最新”。

## 原则

MX Autotest 提供一致的测试体验，但不重新实现 Cypress、Playwright、pytest 或 k6。

平台负责：

- 选择和锁定工具；
- 安全获取与缓存；
- 准备源码和运行输入；
- 调用 adapter；
- 收取 JUnit、sidecar 和原生证据；
- 归一状态、保留、脱敏与分享。

工具负责：

- 执行断言；
- 生成框架原生报告；
- 提供 screenshot、trace、video、coverage 或 performance 数据；
- 按其稳定 API 工作。

## 工具接入层次

| 层次 | 要求 | 平台体验 |
| --- | --- | --- |
| Generic | 可执行命令 + JUnit XML | 用例级结果、历史、目录 drift、基础 artifacts |
| Managed adapter | Generic + 官方版本 manifest + 参数映射 | 自动 preflight、错误分类、模板与合理默认值 |
| Rich adapter | Managed + sidecar + 原生证据索引 | 步骤、trace、视频时间线、框架诊断 |

首批：

| Adapter | 角色 | 重点产物 |
| --- | --- | --- |
| Cypress Web | Luopan / Compass Web 存量与快速反馈 | JUnit、HTML、video、screenshot |
| Playwright Electron | 打包 Electron 技术验证 | JUnit、HTML、trace、video、console |
| Playwright Web | 后续新增 Web 用例的候选 | JUnit、HTML、trace、video |
| pytest | Python 项目和 API / 数据测试的接纳能力 | JUnit、日志、可选 coverage |
| k6 | 后续性能与容量场景 | JUnit / summary、指标文件 |
| generic | 未内置工具的最低接入 | JUnit 与用户声明 artifacts |

平台导航按 Project / risk / Suite 组织，不按 adapter 划分成六个互不相干的产品。

## 获取策略比较

### 每次从官方临时下载

优点是安装包小、版本新；缺点是：

- 每次 Run 都受公网、registry 和 CDN 抖动影响；
- 下载量大；
- 结果难复现；
- 上游替换或下架会让历史任务失效。

因此只适合作为首次填充缓存的来源，不是每次运行的热路径。

### 把所有工具和浏览器打进 Electron

优点是离线即用；缺点是：

- Electron 安装包体积和更新流量快速膨胀；
- Cypress、Playwright 浏览器、Python、k6 各自更新节奏不同；
- 一次小 UI 发布也可能重新分发数 GB 工具；
- 签名、许可、漏洞响应和跨平台构建复杂。

不采用。

### 从 mx-auto-server 分发定制大包

优点是内网可控；缺点是 server 变成大流量文件站和供应链责任方。若所有 Desktop Runner 都从 server 下载完整浏览器，会与低流量目标冲突。

只作为受控镜像和离线兜底，不作为唯一来源。

### 推荐：官方固定版本 + manifest + 内容寻址缓存

1. 管理员批准一个 Toolchain Manifest；
2. manifest 记录官方 URL、版本、OS、arch、sha256、签名信息和兼容范围；
3. Desktop Runner 首次使用时直接从官方来源下载；
4. 下载到临时文件，验证 digest / signature 后原子移动到缓存；
5. 后续 Run 按 digest 命中，不再下载；
6. 内网无法访问官方时，可配置 mx-auto-server 或对象存储镜像，但内容 digest 必须与批准 manifest 一致；
7. K8s runner 使用固定 digest 的官方或受控预构建镜像，不在每个 Job 内 npm install 浏览器。

正式决策见 [ADR-0004](adr/0004-pinned-toolchains-independent-server-no-jenkins.md)。

## Toolchain Manifest

建议字段：

    schemaVersion: 1
    id: playwright-electron-node
    version: x.y.z
    platform: darwin
    arch: arm64
    source:
      kind: official
      url: https://approved-official-source/...
      sha256: ...
      signature: optional-reference
    components:
      - name: node
        version: ...
        sha256: ...
      - name: playwright
        version: ...
        sha256: ...
      - name: chromium
        revision: ...
        sha256: ...
    compatible:
      electron: documented-range
    approvedAt: ...
    approvedBy: ...

版本必须写具体值，不允许 latest、stable、current 等浮动标签。批准新版本会创建新 manifest，不覆盖旧版本；历史 Run 仍可解析旧 digest。

## 内容寻址缓存

建议缓存键：

    sha256/<digest>/
      manifest.json
      payload/
      verified.ok
      last-used.json

别名索引只用于显示：

    tools/<name>/<version>/<os>/<arch> → sha256/<digest>

规则：

- 只有 digest 验证通过的 payload 才能标 verified；
- 并发下载同一 digest 使用文件锁，其他 Run 等待或复用；
- 下载失败保留诊断但删除不完整 payload；
- LRU 清理只删除没有活跃租约的 digest；
- Run 开始后锁定其 digest，清理器不得删除；
- 缓存水位分 soft / hard limit；
- 管理员可预热指定工具链；
- runner 能力上报只公布 digest 与状态，不上传本机绝对路径。

对于 Node / Python 项目依赖，优先使用 lockfile 与包管理器共享 store；工作目录的 node_modules / virtualenv 不跨不可信项目直接复用。缓存依赖包不等于跳过 lockfile 验证。

## K8s runner 镜像

Web、API 和 load 的 server runner 建议使用：

- 固定 image digest；
- 已包含浏览器和 adapter 的基础镜像；
- 项目依赖通过预构建项目测试镜像，或使用 lockfile + 内网包缓存准备；
- 不允许 pnpm install 失败后悄悄回退 npm install；
- 不吞掉依赖安装失败；
- 运行前记录 image、lockfile 和 adapter digest。

规模小时，平台可以直接创建受控 K8s Job。只有需要跨阶段 fan-out/fan-in、审批或复杂制品晋升时，才与成熟 CI / workflow engine 集成。

## Cypress Web 双轨

### evidence-fast

用途：定时冒烟、开发反馈、缺陷定位。

- 无人为停顿和展示横幅；
- 运行完整断言；
- 生成 JUnit 与 HTML 报告；
- 失败时保留 screenshot 和相关 video；
- 首轮验收必须保留一份完整快速执行视频，以证明报告到视频链路；
- 长期策略可让 passed 视频短期保留或只对关键 Suite 录像；
- 不做实时视频上传。

### review-video

用途：人工走查、项目评审、负责人查看、对外演示素材。

- 只能人工或受控审批触发，默认不进入高频 cron；
- 尽量复用 evidence-fast 的同一份 spec 和 step；
- 只运行 Catalog 中适合展示的稳定子集；
- 可加入可读步骤标题、焦点和停留时间；
- 形成一份连续、完整、可播放的视频；
- 内部原件与脱敏分享副本分开保留。

双轨是两种执行意图，不是两套长期业务用例。若同一 caseId 在两个轨的实现开始分叉，Catalog review 应提示维护风险。

## Playwright Electron

建议采用 Node.js Playwright Electron 能力做第一轮 spike，原因是它能控制 Electron 应用和 renderer，并产出 Trace Viewer 所需证据。

工具链必须同时固定：

- Node；
- Playwright；
- Playwright 版本；
- 被测 Electron 自带的 Electron / Chromium 版本；本轨不下载独立 browser，因而没有可记录的 Playwright browser revision；
- OS 与 arch；
- 打包制品 digest。

首轮不能假设任意 Electron 版本都兼容。preflight 应：

1. 校验 executable 可运行；
2. 读取或记录 Electron 版本；
3. 尝试启动并取得第一个窗口；
4. 验证 trace、screenshot 和 JUnit reporter；
5. 失败时在创建正式 Run 前给出兼容性诊断。

### 原生对话框边界

Playwright 的 DOM FileChooser 不等于 OS 原生 Open / Save 对话框。系统权限提示、Keychain、UAC、安装器、自动更新、托盘等也可能位于 Playwright 控制范围之外。

每条 Electron Case 在 Catalog 中标注：

| coverageMode | 含义 |
| --- | --- |
| automated-renderer | Playwright 稳定控制 renderer |
| automated-main | 通过受控接口检查 main process |
| platform-driver | 需要平台专用 UI driver |
| manual-witness | 人工见证并上传证据 |
| unsupported | 当前不能可靠验证 |

报告不得把 manual 或 unsupported 算成自动化通过。

## Artifact 布局（目标态）

建议统一布局：

    runs/<runId>/
      manifest.json
      mx-autotest.sidecar.json
      preflight.json            # 仅 blocked preflight 时
      junit/
        results.xml
      report/
        index.html
      traces/
      videos/
      screenshots/
      logs/
      metrics/

sidecar 固定在 Run 根目录，与 [02 · 领域与执行合同](02-domain-contracts.md) 一致。不得同时支持 `sidecar/` 子目录和根目录两种写法；否则 adapter、上传器和离线验收包会各自找到不同文件。`preflight.json` 只描述 blocked 前置条件，不替代 JUnit 或 sidecar。

Electron 视频和 trace 应使用 Case ID 稳定命名，例如 `videos/CPS-EL-BOOT-001.webm`、`traces/CPS-EL-BOOT-001.zip`，并由 sidecar 的 Case artifact 显式关联。不得用“Run 中只有一个视频”推断它属于所有 Case。

sidecar 只记录能够验证的 provenance：测试源码处于 clean Git checkout 时记录 commit；runner 提供已校验安装包 sha256 时记录 artifactDigest；工具 lockfile 可以记录内容 digest。Catalog 使用版本化 `mx-catalog-canonical-v1` 语义 projection，排除 `catalogFile` 等部署位置元数据，使 server 同步副本可与 QA 原件比对。信息缺失时写 warning 或省略字段，不能用 branch HEAD、文件名、版本号或可执行路径伪造 digest。

Electron runtime metadata 至少记录应用版本、OS、arch、Electron、Chromium、Electron Node 与 controller Playwright 版本。绝对 appPath、用户目录与 token 不进入 metadata。`sensitivity=restricted` 只是数据标签，不等于 ACL；V0 尚未按它控制报告、下载与分享，所以 Compass auth 轨暂不生成页面 snapshot、HTML、截图、trace、视频或 renderer/main-process 原文诊断。只有后端完成授权下载、分享脱敏和审计后，才能恢复这些敏感证据。

manifest.json 对每个文件记录：

- 相对路径；
- role；
- MIME；
- bytes；
- sha256；
- createdAt；
- caseId / shard；
- sensitivity：internal、shareable-candidate、restricted；
- retention class；
- adapter producer。

V0 尚未达到这份全量 manifest 合同：当前 Compass Electron pack 只生成 JUnit、根目录
`mx-autotest.sidecar.json` / `preflight.json`，以及 sidecar 中逐 Case 的 role/path/bytes/sha256/
sensitivity；Playwright HTML、JUnit 和普通日志仍只由旧 runner 遍历上传，没有 MIME、retention、
producer 的不可变清单。因此这部分是后续 Gate，不得把“文件已上传”宣传为 manifest、ACL 或
内容寻址存储已经完成。

数据库只存索引与 digest，不存大文件字节。路径不得由 runner 任意转成外部 URL。

## 上传与去重

- 小文件可单请求上传；
- 大视频、trace 和安装包使用分片、断点续传与每块校验；
- 上传先提交 manifest 草稿，server 返回缺失 digest / chunk；
- 已存在相同 digest 时只建立 Run 引用；
- 完成后 server 验证总大小与 sha256，再原子发布；
- 失败上传保留短期 resumable session，不进入报告；
- 本地 runner 不因网络中断重新传整个视频；
- 同一视频只保留一份对象，可被内部报告与脱敏派生记录分别引用。

首版若尚未实现分片上传，必须设置明确单文件上限并在 UI 预估流量；不能静默传输数 GB 文件。

## 保留策略

建议按价值而不是扩展名：

| 等级 | 典型内容 | 建议 |
| --- | --- | --- |
| diagnostic-short | passed 日志、快速轨普通视频 | 7–14 天 |
| failure-standard | 失败 screenshot、trace、video、JUnit | 30–90 天 |
| baseline-long | 发布候选、里程碑、人工评审视频 | 180 天或按项目 |
| audit | Run 元数据、JUnit 摘要、digest、审计 | 长期，体积小 |
| temporary | 下载临时文件、分片 | 24 小时内回收 |

删除 artifact 不删除 Run 和 CaseResult。报告显示“证据已按策略过期”，而不是返回难以解释的 404。

## 报告组成

平台报告负责导航和归一，不重写成熟 Trace Viewer 或 Cypress reporter。

建议结构：

1. 结论和风险摘要；
2. source / toolchain / runner 指纹；
3. Catalog completion、pass、unmapped、notRun、duplicate；
4. Case 列表与首次失败；
5. 引擎原生报告入口；
6. trace、video、screenshot 和 log；
7. blocked / flaky / retry 说明；
8. 与上一 Run 的变化。

报告必须标明哪些数据来自 JUnit，哪些来自 sidecar 或原生工具，避免把缺失字段伪装为零。

## 分享与脱敏

内部报告默认需要项目权限。生成分享副本时：

- 移除内网 URL、IP、主机名、runner 名称、源码绝对路径和 stack；
- 移除 query、cookie、authorization、password、token、secret；
- 保留经过批准的 Case 标题、步骤、截图、视频和结论；
- 生成独立不可变副本、有效期和撤销记录；
- 展示产品品牌和验证范围；
- 明确“未覆盖”和“实验性”项目。

视频与截图的像素内容无法仅靠文本正则可靠脱敏。对外证据只能使用专用测试账号、合成数据和人工检查，不得录制真实客户数据。

## 供应链与许可

每个 managed adapter 上线前检查：

- 官方下载域和发布签名；
- 开源许可证、浏览器再分发限制；
- CVE 与支持周期；
- SBOM；
- 镜像和 npm / PyPI 依赖摘要；
- 平台支持矩阵；
- 回滚到上一批准 manifest 的能力。

“使用最新开源包”应解释为 **定期评估并批准新的固定版本**，不是让每次运行自动跟随 latest。
