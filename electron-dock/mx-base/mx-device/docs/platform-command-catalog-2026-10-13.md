# 平台指令目录、任务目录与拼多多迁移

日期：2026-10-13。范围：mx-device 的本地模拟目录、持久化、任务展开和开发者 adapter 契约。未连接或部署现役 PoC、ADB、手机和 OCR 服务；未修改 MX-H2I 的登录或联网。

## 数据模型与边界

同一种动作可以属于不同平台，却具有不同耗时、参数、结果和执行方式。目录因此区分 `action` 和 `code`：`search` 表示搜索语义，`pdd.search`、`xhs.search` 分别保存平台自己的版本、预估耗时、输入/输出 Schema 和 adapter 引用。

| 层级     | 持久数据                        | 含义                                                                           |
| -------- | ------------------------------- | ------------------------------------------------------------------------------ |
| 指令定义 | `mx_device.command_definitions` | 平台、逻辑代码、版本、动作语义、预估耗时、超时、输入/输出 Schema、adapter 绑定 |
| 任务定义 | `mx_device.task_definitions`    | 顺序步骤、重复次数、每步的指令版本和快照、输入映射、循环类型                   |
| 任务实例 | `mx_device.jobs`                | 一次 API 请求的参数、幂等键、固定任务版本和展开计划                            |
| 执行尝试 | `mx_device.attempts`            | 此次领取的设备和所有权；不等同于任务身份                                       |
| 指令执行 | `mx_device.execution_commands`  | 每步实际输入、指令定义快照、执行身份和回执                                     |

指令和任务目录 CRUD 采用追加版本。`code` 是稳定身份，`version` 是不可变修订。新建要求 `expectedVersion: 0`，修改必须提供最新版本号；并发修改发生冲突时返回 409，不静默覆盖。删除采用归档版本，历史任务、指令回执和审计记录保留。已入队实例固定原有快照，不会被管理员稍后修改目录而改变行为。内部 `session.restore` 不允许通过目录编辑或归档。

这轮目录仅接受 `sim`；保存 PoC/ADB/custom 引用不代表启用真实控制。通用动作和平台参数/结果分离，也不代表可以把其他 App 的登录态、分页游标或 OCR 结果移到另一部手机。

## 拼多多初始指令

007 迁移增加拼多多 `pdd` 的 9 条 v1 指令，以及原有平台的指令定义。估时是模拟初始值，可以编辑；它不是已在真机测出的性能数据。

| 代码          | 操作              | 初始预估 | 主要完成结果                                      |
| ------------- | ----------------- | -------: | ------------------------------------------------- |
| `pdd.open`    | 打开应用          |  1500 ms | `foregroundAppId: "pdd"`                          |
| `pdd.search`  | 搜索商品          |  3200 ms | 关键词、页码、商品数组                            |
| `pdd.refresh` | 下拉刷新          |  2300 ms | 刷新后的商品数组                                  |
| `pdd.next`    | 下一页            |  2600 ms | 页码、商品数组                                    |
| `pdd.scroll`  | 滚动浏览          |  1400 ms | 当前可见商品数组                                  |
| `pdd.detail`  | 商品详情          |  3000 ms | 目标、商品 ID、标题、分为单位的价格、正文、完整性 |
| `pdd.ocr`     | 获取详情 OCR 文本 |  4200 ms | 目标、全文、完整性、文本块及置信度                |
| `pdd.back`    | 返回上一层        |   900 ms | `backed: true`                                    |
| `pdd.home`    | 回到工作首页      |  1100 ms | `home: true`                                      |

拼多多列表的商品项为 `{ id, goodsId, title, priceCents }`，区别于已有平台的简化列表项。价格使用非负整数分，OCR 块包含 `{ text, confidence }`，置信度限定 0–1。列表可以合法为空；空列表不等于搜索失败，但引用第一个商品的后续详情步骤没有有效输入，不能编造商品继续执行。该情况标记为已知的 `failed`，保留前序回执；确认没有在途指令后按正常冷却释放模拟设备，不将业务空结果伪装成设备状态未知。

Schema 使用受限、可审计的声明式子集：object、array、string、integer、number、boolean、null，支持 required、长度/数值范围、enum。禁止任意附加字段、远程 `$ref` 和可执行表达式，并限制嵌套与数量。自定义指令也必须先定义输入和输出契约。动作的保留字段（如 page/items/keyword/target/complete）若声明则须符合类型与完成语义；不同字段名、商品项内部结构仍可扩展。模拟器按 Schema 生成有界合成数据，平台预置字段有专门示例；这些数据不是 OCR 或 App 的真实采集结果。

## 拼多多初始任务

| 任务代码                | 顺序步骤                                |
| ----------------------- | --------------------------------------- |
| `pdd.refresh`           | 打开 → 下拉刷新                         |
| `pdd.search`            | 打开 → 搜索                             |
| `pdd.detail`            | 打开 → 搜索 → 首个商品详情 → 返回       |
| `pdd.search_detail_ocr` | 打开 → 搜索 → 首个商品详情 → OCR → 返回 |
| `pdd.search5`           | 打开 → 搜索第 1 页 → 下一页 × 4 → 首页  |
| `pdd.browse`            | 打开 → 刷新 → 滚动 × 5 → 首页           |

任务步骤固定 `commandVersion` 和 `commandDefinition`，同一任务可以组合导航、列表获取、详情、OCR 等指令。初始详情与 OCR 任务通过前序结果引用商品 ID，例如：

```json
{
  "code": "pdd.detail",
  "commandVersion": 1,
  "repeat": 1,
  "input": {
    "target": { "fromStep": 1, "path": ["items", 0, "goodsId"] }
  }
}
```

`fromStep` 使用已展开计划的零基索引，此例 0 是打开应用、1 是搜索。引用只读取本任务此前已验证的结果；没有命中的商品、字段缺失或类型不匹配必须在下一条手机操作之前停止。输入映射不运行 JS，不接受任意路径表达式。固定重复次数是有界执行，当前不包含“任意直到满足条件”、跨设备恢复分页、动态遍历全部商品等无限制工作流能力。

小任务最多 4 条展开指令，大任务最多 30 条；每组重复为 1–10，最多 12 组。这些上限保护当前实验池，不承诺满足所有后续采集业务。拼多多分页模板不宣称支持真实检查点恢复。

## 管理接口

接口沿用已有认证和写入保护。管理界面提供“指令与任务库”目录，支持筛选、新建、编辑、归档、历史版本和模拟提交。

| 方法与路径                                     | 作用                                                |
| ---------------------------------------------- | --------------------------------------------------- |
| `GET /api/command-definitions?mode=sim`        | `{ commands, history }`：当前活跃指令与完整版本历史 |
| `POST /api/command-definitions?mode=sim`       | 创建或追加版本；body 含 `expectedVersion`           |
| `DELETE /api/command-definitions/:id?mode=sim` | 归档最新版本；body 为 `{ "expectedVersion": n }`    |
| `GET /api/task-definitions?mode=sim`           | `{ definitions, commands }`：任务版本与活跃指令     |
| `POST /api/task-definitions?mode=sim`          | 创建或追加任务版本                                  |
| `DELETE /api/task-definitions/:id?mode=sim`    | 归档最新任务版本                                    |

URL 的 `:id` 是完整定义 ID，例如 `sim:pdd.search:1`，调用端需正常 URL 编码。任务最新版本已经归档时，该代码的任何版本都不接受新实例；同一请求的幂等重放仍返回原任务，已入队实例继续使用自己的冻结版本。指令归档阻止新任务定义引用，但已有任务定义保留的指令快照仍可提交执行；要停止一个既有任务模板的新提交，应归档任务模板本身。

007 是增量数据库迁移。新建 `command_definitions`，保留 `task_definitions`，模拟 App 约束增加 `pdd`；真实平台约束保持原值。迁移写入的是模拟目录数据，不会安装 App 或执行手机操作。已有自定义任务的步骤、输入映射保留，缺失的指令快照按旧目录 v1 回填。运行标准发布流程的 migrate 阶段会应用007；本轮只在临时 PostgreSQL 验证，未对线上数据库执行迁移。

## PoC / ADB / 自定义接口的开发者契约

`server/command-adapters.mjs` 实现可执行的进程内分发器；三个类型共用一种稳定契约。目录 binding 只有引用，不含 URL、shell、脚本、凭证或执行代码：

```json
{
  "kind": "poc",
  "adapterId": "pdd-poc.v1",
  "operation": "search"
}
```

拼多多种子为每个操作预留 `pdd-poc.v1`、`pdd-adb.v1`、`pdd-custom.v1`，默认没有安装任何 handler。开发者通过可信服务代码注册明确的允许操作；目录编辑不能远程安装执行程序。

```js
import {
  createCommandAdapterRegistry,
  executeBoundCommand,
} from "./server/command-adapters.mjs";

const registry = createCommandAdapterRegistry();
registry.register({
  kind: "custom",
  id: "pdd-custom.v1",
  operations: ["search"],
  async execute(request, { signal, binding }) {
    // developerClient 由可信执行端注入；它必须验证停止与结果归属。
    const evidence = await developerClient.search(request, { signal });
    return {
      ...request,
      source: "adapter",
      transport: binding.kind,
      bindingId: binding.adapterId,
      stopped: evidence.stopped,
      result: evidence.result,
    };
  },
});

// 只能传入已领取的 real/running 指令；调用前须持久记录派发意图，
// 验证设备独占所有权，并在数据库事务之外执行。
const receipt = await executeBoundCommand(claimedCommand, {
  registry,
  binding: "pdd-custom.v1",
  signal: workerAbortSignal,
});
```

示例中的 `developerClient`、`claimedCommand` 和 `workerAbortSignal` 是调用方提供的依赖，不是本项目已经配置的真实拼多多客户端。更换 `kind` 和登记 ID 即可安装 PoC/ADB handler，但每个 handler 必须实际实现其操作，不会自动把 `search` 翻译成网络路径或 ADB 点击坐标。

分发器生成深度冻结的 request：`commandId`、可选 `jobId`、`attemptId`、`deviceId`、`appId`、`code`、可选 `stepIndex`、`commandVersion`、`operation`、`input`、`timeoutMs`、`idempotencyKey`。原始命令的快照使用 `definition`，兼容别名 `definitionSnapshot`。多种已安装 binding 同时匹配时必须显式选择；未登记操作、无效参数、未知 binding、模拟指令不能进入 handler。

有效回执必须回显请求身份和幂等键，附 `source: "adapter"`、`transport`、`bindingId`、`stopped: true`、符合输出 Schema 的 `result`。分发器还验证 Schema 中声明的规范字段语义，如打开的 App、详情目标、页码和关键词；自定义格式不强制复用其他平台的字段名，其客户端仍负责证明原始上游数据确实属于本次手机操作。HTTP 200、ADB 命令退出码 0、保存了一张截图，都不足以证明搜索/详情/OCR 成功。

所有派发后异常、超时、取消、回执不匹配都返回 `CommandAdapterError`，包含 `ambiguous: true`、`dispatched: true`、`retryable: false`。AbortSignal 仅请求停止，不证明物理手机已经停止。调用方应持久记录 unknown 并隔离设备，不自动尝试另一种 adapter，也不换机重跑。有效晚到回执记录为 lateEvidence，不自动把 unknown 改成 succeeded。

同一个 registry 生命周期内同一 `commandId` 只允许进入一次；重复请求会拒绝。`registry.getDispatch(commandId)` 可读取状态、有效回执或晚到证据。该账本默认最多 10000 条，到限后在派发前拒绝，不默默淘汰旧身份；可在可信进程初始化时设置 `maxDispatches`。它是进程内补充保护，**不是持久化 fence、跨进程去重或完整真实调度器**。重启后的领取、恢复和隔离仍须由已有数据库状态与真实执行端证明共同约束。

## 接入真实平台前的具体缺口

当前真实 worker 没有接入上述新分发器，组合任务真实执行仍关闭。原因是本仓库尚无已验证的拼多多 PoC 路由/结果格式、可靠的 ADB 元素选择器、对应版本的 UI 导航契约，以及设备独占和执行停止证明。这里实现并通过假 handler 测试的是扩展接口，不是已验收的拼多多手机采集。

需要分别补齐：

1. PoC handler：可定位设备、App 和本次指令的服务契约，响应关联、停止证据、分页和详情原始格式映射。旧 PoC 无法提供的能力不能靠中心猜测补成成功。
2. ADB handler：指定设备的固定调用、选择器或分辨率适配、页面状态核验；导航能力与获取商品 JSON 的能力分别声明。不要把来自管理界面的字符串拼成 shell。
3. OCR handler：截图来自哪台设备、哪次指令、哪个详情页，以及 OCR 引擎、文本块、置信度、页面完整性的证据。截图本身不产生 OCR 数据；本轮没有接入 mx-ocr。
4. 自定义接口 handler：由开发者部署可信客户端和地址/凭证配置，将供应商结果标准化为目录 Schema；不通过浏览器保存密钥或开放任意代理地址。
5. 执行生命周期：持久派发意图、真实设备所有权校验、重启恢复、晚到回执的持久接收、停止/复位验收。无停止证明的未知任务持续占据隔离边界。
6. 业务扩展：搜索前 N 条的去重与不足 N 条终止、遍历每件商品详情、条件分支、OCR 覆盖度、多种价格类型、会话分页上下文。这轮已有有界模板与前序结果引用，尚未实现通用工作流解释器。

## 验证与交接

`tests/command-adapters.test.mjs` 使用实际注入的 PoC、ADB、custom 假 handler 调用分发器，覆盖不可变请求、明确操作允许列表、binding 选择、身份/Schema/停止校验、重复派发、超时、取消、晚到结果、数据格式差异和 OCR 完成边界。测试不联网、不调用 shell、不接触手机。

目录/任务迁移、CRUD、并发版本冲突、快照冻结及前序结果引用的验证位于各自测试中；最终整体验证记录由本轮主任务更新。本文不把模拟数据或本地测试解释为真实平台成功验收。


### 本轮本地验收记录

- 完整测试 **168 通过，0 失败，0 跳过**，使用一次性本机 PostgreSQL；包含001–006升级到007、重复迁移、命令/任务并发版本冲突、归档/恢复、历史快照、单机串行、6个拼多多模板、输入引用、每步重建连接池后的回执依赖与最终结果持久化。测试结束停止临时数据库。
- 15项 adapter 测试使用注入的假 handler；覆盖PoC/ADB/custom、超时/取消、晚到证据、操作白名单与不可变身份。没有真实手机请求。
- 桌面1440×1050、手机390×844浏览器检查：指令与任务创建/编辑/归档/恢复，拼多多“搜索→详情→OCR”实际模拟执行，goodsId传递，页面无脚本错误、无整页横向溢出。环境没有 Browser 插件，使用本机 Playwright/Chromium。
- Vite生产构建、Node语法检查和限定本项目的diff检查通过。
- 仍未做线上迁移、服务器部署、真实拼多多数据采集或mx-ocr集成；新adapter分发器尚未接入真实worker。
