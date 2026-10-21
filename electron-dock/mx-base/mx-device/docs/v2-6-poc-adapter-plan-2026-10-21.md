# V2-6：PoC adapter 方案与 P0、P1 实现

日期：2026-10-21。依据 [2.0 方案](device-center-v2-plan-2026-10-15.md) §7（Host Agent、Device Gate、Driver SPI、PoC 分级）和 §17.1 的已确认决定（Q1：PoC 先不改，按 L0 接入，后续争取 L1；Q2：允许先在测试宿主机部署 Agent）。只改 mx-device。**本轮没有连接手机、PoC、ADB、VPN 或服务器**，不影响 MX-H2I 登录与联网。

## 1. 回答：调度中心已经定义了哪些平台的哪些操作

已经定义了，但目前**只有模拟器能执行全部**。指令库里有 4 个平台、22 条指令，加 15 个内置任务模板。

| 平台 | 指令（动作） | 模拟器 | 旧 PoC 现有接口能覆盖的 |
| --- | --- | --- | --- |
| 通用 | `app.open`（打开）、`session.home`（回桌面）、`session.back`（返回）、`session.restore`（恢复上下文，内部） | 全部 | 无：PoC 在小红书内部执行，不提供打开 App、前台确认或回桌面 |
| 小红书 | `xhs.list`（列表）、`xhs.search`（搜索）、`xhs.search.next`（下一页）、`xhs.note.detail`（详情）、`xhs.get_note_detail.ocr`（正文 OCR） | 全部 | `xhs.search` → `/api/search`；`xhs.search.next` → `/api/next`；`xhs.note.detail` → `/api/note`（需要带 `xsec_token` 的完整笔记链接）。列表和 OCR 没有对应接口 |
| 微博 | `weibo.list`、`weibo.search`、`weibo.like`（写） | 全部 | 无（PoC 只针对小红书） |
| 闲鱼 | `xianyu.refresh` | 全部 | 无 |
| 拼多多 | `pdd.open / search / refresh / next / scroll / detail / ocr / back / home` | 全部 | 无。指令上登记的 `pdd-poc.v1 / pdd-adb.v1 / pdd-custom.v1` 只是接入占位，没有实现 |

15 个内置模板都以"打开 App"开头，或者属于小红书以外的平台，**没有一个能原样跑在旧 PoC 上**。所以本方案新增两个只用 PoC 已有能力的模板（§5）。微博、闲鱼、拼多多以及打开、返回、回桌面这类导航，要靠 ADB 驱动（§9），或者同事扩展 PoC。

现有的真实执行路径是 V1 的"旧 PoC 直连"：中心的 Worker 直接调用宿主机上的 18081，只支持搜索 1–3 页和单篇详情，不走模板、不经过 Agent。本方案把它迁到 **Agent + PoC 驱动 + 版本化模板**，旧路径在迁移完成前保持不变。

## 2. 目标形态：插槽里的手机由 Agent 用 PoC 驱动

```text
设备中心（调度、账本、租约、回执核验）
   ▲  HTTP 长轮询 / 批量回报（Agent 主动连出，V2-3 协议）
   │
宿主机 Agent（与 PoC 的 docker 并列部署，不进入、不修改它）
   ├─ Device Gate：每台手机一个单写槽，校验租约令牌与连续序号
   └─ PocDriver（L0）── http://127.0.0.1:<该手机的 PoC 端口>/api/{state,search,next,note}
                                    │
                                 手机上的 PoC App（XHS 内补丁执行搜索/翻页/详情）
```

- **插槽绑定**：Agent 用 `adb devices` 的序列号上报手机，中心把它列为"待登记"。管理员在「连接设置 → 宿主机 Agent」里把它登记到某个机架的某个插槽。登记时记录驱动类型（`poc`）和 PoC 等级，此后这个插槽只接受 PoC 能做的指令。
- **PoC 地址只在 Agent 配置里**：中心永远不直接访问 PoC。每台手机必须有自己独立可验证的 PoC 入口（独立端口，或带设备参数）。全局分页的单一入口不能被多台手机共用，这一点维持 §7.5 的结论。
- **中心不变的部分**：
  - 调度、节奏账本、账号池、公平、Job API v1 都不用改；
  - 结果不明一律按 unknown 处理并隔离，不自动重试；
  - 真实设备默认暂停，启用需要显式确认独占。

## 3. PocDriver：L0 语义（不改 PoC）

| 项 | 做法 |
| --- | --- |
| 能力声明 | `apps: ["xhs"]`；`commands: [xhs.search, xhs.search.next, xhs.note.detail]`；`canCancel: true`（在两条指令之间停）；`canAbort: false`（PoC 请求发出后无法中止）；`canFence: false`（L0 无法阻止外部调用方）；`canReset: false`（没有回桌面接口） |
| 执行前 | 读 `/api/state`：必须 `ok: true` 且 `isBusy: false`，否则返回 `busy`，Agent 不发起请求，中心把租约退回队列（没有发出过指令，不算未知） |
| 执行 | `search` → `GET /api/search?keyword=`；`next` → `GET /api/next`；`detail` → `GET /api/note?input=<笔记链接>`。超时上限 35 秒（PoC 自身 25 秒，加余量） |
| 执行后核验 | 搜索：`type=search`、关键词相同、页码等于计划页码、`count` 等于条目数、每条有 ID。详情：笔记 ID 与链接一致。之后再读一次 `/api/state`，关键词和页码必须仍是本次的结果，否则判定**外部插入** |
| 不符 | 抛出 `mismatch`，Agent 报错，中心按 unknown 隔离设备，不重试，并保留证据 |
| 回执 | 回显 `commandId / seq / token`，`source: "poc"`；`result` 裁剪到指令的输出 Schema；`evidence` 带执行前后的 PoC 状态、时间戳和 PoC 等级 |
| PoC 超时 | PoC 返回 504 或请求超时都按 unknown 处理（请求已经发出，手机可能已经执行） |

**L0 无法保证**：
- 两次读状态之间有外部调用插入并恰好恢复原状时，L0 发现不了；
- 抓取数据只能按时间窗口归属。

因此上线前要在管理上停用其他调用方（Hub 旧路径、Night-All），这一点与 §7.5 一致。

## 4. 中心侧改动

1. **接受 PoC 回执**：回执校验目前只接受 `source: "simulator"`。改为按设备的驱动类型决定：PoC 驱动的设备只接受 `source: "poc"`，模拟设备只接受 `simulator`。身份和 Schema 校验规则不变。
2. **登记时记录驱动**：Agent 托管的设备登记时写入 `driver` 和 `pocLevel`，`simApps`、`simCommandCodes` 取 Agent 上报的能力。不支持的模板由现有的"指令不支持"阻塞原因挡住，不会派到这台手机。
3. **画面标记**：PoC 设备的画面标为"PoC 接口结果"，而不是"合成投影"；墙上显示 PoC 标签。
4. **超时**：驱动可以声明单条指令的超时（PoC 为 35 秒），Agent 以驱动声明为准。

## 5. 新增模板（迁移 015）

| 模板 | 步骤 | 用途 |
| --- | --- | --- |
| `xhs.poc.search3` 小红书 · PoC 搜索前 3 页 | `xhs.search` → `xhs.search.next` × 2 | 与旧路径"搜索 1–3 页"等价，大循环、可在检查点插入 |
| `xhs.poc.detail` 小红书 · PoC 笔记详情 | `xhs.note.detail`（`target` 为完整笔记链接） | 与旧路径"单篇详情"等价 |

- 两个模板在模拟设备上也能跑（模拟器支持全部指令），所以可以先在模拟机架上演练。
- "搜索后自动看第一条详情"需要把搜索结果里的 `detailInput`（带 `xsec_token` 的链接）传给详情步骤。现有 `xhs.search` v1 的输出 Schema 不含这个字段，要等 `xhs.search` v2 再做，避免改动已冻结的指令版本。

## 6. 分阶段路线

| 阶段 | 内容 | 在哪里 | 退出条件 |
| --- | --- | --- | --- |
| **P0（已完成，§9）** | PoC 模拟器（按已知契约，可注入故障）、PocDriver（L0）、一致性测试、中心接受 PoC 回执、迁移 015、`dev:sim` 预置一个"PoC 机架" | 本地 | 一致性套件通过；外部插入、PoC 卡忙、504、超时、页码漂移各有测试；PoC 机架在工作台上端到端跑通 |
| **P1（已完成，§10）** | 真实域的 Agent：真实模式下登记 Agent 和设备（需要批准和独占确认）；真实模板；真实域经 Agent 签发租约；旧直连路径与 Agent 路径并存，按设备二选一 | 本地 | 测试覆盖真实域租约、确认与隔离；不连接手机 |
| **P2** | 在测试宿主机部署 Agent（host 网络，与 PoC docker 并列），只读：`/api/state` 探测、序列号与 PoC 端口的对应核验 | 测试宿主机（需要你确认时间窗口） | 状态与 8787 截图互相印证；没有任何写请求 |
| **P3** | 单台真机：停用其他调用方后，`xhs.poc.search3` 跑 1 页 → 3 页 → `xhs.poc.detail`；故障演练（拔网、PoC 重启、外部插入） | 测试宿主机 + 1 台手机 | 连续 20 次无不符；演练中未知全部隔离、没有自动重试 |
| **P4** | 向 PoC 作者提 L1 需求：回显请求 ID、抓取序号或游标、可靠的 busy、每台手机独立端口。到位后驱动升级为 L1（抓取数据精确归属，能识别并拒绝并发） | 同事配合 | 驱动的 L1 测试通过；外部插入能被确定识别 |
| **P5** | 一个机架小流量（2–5 台），逐步扩大；争取 L2（PoC 只接受 Agent 的请求） | 测试机架 | 有实测吞吐、未知率与恢复时间 |
| **并行** | ADB 驱动：打开 / 返回 / 回桌面 / 截图，以及微博、闲鱼、拼多多的定位规则；OCR 是否接 mx-ocr 单独决定 | 本地 → 测试宿主机 | 同一套一致性测试 |

## 7. 需要你或同事确认的事

- **P2**：测试宿主机的地址、可以部署 Agent 容器的时间窗口、要用的手机序列号，以及每台手机对应的 PoC 端口。
- **P3 之前**：哪些调用方需要停用（Hub 旧路径、Night-All，还有没有别的），由谁来停。
- **P4**：L1 需求清单交给谁评估。

## 8. 风险

- **PoC 长期报告忙**（历史上出现过 `isBusy: true` 不消失）：L0 执行前检查会一直拒绝，任务回到队列、设备暂停，需要人工核查。这是安全的方向，但会降低可用性。
- **全局分页**：`/api/next` 依赖 PoC 的全局上下文。同一台手机上，搜索和翻页必须在同一个会话内连续执行，中间不能插入其他搜索。大循环会话保证这一点；检查点插入只允许插入不碰 PoC 上下文的任务，PoC 设备上目前不插入。
- **物理上的恰好一次做不到**：已经发出但没有确认的请求可能已经执行，只能隔离并人工核验。

## 9. 本轮实现（P0，已完成）

| 部分 | 文件 | 说明 |
| --- | --- | --- |
| PoC 模拟器 | `server/agent/poc-sim.mjs`、`npm run poc:sim` | 与旧 PoC 相同的 HTTP 契约（四个 GET，同一时刻只处理一个请求，返回 504 超时，客户端断开后手机仍会做完）。可注入五种故障：卡死、504、外部插入、页码不符、一直报忙。数据是合成的 |
| PoC 驱动（L0） | `server/agent/poc-driver.mjs` | 按 §3 实现：接租约前预检；每条指令一个 GET；核验身份与页码；执行后复查状态以识别外部插入；超时 35 秒（含读取响应体）；能力如实声明 |
| Agent | `server/agent/host-agent.mjs`、`main.mjs` | 驱动可提供 `preflight`，不通过就拒绝租约，任务回到队列，没有发出任何请求；驱动可声明单条指令的超时。配置 `driver: "poc"`，每台手机写 `pocOrigin` |
| 域隔离 | 中心握手答复、`PocDriver.preflight` | 中心在握手时告诉 Agent 它属于哪个域。模拟域的 PoC 驱动只接受自报为模拟器的 PoC（`/api/state` 带 `simulator: true`），指向真实 PoC 会在预检时拒绝。真实手机不可能通过模拟域被驱动 |
| 中心 | `server/agents.mjs`、`server/workflows.mjs` | 登记时按驱动上报写入 App、指令、驱动类型和 PoC 等级，可选插槽号（机架内唯一）；PoC 手机只接受 `source: "poc"` 的回执；PoC 手机的大循环在检查点不插入其他任务（PoC 只有一个全局搜索上下文） |
| 模板 | `migrations/015_poc_templates.sql` | `xhs.poc.search3`、`xhs.poc.detail` |
| 界面 | 工作台、单机工作台、宿主机 Agent 面板 | 墙上显示"PoC · 插槽号"标签；画面水印为 PoC，说明为"PoC 接口结果"；Agent 面板显示"PoC 驱动（L0）"；登记表单可填插槽号，PoC Agent 不需要勾选 App |
| 预览 | `npm run dev:sim` | 预置"PoC 机架"：3 个插槽，由一个使用 PoC 驱动的 Agent 托管，每个插槽对应一个本地 PoC 模拟器 |

**测试**：`tests/poc-driver.test.mjs`（14 项）。

- **一致性套件**：PoC 驱动与模拟驱动跑同一套。套件新增两个参数：驱动可以用自己支持的样例指令；声明不支持复位的驱动必须确实没有 `reset`。
- **L0 语义**：
  - 搜索 + 翻页的回执符合输出 Schema；
  - 外部插入、页码不符、504、卡死都不会被当作成功；
  - 卡死后的下一次预检会拒绝；
  - PoC 报忙或不可达时预检拒绝；
  - 详情接受笔记链接或 ID，返回的 ID 不符就拒绝；
  - 不支持的指令会被拒绝。
- **端到端**（中心 → Agent → PoC 驱动 → PoC 模拟器）：
  - 登记后手机只具备 PoC 的能力，需要"打开 App"的模板永远不会派给它；
  - `xhs.poc.search3` 依次请求 search、next、next，三页回执都来自 PoC；
  - `xhs.poc.detail` 能完成；
  - 翻页时发生外部插入：任务记为结果待核验、设备被隔离，没有第三次请求；
  - PoC 一直报忙：租约被拒绝，设备暂停，任务留在队列，没有向 PoC 发出任何请求。

全部 289 项测试通过（`npm run test:pg`）。

**本地试用**（不需要手机）：

```bash
npm run poc:sim -- --port 18181 --count 2
```

然后在管理台「连接设置 → 宿主机 Agent」登记一个 Agent，把凭证写进 `.runtime/agent.json`：

```json
{ "center": "http://127.0.0.1:18891", "token": "<凭证>", "driver": "poc",
  "devices": [{ "serial": "poc-a", "pocOrigin": "http://127.0.0.1:18181" },
              { "serial": "poc-b", "pocOrigin": "http://127.0.0.1:18182" }] }
```

再运行：

```bash
npm run agent
```

最后在 Agent 面板里把两台手机登记到机架的插槽，提交"小红书 · PoC 搜索前 3 页"。直接运行 `npm run dev:sim` 也会自动带一个这样的"PoC 机架"。

**真实接入的前提**（P0 时）：
- 当时中心只允许模拟域的 Agent，模拟域的 PoC 驱动又会拒绝真实 PoC，所以不可能误驱动真机。
- 必须先完成 P1：真实域的 Agent，包括批准、独占确认和默认暂停。**已在 §10 完成。**
- 之后在测试宿主机上把 `pocOrigin` 指向那台手机的 PoC 端口，先做 P2 的只读核验。
- 模板和驱动本身不需要改动。

## 10. 第二阶段实现（P1，已完成）

日期：2026-10-21，只在本地实现和测试。**没有连接手机、PoC、ADB、VPN 或服务器**，没有部署，现役 mobile-agent 容器和旧直连路径都没有动。

### 10.1 从登记到执行

1. **登记 Agent**（`POST /api/agents?mode=real`）：
   - 必须填写宿主机，并带 `approved: true`；
   - Agent 属于哪个域在登记时确定，之后不变。中心按 Agent 自己的域处理它的所有消息（`store.agentRealm`），凭证只在那个域的数据里核对。
2. **Agent 连接**：真实域只接受 `driver: "poc"`，其他驱动在 hello 时返回 403，Agent 停止。握手答复告诉驱动它属于真实域。
3. **登记手机**（`adopt`）：
   - 必须填写手机上的账号（`accountKey`），并带 `approved: true`；
   - App 和指令只取驱动上报的能力（小红书，搜索 / 下一页 / 详情三条）；
   - 设备记为 `adapter: "agent"`，没有 PoC 地址（中心不访问 PoC），不属于任何宿主机 Worker；
   - **登记后暂停**，不会自动接手任何任务。
4. **检查连接**：
   - 管理员点"检查连接"（原来的 probe 接口）；
   - Agent 在长轮询里收到请求，通过驱动只读一次 `/api/state`，再回报结果；
   - 请求 30 秒内有效，只交给 Agent 一次，丢失需要重新点；
   - 真实域里自报为模拟器的 PoC 永远不算空闲证据。
5. **启用**：走原来的 `control enable`，规则不变：60 秒内的空闲证据，加 `confirmedExclusive: true`（确认 Hub 旧调度和其他调用方已停止）。
6. **提交**（`POST /api/jobs?mode=real`）：
   - 只接受 `real:xhs.poc.search3:1` 和 `real:xhs.poc.detail:1`；
   - 必须 `confirmed: true`，与旧真实任务相同；
   - 必须指定一台由 Agent 以 PoC 驱动托管、已启用的手机，不自动换账号；
   - 不用演示默认值：搜索必须写关键词，详情必须给带 `xsec_token` 的完整笔记链接。
7. **执行**：由单活调度器签发租约（见 §10.2），Agent 预检、执行、回报。指令行记为真实域；会话在检查点不插入任何任务，由同一会话继续；结果不明时按未知隔离，不重试。

### 10.2 取舍：真实域由谁签发租约

| 方案 | 结论 |
| --- | --- |
| 旧路径：设备归它所在宿主机的 Worker，Worker 在进程内调用 PoC | **保持不变**。Worker 必须与 PoC 在同一台机器上，所以不受领导者限制，原来的领取事务一行未改 |
| Agent 托管的手机：交给单活调度器（领导者）签发 | **采用**。签发只是一条数据库决定，PoC 由宿主机上的 Agent 调用，中心进程从不访问 PoC。所以与模拟域一样只由领导者签发，事务带 epoch 防护，并且与旧领取分开、单独一个事务 |
| Agent 托管的手机：由那台宿主机的 Worker 签发 | 不采用。要把 Agent 和 Worker 绑在一起，宿主机上多一个必须存活的进程；而 Agent 本身就是那台宿主机的执行者 |

由此得到的行为：
- 备用实例不签发真实租约；
- 领导者切换时，Agent 继续执行手上的租约（V2-3 语义），新领导者接着签发；
- 真实域的大循环在检查点不插入任何任务：PoC 只有一个全局搜索上下文，真实插入也没有验收过。租约中途结束时，调度器以新令牌续签同一会话。

### 10.3 域隔离与"二选一"

**域隔离**（真实域不得连接 PoC 模拟器，模拟域的规则不变）：

| 位置 | 检查 |
| --- | --- |
| `PocDriver.preflight` | 模拟域只接受 `simulator: true` 的 PoC（不变）；真实域遇到 `simulator: true` 拒绝租约；还不知道所属域时什么都不做 |
| 中心记录检查结果 | 真实设备的 PoC 自报模拟器：`idle: false`，写明原因，不能用于启用 |
| 中心核验回执 | 真实域的 PoC 手机只接受 `source: "poc"`；驱动在回执证据里记下执行后 `/api/state` 是否自报模拟器，真实域遇到 `evidence.simulator: true` 时回执作废，任务记为未知并隔离设备。其他真实设备不接受任何来源的组合指令回执 |
| 迁移 016 | 真实任务定义只能是两个 PoC 模板，真实指令行只能是三条 PoC 指令 |

**同一台手机只能二选一**（Agent 托管或旧 PoC 直连）：
- 序列号：真实域内唯一。双向都会拒绝并说明原因，迁移 016 另加唯一索引 `devices_real_serial` 兜底；
- 账号：`accountKey` 在真实域内唯一（原有约束）。旧直连登记可以不填序列号，所以账号是主要的识别依据；
- Agent 面板的 `conflicts` 列出这类序列号；
- 旧搜索 / 详情任务不能指定 Agent 托管的手机；真实模板只会派给 Agent 托管的手机（`matchesJob`）；
- 旧的直连执行（`Engine.execute` 的 search / note、Worker 的 probe）只处理自己宿主机上、非 Agent 托管的设备，行为不变。

### 10.4 改动

| 部分 | 文件 |
| --- | --- |
| 登记、hello、检查请求与回报、`conflicts` | `server/agents.mjs` |
| 真实设备登记（Agent 托管）、真实领取、旧任务拒绝 Agent 手机 | `server/model.mjs` |
| 真实模板提交、指令按任务所属域记录、续跑不插入、回执来源 | `server/workflows.mjs` |
| 真实 App / 指令能力，模板只派给 Agent 手机 | `server/apps.mjs`、`server/scheduling.mjs` |
| 领导者签发真实租约（单独事务）；Worker 的 probe 跳过 Agent 手机 | `server/engine.mjs` |
| Agent 接口按 Agent 所属域处理；`device.probed`；Agent 离线时拒绝检查 | `server/http.mjs`、`server/store.mjs`（`agentRealm`） |
| 真实模板（`REAL_DEFINITIONS`），与迁移 016 相同 | `server/workflow-catalog.mjs`、`migrations/016_real_poc_templates.sql` |
| Agent 执行检查请求；停止时立即结束心跳等待 | `server/agent/host-agent.mjs` |
| 真实域的预检；回执证据带 `simulator` | `server/agent/poc-driver.mjs` |
| `pocOrigin` 只接受宿主机本地地址 | `server/agent/main.mjs` |

迁移 016：
- 放宽 `task_definitions`、`execution_commands` 的域检查，但真实行只允许上面列出的模板和指令；
- 原来的行都是模拟域，所以新检查用 `NOT VALID` 加上，不扫表、不长时间锁表；
- 新增唯一索引 `devices_real_serial`。如果线上已有重复的真实序列号（模型一直禁止，理论上没有），迁移会失败并整体回滚，需要先处理重复登记；
- 插入两个真实模板。

### 10.5 测试

全部使用 PoC 模拟器和本地临时 PostgreSQL。为了扮演真实 PoC，测试里用一个包装函数去掉模拟器的 `simulator: true`；产品代码里没有这种开关。

- `tests/poc-real.test.mjs`（6 项，经 HTTP 接口端到端）：
  - 登记需要批准和宿主机，手机登记后暂停；
  - 没有空闲证据或没有独占确认时不能启用；检查连接只读一次 `/api/state`；
  - 真实模板必须确认、指定设备、填写关键词和完整链接；`xhs.poc.search3` 依次请求 search、next、next，三页回执都来自 PoC，指令和事件都记在真实域；详情能完成；
  - 诚实的 PoC 模拟器：检查结果不是空闲；即使强行启用，预检也拒绝租约，任务留在队列，没有发出任何请求；
  - 执行后 `/api/state` 变成模拟器：回执作废，任务未知，设备隔离，没有下一次请求；
  - 备用调度器不签发真实租约，但宿主机 Worker 照常执行旧直连任务；领导者签发后由 Agent 执行；旧直连调用从未碰过 Agent 的手机；旧任务和真实模板不会派错设备；
  - 同一序列号或同一账号不能既是旧直连又是 Agent 托管（双向）；
  - 真实域 Agent 用模拟驱动 hello 返回 403；Agent 只出现在自己的域里。
- `tests/poc-real-pg.test.mjs`（1 项）：迁移 016 的模板与 `REAL_DEFINITIONS` 完全一致；检查约束拒绝其他真实模板和其他真实指令；唯一索引拒绝重复的真实序列号；在 PostgreSQL 上走 Agent、设备、尝试三种事务作用域，由真正的领导者签发，任务成功，指令行为真实域。
- `tests/poc-driver.test.mjs` 新增 1 项：真实域的驱动拒绝 PoC 模拟器；不知道所属域时什么都不做；回执证据带 `simulator`。
- 调整了 6 个文件里 7 个旧测试的预期：内置定义计数只数模拟域、真实目录现在有两个模板、迁移数为 16（两处）、真实组合任务从"一律拒绝"改为"只接受确认过的真实模板"、驱动测试显式设定模拟域。

`npm run test:pg` 共 **297 项全部通过**（P0 后为 289 项）。`HostAgent.stop()` 不再等满 5 秒心跳间隔，整套测试从约 50 秒降到约 26 秒。

### 10.6 仍待处理

| 项 | 说明 |
| --- | --- |
| 真实域 Agent 的管理界面 | 「连接设置 → 宿主机 Agent」面板仍只在模拟模式显示，真实域的登记、批准、登记手机目前通过 API 完成。工作台上 Agent 托管的真实手机沿用已有的"检查连接 / 启用"按钮 |
| 把旧直连登记迁到 Agent | 没有"退役设备"操作，同一台手机已有旧直连登记时只能登记为新的序列号和账号。P3 之前需要补一个可审计的退役流程（要求暂停、无在途、无待处理任务） |
| 真实域的节奏 | 真实设备没有循环策略，整机间隔默认 2 秒，大循环的检查点也按这个间隔等待；真实设备的节奏规则在 P3 实测后再定 |
| P2 | 在测试宿主机部署 Agent（host 网络），只做 `/api/state` 探测和序列号与 PoC 端口的对应核验。需要你确认 §7 的地址、时间窗口、手机序列号和端口 |

