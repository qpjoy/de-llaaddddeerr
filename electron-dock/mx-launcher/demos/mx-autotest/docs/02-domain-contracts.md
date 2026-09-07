# 02 · 领域与契约

> 状态：提议。对象名称和交换格式在实现前应形成 JSON Schema 与 API contract test；本文不是已发布 API。

## 设计目标

领域模型必须让平台回答五个问题：

1. 应该验证什么；
2. 本次实际执行了什么；
3. 用什么源码、配置、工具和机器执行；
4. 结论为何是 passed、failed 或 blocked；
5. 哪些证据足以让别人复现和判断风险。

模型绑定的是这些问题，不绑定 Cypress、Playwright、pytest 或 k6。

## 核心对象

    Project 1 ── n Catalog revisions
       │
       ├── n Suites ── n Tasks ── n Runs
       │                  │
       │                  └── schedule / trigger / policy
       │
       └── n source surfaces: web / electron / api / data / network

    Run ── source refs + toolchain digest + runner fingerprint
       ├── JUnit testcase results
       ├── optional rich sidecar
       └── artifacts: report / trace / video / screenshot / log

### Project

一个被评估的产品或系统，不等于一个 Git 仓库。

建议字段：

| 字段 | 含义 |
| --- | --- |
| id / slug / name | 稳定身份与展示名 |
| surfaces | web、electron、api、data、network 等 |
| applicationSource | 被测源码或制品来源，可为空 |
| defaultRiskPolicy | P0/P1、保留、通知和并发默认值 |
| owners | 产品、测试和技术责任人 |
| enabled | 是否允许新建任务 |

一个 Project 可以同时有 Luopan Web 和 Compass Electron 两个 surface，也可以引用不同被测制品。

### Catalog

Catalog 是“应该被验证的测试点”的版本化清单，不是本次执行结果。

每条 Case 至少包含：

| 字段 | 含义 |
| --- | --- |
| id | Project 内永久唯一的 Case ID，发布后不可复用 |
| title | 人可以理解的测试意图 |
| surface | Catalog 根级 web / electron；api、data、network 是后续扩展 |
| priority | P0 / P1 / P2 / unprioritized |
| tags | smoke、regression、security 等 |
| requirementRef | 当前单值需求或风险引用；多值关系是后续扩展 |
| spec | 可选的文件与测试定位 |
| coverageMode | automated-renderer / automated-browser / automated-api / automated-cli / manual-witness / unsupported / planned |
| automationState | implemented / planned / blocked-prerequisite / manual-only / unsupported |
| prerequisites | 可审计的执行前置条件 |
| retired | 布尔软退役标记，不属于 automationState |

Catalog revision 必须由内容 digest 和源码 commit 标识。删除 Case 使用 `retired: true`，不物理复用
Case ID，否则历史 Run 会失去解释。`owner`、多 requirement 关联等治理字段留到正式内核扩展，V0
不得写入当前 `additionalProperties: false` 的 schema。

### Suite

Suite 是一个可复用的执行意图，把 Catalog 子集、执行表面、adapter 和策略组合起来。

| 字段 | 含义 |
| --- | --- |
| projectId / slug / name | 所属项目和稳定身份 |
| caseSelector | caseId、tag、priority 或 spec 的可审计选择器 |
| surface | 目标表面 |
| adapter | cypress、playwright-electron、pytest、k6、generic 等 |
| testSource | 测试源码仓库、工作目录和默认 ref |
| entrypoint | argv 数组或受控具名入口，不经过隐式 shell 拼接 |
| requiredCapabilities | os、arch、display、browser、network zone 等 |
| resultContract | junit-baseline，可附 rich sidecar |
| artifactPolicy | 需要保留哪些证据、多久、何时录像 |
| retryPolicy | 框架内用例重试与基础设施重试分别配置 |

Suite 不保存某一次实际使用的 commit。Run 创建时解析并冻结 source ref。

### Task

Task 是用户保存的“何时、以什么参数运行哪个 Suite”。

| 字段 | 含义 |
| --- | --- |
| suiteId | 被执行的套件 |
| name / owner | 可理解名称与责任人 |
| trigger | manual / once / cron / webhook / api |
| schedule / timezone | 触发配置 |
| target | 被测 URL、制品引用或环境引用 |
| profile | mock、integration、real 等；`real` 只表示受控验收环境，不允许隐含真实客户数据 |
| track | evidence-fast、review-video 或其他受控策略 |
| sourceSelector | branch、tag、commit 或 artifact digest |
| enabled | 是否接受新触发 |
| concurrencyPolicy | allow / forbid / replace |
| notificationPolicy | 谁在何种结论下被通知 |

Task 可以编辑；每次触发产生的 Run 不可变。编辑 Task 不得改变历史 Run。

### Run

Run 是一次不可变执行事实。创建时必须冻结：

- Project、Catalog revision、Suite revision、Task revision；
- 被测源码 commit / 制品 digest；
- 测试源码 commit；
- adapter 版本；
- 工具与浏览器版本、镜像 digest 或本地缓存 digest；
- profile、track、target 的脱敏表示；
- runner id、OS、arch 和关键能力；
- 创建人、触发原因和时间。

状态机建议：

    queued
      ├── awaiting-runner
      └── preparing
            → running
            → collecting
            → passed | failed | blocked | cancelled | expired

含义：

| 状态 | 含义 |
| --- | --- |
| passed | 有效报告中至少执行一个测试，且没有最终失败 |
| failed | 测试断言或被测行为失败 |
| blocked | 配置、依赖、浏览器、网络、报告损坏、零用例等使结论无效 |
| cancelled | 用户或策略明确取消 |
| expired | 在认领窗口内没有匹配 runner，不计产品失败 |

flaky 不是隐藏失败的绿色状态。建议 Run 仍为 passed 或 failed，同时记录 stability = flaky 和 flakyCaseCount；单个 Case 可标 flaky。界面和通知必须显式展示。

### Runner

Runner 是一个执行能力实例：

- server runner：K8s Job，适合 Web、API、pytest、k6 等无头任务；
- desktop runner：Windows / macOS / Linux 用户机器，适合 Electron、原生 UI、特定网络或硬件。

Runner 定期上报：

- os / arch / hostname 的脱敏标识；
- engines、surface、display、network zone；
- 并发容量；
- 已缓存工具链的版本与 digest；
- 当前租约、lastSeenAt 和健康状态。

## Runner 输入合同

adapter 应得到结构化输入，不从 UI 文本推断配置。建议最小环境合同：

| 变量 | 责任 |
| --- | --- |
| MX_AUTO_RUN_ID | 当前 run 的稳定 ID |
| MX_AUTO_PROJECT | Project slug |
| MX_AUTO_SUITE | Suite slug |
| MX_AUTO_TRACK | evidence-fast / review-video |
| MX_AUTO_PROFILE | mock / integration / real（V0 目前仅接受 mock / real） |
| MX_AUTO_TARGET_URL | Web / API 目标，无凭据和 query |
| MX_AUTO_APP_PATH | Electron 被测制品路径 |
| MX_AUTO_APP_SHA256 | runner 已校验的 Electron 交付制品 digest；未知则省略，不能推测 |
| MX_AUTO_SOURCE_DIR | 已冻结并检出的测试源码目录 |
| MX_AUTO_ARTIFACTS_DIR | 唯一允许写入的证据目录 |
| MX_AUTO_CASE_FILTER | 平台已解析的 case / spec 选择 |
| MX_AUTO_SHARD_INDEX / TOTAL | 可选分片信息 |
| MX_AUTO_CALLBACK_URL | 可选事件回传地址 |
| MX_AUTO_RUN_TOKEN | 当前 run 作用域短期 token |

adapter 可增加自身参数，例如 Compass Electron 的 `MX_AUTO_ELECTRON_LANE=bootstrap/auth`，但必须由结构化 Task/Profile 映射生成，不能让测试代码从任意 UI 文本猜测。V0 `MXT_*` 只允许在 adapter 边界兼容，test-pack 内部应优先消费 `MX_AUTO_*`。

密钥以 MX_AUTO_SECRET_ 前缀注入目标进程环境，或使用 adapter 明确支持的短期文件挂载。不得出现在命令行、Git URL、任务 JSON、日志或产物清单。

为兼容 Luopan / Compass 存量脚本，adapter 可以把这些变量翻译成 E2E_ 或框架变量；兼容逻辑属于 adapter，不属于 Project 领域模型。

## 最低结果合同：JUnit XML

任何工具要成为“一等可接入工具”，最低只需：

1. 在 MX_AUTO_ARTIFACTS_DIR/junit/ 下写出一个或多个有效 JUnit XML；
2. 返回明确的进程退出码；
3. 不把密钥写入报告；
4. 允许平台关联源码和工具链指纹。

JUnit 是交换底线，因为 Cypress、Playwright、pytest、WebdriverIO、JUnit / TestNG 等均能直接或通过成熟 reporter 生成。平台先解析成统一 CaseResult，再执行脱敏、目录比对和入库；每种 adapter 不应各写一条数据库路径。

新用例推荐在 testcase properties 中提供：

    <property name="mx.caseId" value="CPS-WEB-AUTH-001" />
    <property name="caseId" value="CPS-WEB-AUTH-001" />
    <property name="mx.requirementRef" value="COMPASS-142" />

`mx.caseId` 是正式命名；第二个 `caseId` 是 V0 `mx-test-framework` JUnit parser 的过渡兼容字段。Managed adapter 在旧 parser 退役前同时生成两者，且必须验证值相同；不能要求每个业务测试手写两份。若 reporter 无法写 property，title / classname 中的唯一 Case ID 仍是 V0 fallback。

存量兼容顺序：

1. mx.caseId property；
2. 框架原生 annotation 经 sidecar 映射；
3. title / classname 中唯一合法 Case ID；
4. 合成 unmapped 标识，保留结果但进入 drift。

JUnit 本身表达不了完整步骤、单条用例对应的视频片段、网络事件和业务标签，因此它是底线，不是能力上限。

## 可选增强合同：rich sidecar

建议约定 MX_AUTO_ARTIFACTS_DIR/mx-autotest.sidecar.json，schemaVersion 从 1 开始。它只补充 JUnit，不能把 JUnit 的失败改成通过。

建议结构（`<computed>` 仅表示由 runner 实际计算，不能作为字面值写入产物）：

    {
      "schemaVersion": 1,
      "runId": "run_...",
      "startedAt": "2026-01-01T00:00:00.000Z",
      "suite": "compass-electron-smoke",
      "lane": "bootstrap",
      "engine": {
        "name": "playwright-electron",
        "version": "x.y.z",
        "nodeVersion": "v22.x",
        "platform": "win32",
        "arch": "x64",
        "lockDigest": "sha256:<computed>"
      },
      "sources": {
        "application": {"artifactDigest": "sha256:<runner-verified>"},
        "tests": {"commit": "<clean-checkout-commit>"},
        "catalog": {
          "suite": "compass-electron-smoke",
          "digestAlgorithm": "mx-catalog-canonical-v1",
          "digest": "sha256:<computed>"
        }
      },
      "coverage": {
        "nativeDialogs": {"mode": "unsupported"},
        "systemPermissions": {"mode": "manual-witness"}
      },
      "cases": [{
        "caseId": "CPS-EL-BOOT-001",
        "coverageMode": "automated-renderer",
        "artifacts": [{
          "role": "trace",
          "path": "traces/CPS-EL-BOOT-001.zip",
          "sensitivity": "internal",
          "bytes": 123,
          "sha256": "sha256:<computed>"
        }]
      }],
      "warnings": []
    }

硬规则：

- artifact path 必须相对 MX_AUTO_ARTIFACTS_DIR，禁止绝对路径和目录穿越；
- sidecar 中声明的 Case 证据必须包含相对路径、role、大小、digest 与敏感级别；Run 全量文件清单仍由上传器生成，不能把 sidecar 当成未声明文件的放行机制；
- sidecar 中不存在的 JUnit testcase 仍要入库；
- sidecar 解析失败使增强证据不可用；若最低 JUnit 仍有效，可按策略完成 Run 并附 warning，不能伪装为完整证据；
- sidecar 与 JUnit 的 case 数或身份冲突必须显示 contract warning，不能静默合并。

`mx-catalog-canonical-v1` 对 schemaVersion/application/surface/suite/executionMode/coverage 与 Case
语义字段做稳定键排序，Case 按 ID 排序，tags/tracks/prerequisites 去重排序；部署位置字段
`catalogFile` 和说明字段不参与。这样 mx-auto-server 的同步副本与 QA 仓库原件能比较同一语义
digest。增加新的验收语义字段时必须升级算法版本，不能悄悄让旧 projection 忽略它。

详细决策见 [ADR-0002](adr/0002-junit-baseline-and-rich-sidecar.md)。

## Blocked preflight

若工具、被测制品、网络隔离、验证码合同或真实 renderer readiness 不满足，adapter 应在执行断言前写 `MX_AUTO_ARTIFACTS_DIR/preflight.json` 并返回 exit 2。最小字段为：

    {
      "schemaVersion": 1,
      "status": "blocked",
      "suite": "compass-electron-smoke",
      "lane": "bootstrap",
      "stage": "renderer-readiness",
      "reason": "sanitized human-readable reason"
    }

`preflight.json` 是环境诊断，不是伪造的 testcase，也不能把已经成立的产品断言失败改为 blocked。前置检查在零 testcase 前结束时可以没有 JUnit；平台以 exit 2 + preflight 形成 blocked 结论。若旧框架只能把 Electron launch/captcha error 写成普通失败，wrapper 必须检测 preflight marker 并把最终退出码归一为 2。

V0 kernel 还会优先读取 `summary.json`，无 summary 时再读取 `junit/`。新 test-pack 不应为了适配它伪造 summary；JUnit baseline、根目录 sidecar 与 preflight 已足够表达当前合同，旧 kernel 不识别的增强字段作为 artifact 保留。平台注入的 artifact 根目录必须按 Run 全新创建；若发现前一次 Run 的 report、JUnit、sidecar、视频等，wrapper 直接 blocked，不能复用旧结论。

## 结论仲裁

优先级从高到低：

1. runner 生命周期证据：超时、OOM、被驱逐、工具未启动、报告缺失或损坏；
2. 有效 JUnit 的 testcase 数与失败 / error；
3. 进程退出码；
4. rich sidecar；
5. UI 或 adapter 提交的文字状态。

建议规则：

| 条件 | Run 结论 |
| --- | --- |
| 零 testcase | blocked |
| 缺少要求的 JUnit 或 XML 无法解析 | blocked |
| 超时、OOM、浏览器无法启动、目标不可达 | blocked |
| 有效 JUnit 含 failure，或退出码 1 且报告有效 | failed |
| 退出码 0、至少一个 testcase、无 failure | passed |
| 非 0/1/2 未知退出码 | blocked |
| 重试后通过 | passed + stability flaky |
| sidecar 声称 passed，但 JUnit 失败 | failed + contract warning |

退出码建议：

- 0：执行完成，最终无失败；
- 1：有效执行，至少一个产品或断言失败；
- 2：无法形成有效测试结论；
- 其他：平台归一为 blocked，并记录原始码。

基础设施重试与用例重试必须分开。Pod 被驱逐可以重跑相同分片；断言失败只能由框架的明确 retryPolicy 处理，不能让 K8s 整体重跑后悄悄变绿。

## Catalog drift

每个 Run 都比较 Catalog revision 与实际 CaseResult：

| 信号 | 含义 |
| --- | --- |
| notRun | Catalog 有该 Case，本次没有结果 |
| unmapped | 有结果，但 Catalog 没有对应 Case |
| duplicate | 同一 Case ID 在一次 Run 中重复出现 |
| retiredExecuted | 已退役 Case 仍被执行 |
| sourceMismatch | 实际测试源码与冻结 ref 不一致 |

至少分开展示：

- catalog completion：目录中的 Case 有多少得到结果；
- catalog pass：目录中的 Case 有多少最终通过；
- executed pass：实际执行的 testcase 中有多少通过；
- requirement linked：有多少 Catalog Case 关联到需求 / 风险。

UI 和对外材料不得把这些指标合并成一个没有分母说明的“覆盖率”。

## 版本与幂等

- Task 触发先把浮动 branch / tag 解析为 commit，再创建 Run。
- 对同一 trigger、Task revision 和 resolved source 使用 idempotency key，避免 webhook 重放产生重复 Run。
- Run 完成后核心输入、结果和 manifest 不可覆盖；重跑创建新 Run，并通过 rerunOf 关联。
- applied migration 不可修改；使用 checksum 检测漂移。
- artifact 上传按 digest 幂等，同一 chunk 重试不重复占用空间。

## 权限与审计

最低角色：

| 角色 | 能力 |
| --- | --- |
| viewer | 查看被授权项目及内部报告 |
| operator | 触发、取消、重跑 Task |
| maintainer | 管理 Catalog、Suite、runner 和证据策略 |
| admin | 组织级配置、角色、Secret 引用和 retention |

必须审计：

- Project / Suite / Task / Catalog 的新增与修改；
- source ref、adapter、entrypoint、runner image 和 Secret 引用变更；
- 手动触发、取消、重跑、分享与撤销；
- 权限和 runner 注册变更；
- 产物删除及保留策略变更。

审计记录只存 Secret 引用和变更摘要，不存明文值。
