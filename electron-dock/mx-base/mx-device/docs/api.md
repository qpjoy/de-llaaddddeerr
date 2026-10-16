# API 与 mx-rig 接入

全部管理接口需要独立管理会话 cookie 或 `Authorization: Bearer <admin token>`。测试自动化使用单独 `testToken`，服务端限制为 `mode=sim`。不要把 admin token 交给测试项目，不要把凭证放 URL 或前端存储。POST 需要 JSON，同源检查拒绝带外站 Origin 的写请求。

| 接口 | 作用 |
| --- | --- |
| POST /api/login | `{token}` 换取 HttpOnly、SameSite=Strict 的 12 小时会话 |
| POST /api/logout | 清除当前浏览器会话 cookie |
| GET /api/session | 当前 `admin` / `test` 角色 |
| GET /api/state?mode=sim | 本中心快照；不调用设备 |
| GET /api/jobs/:id?mode=sim | Job、Attempt、Command、检查点、完整结果与迟到证据 |
| POST /api/devices?mode=real | 登记设备；真实设备默认暂停 |
| POST /api/resources/control?mode=sim | `{scope:rack\|host,rack,host?,revision,action:drain\|release\|limit,maxConcurrent?}`；持久资源策略 |
| POST /api/devices/:id/placement?mode=sim | `{revision,name,rack,host}`；仅暂停空闲且无预留时修改中心归属 |
| POST /api/devices/:id/pacing?mode=sim | `{revision,deviceIntervalMs,apps:[{appId,cooldownMs}]}`；暂停空闲且无预留时配置间隔 |
| POST /api/devices/:id/adapter-test?mode=sim | `{key,appId,code,keyword?,target?}`；在指定模拟设备排队试运行白名单指令，返回 202 Job |
| POST /api/devices/:id/probe?mode=real | `{revision}`；指定 Worker 异步执行一次只读状态查询 |
| POST /api/devices/:id/control?mode=sim | `{revision,action}`；乐观版本校验 |
| POST /api/devices/:id/observer?mode=real | `{revision,origin,serial,approved:true}`；附加只读画面配置，保存不连接手机 |
| POST /api/devices/:id/capture?mode=real | `{}`；提交或合并一次取帧请求，指定 Worker 执行，返回 202 |
| GET /api/devices/:id/frame?mode=real&captureId=UUID | 只读取最新已保存 PNG；需管理认证，no-store，不连接手机 |
| POST /api/devices/:id/session?mode=sim | `acquire/renew/release/takeover/reset`；见下方边界 |
| POST /api/devices/:id/mobile-status?mode=real | `{}`；显式读取 Mobile-Agent 既有设备/运行器报告，202，5 秒冷却、20 秒到期 |
| POST /api/devices/:id/poc-channel?mode=real | `{revision,enabled:boolean,confirmed:true}`；只开关本中心的旧 PoC 调用，保持暂停、保留历史 |
| POST /api/jobs?mode=sim | 幂等提交搜索 / 详情 / 定义任务 |
| POST /api/jobs/:id/cancel?mode=sim | 仅取消 queued，不取消在途执行 |
| POST /api/scenarios?mode=sim | `{kind:five\|priority\|failover\|multiapp\|rack20,key}`；当前演示无活动任务时创建新场景 |
| GET /api/pool-scenarios?mode=sim | 虚拟调度池的 8 类场景与默认策略；只读，不派发 |
| POST /api/pool-simulate?mode=sim | `{scenario,deviceCount,seed,policy?}`；独立虚拟时钟对照，返回报告，不写入实际任务池 |
| POST /api/loop-policy?mode=sim | `{rack,revision,...,scheduler?}`；模拟循环与池策略版本化更新 |
| GET /health/live | API 进程存活，不检查外部设备 |
| GET /health/ready | 本中心数据库可用，不检查 Hub、手机或 mx-rig |

以上 mode 可按权限使用 sim / real，但场景只能 sim，probe 只能 real。没有任意 URL 转发或命令执行 API。

调度池参数、场景和报告边界见 [任务调度中心方案](task-scheduling-center-2026-10-13.md#11-可重复场景与验收指标)。设备数量为 2/10/20/50/100，默认 mixed、10 台、seed 42。每 API 进程同时只计算一份报告，繁忙返回 429，6.5 秒计算超时返回 503。模拟设备登记可提供 `simApps:[xhs,weibo,xianyu]`、`simCommandCodes:[已登记代码]`；省略时兼容原小红书/微博设备。闲鱼仅支持模拟定义 `sim:xianyu.refresh:1`，不扩展旧搜索/详情端点。池软分配随 state 返回，属于预测，不是执行授权。

Adapter 试运行仅 `sim`，`real` 返回 403。App 为 `xhs|weibo|xianyu|pdd`；指令须在当前活跃目录内且匹配 App，不接受内部 `session.restore`。服务端生成准备步骤：`app.open` 自身一条，其余先打开 App，`action: next` 还会先执行该平台的活跃搜索指令。忽略调用方自传 plan/priority，固定为优先级 5 的小循环，仍遵守物理单槽、App 冷却、机架限额、暂停与检查点插入预算。新任务要求设备已启用且非隔离；相同 key/参数返回原 Job，更改命令、App、目标或关键词返回 409。Job 保存 `adapterTest:{code,appId}` 及冻结的 workflow plan，不自动新增任务定义；保存定义仍显式使用 `POST /api/task-definitions?mode=sim`。真实截图/状态/连接检查复用上表原有接口。

资源策略：不存在持久策略时 `revision:0`，之后使用快照中的版本；陈旧版本返回 409。`limit` 的 `maxConcurrent` 为 1–64 整数或 null（不另设上限）。`drain` 暂停全部成员并阻止后来成员新领取，不中断在途；`release` 只解除本级排空，设备仍暂停，上级排空仍有效。资源分组必须已有设备；每模式最多 512 条策略。归属编辑不能更改 Worker、serial、入口或账号，不调用外部服务。

GET state 增加 `resources`、数据库时间 `now` 与只读 `scheduling`：含 `at/counts/groups/devices/queue`。设备诊断是 `blockers[{code,message}]`；队列诊断含 `jobId/order/effectivePriority/waitMs/candidateDeviceIds/status/reasons`。候选并非领取承诺，Worker 心跳/工作槽只是最近报告，实际额度在事务内再判断。快照保留全部活动任务、最近 100 个终态及活动依赖，以及全部 running/yielded Attempt 和最近 100 个结束尝试，不返回完整 result/lateEvidence/checkpoints。

模拟任务可选 `rack`，并可进一步指定 `host`；host 必须伴随 rack，选择具体 deviceId 时也须符合范围。范围参与幂等指纹；真实旧 PoC 任务拒绝 rack/host 池化范围，仍明确指定设备。资源筛选不支持跨模式匹配。

真实设备登记字段：`name, rack, host, workerId, adapter, origin, accountKey, serial, approved:true`。省略 adapter 兼容旧 `legacy-poc`：入口仅允许 `http://127.0.0.1:18081–18180`，serial 可暂缺，每个 `(workerId, origin)` 唯一。`adapter:mobile-agent` 为只读观察：入口仅允许 `http://127.0.0.1:8787–8797`，serial 必填，每个 `(workerId, origin, serial)` 唯一。同一原设备可通过 observer 增加画面配置；不能为同一真实序列号重复建两个适配器设备。账号标识、非空真实序列号跨真实设备唯一。入口不接受路径、凭证、查询、片段或重定向，由指定 Worker 解释 localhost；没有任意网络代理。

画面请求仅调用既有服务 `GET /api/screen.png?device=<serial>`；10 秒超时、6 MiB 上限、PNG 格式/尺寸校验。相同设备的未完成请求合并，完成后至少 2 秒才允许下一请求；20 秒过期的回执不再写入。`captureId` 不是访问凭证。GET frame 只有最新帧，同一帧被替换后返回 404，客户端刷新本中心记录即可。完整 PNG 不进入快照或事件。

控制会话：`acquire` 要求 `{action,revision,confirmed:true}`，暂停后续领取、等待已有任务结束，返回 `{device,token}`；token 仅返回给申请者，在内存保管。`renew/release` 必须携带 token。60 秒未续期保持暂停、不自动重发任务。快照不含 token 或其哈希。`takeover`（revision + confirmed）和 `reset`（token）**只能 sim**，real 服务端返回 403。真实 acquire 只是 `center-only` 预留，并不检查或撤销旧 Mobile-Agent/PoC/ADB 控制权。Mobile-Agent 观察设备禁止 enable、probe 和采集任务。

任务提交：搜索为 `{key,operation:'search',keyword,pages:1..3,priority:1..9,deviceId?}`；详情为 `{key,operation:'note',input:'完整 HTTPS explore 链接',priority,deviceId?}`，也可用 `sourceJobId` 替代 input 来消费已成功搜索的首条链接。真机必须指定 `deviceId` 且 `confirmed:true`。相同 key 与相同规范化参数返回原任务；参数变更返回冲突。

控制动作：`pause` 停止新领取；`enable` 启用（真实需近期 idle probe 与 `confirmedExclusive:true`）；`recover` 隔离恢复（等待旧租约结束、重新取得 idle、`confirmedStopped:true` 与核验说明，恢复后仍暂停）；`disconnect/reconnect` 仅模拟。

状态报告保存在设备 `mobileStatus`，与旧 `probe`、`projection` 分离；`occupancy` 仅为 `reported-busy` / `not-reported` / `unknown`，`not-reported` 不是物理空闲或独占证明。数据库快照 GET 不触发读取。上游日志/配置不出现在报告，未匹配序列号或格式错误视作未知。

停用旧通道前须无待处理采集任务、在途尝试和未完成 probe，设备暂停且状态可核验；不会中断现有物理工作。`pocDisabled:true` 时 probe、enable、采集提交及调度领取均被禁止。恢复通道后仍暂停，启用必须有晚于 `pocChangedAt` 的新鲜空闲证据。开关不影响 8787 的截图或状态读取，不停止手机 PoC/VPN。

## App / 账号节奏与预计耗时

任务可选 `appId: xhs|weibo`，默认 xhs；weibo 仅模拟，真实提交返回 400。详情依赖必须属于同一 App；模拟微博链接为 `https://weibo.com/<数字用户>/<字母数字ID>`。绑定账号由设备登记/迁移确定，提交方不能改账号来清冷却。

可选 `estimatedDurationMs` 为 1000–180000 整数毫秒，搜索 1/2/3 页默认 15000/25000/35000，详情 20000。省略与显式默认同义，兼容历史幂等指纹；更改自定义估计或 App 会冲突。新 Job/Attempt 保存 `executionModel:exclusive-session.v1`。估计是排序提示，不是实际停止时间。排序规则见 [实施说明](app-pacing-2026-10-10.md)。

pacing 接口的整机间隔为模拟 0–86400000、真机 2000–86400000 整数毫秒。`apps` 必须恰好包含当前适配器支持的全部 App，每个 cooldownMs 为 0–86400000。版本冲突、非暂停空闲、控制会话未释放返回 409；观察设备不开放配置。已有冷却只延长不缩短；新登记/升级的 App 额外间隔初始为 0。

快照增加 `apps` 持久记录；`scheduling.devices[]` 增加 `deviceIntervalMs/commonBlockers/apps`，App 含账号资源、cooldownMs/Until、lastClaimedAt/DispatchedAt/FinishedAt/SucceededAt、active、nextAllowedAt 与阻塞原因。App 的 nextAllowedAt 是整机/自身截止的最大值，只代表时间条件下界。`scheduling.queue[]` 增加 `estimatedDurationMs/lane`；lane 为 short/long，15 秒及以内 short。每个 App 没有独立物理执行槽。

`multiapp` 场景会保留新的 12 秒/6 秒/0.3 秒策略；所有场景不清除现有冷却。不得用清空 Redis key、重建账号别名或重启服务代替该接口。

## mx-rig

当前不需要部署 mx-rig，也未修改其目录。可复用 `tests/acceptance.mjs` 作为独立 HTTP 验收入口，不假称已经注册成 Rig 的内置验收包。

为未来 Rig 的专用演示目标配置一个秘密文件（不提交 Git）：

```json
{
  "baseUrl": "http://127.0.0.1:18891",
  "testToken": "由 manage.sh test-token 取得的模拟专用凭证"
}
```

命令：`node tests/acceptance.mjs /protected/device-test.json /artifacts/device-report.json`。脚本先检查角色必须是 test，然后执行四个有写入的模拟场景。Rig 套件应声明 `writesData:true`、仅模拟目标、单次重试上限 1、专属实例，完成后读取报告并保留失败证据；不要并发运行两个整套场景。

此脚本采用独立报告格式，不是已验证的 Rig ingest schema；正式注册需要跟随届时 Rig 契约、用例目录、凭证注入与产物规范，不能直接把此 JSON 当作 Rig 标准报告导入。

## 安全与运维边界

- 无账户体系、细粒度 RBAC 或多租户。管理凭证相当于本中心管理员，不应共享给普通业务用户。
- Cookie 使用签名到期时间，退出只清本浏览器，不撤销已复制的会话；凭证泄漏需在停用本中心后轮换 bootstrap secret 并重启本中心 API。不能宣传为完整会话撤销系统。
- 已保存完整结果可能包含 xsec token，默认管理列表与事件投影不带这些字段，证据详情只向相应模式授权角色提供。对数据库备份与完整证据按敏感数据保护。
- 当前不提供自动清历史。配置独立卷监控与备份，设置合理磁盘水位，后续增加可审计保留策略。
- 执行器心跳过期会显示异常；手机不可达只依据显式 probe 或执行结果，不凭心跳推断手机在线。


## 十槽实验室接口（仅 sim）

- `GET /api/task-definitions?mode=sim`：返回 `{definitions,commands}`，包含任务全部历史和当前活跃指令；real 返回空目录。
- `POST /api/task-definitions?mode=sim`：`{code,name,appId,loop:"small"|"large",resumable?,expectedVersion,steps:[{code,repeat,commandVersion?,input?}]}`，返回 201。新代码 expectedVersion=0，后续等于现有最高版本；冲突 409。不修改旧版本。
- `POST /api/jobs?mode=sim`：`{key,definitionId,keyword?,target?,input?,priority?,deviceId?,rack?}`。定义保存时冻结指令快照，提交时再冻结计划，未绑定设备则由中心匹配；不支持 host 条件。相同 key/规范化参数重放，变更参数 409，活动队列 200 条后 429（精确重放仍可返回原任务）。
- `POST /api/loop-policy?mode=sim`：`{rack,revision,maxInsertions,maxDetourMs,windowMs,smallLimit,largeLimit,cooldownMinMs,cooldownMaxMs,commandDelayMs}`，全部时间为整数毫秒。默认值及边界见 [实验室说明](rack-lab-2026-10-10.md)。
- `POST /api/scenarios?mode=sim`：`{kind:"rack20",key}`，202。没有活动模拟任务/控制会话且十槽都空闲、未隔离、未排空、冷却到期才能开始；同 key 返回原 runId。保留历史、限额与循环配置。

这些写入在 real 模式拒绝；真实 Job 接口仍先执行原来的 confirmed 检查，未确认时可先返回 400。没有新增任意手机操作/ADB 转发接口。指令完成接口目前只在 worker 内部调用，不暴露无需执行身份的通用 webhook。

`GET state` 包含 definitions、commandDefinitions（所有历史）、loopPolicies、commands。PG 快照返回所有活动任务指令及另外最近 400 条终态指令，省略 receipt/lateEvidence；`GET jobs/:id` 返回该任务完整 Command/Receipt。`yielded` 父 Attempt 会完整返回，仍占用原设备。waiting 的检查点/次数/预算原因与实际领取使用同一规则。规则中“候选”仍需 worker 在事务中再核验。


## 平台目录 CRUD（007，仅 sim）

- `GET /api/command-definitions?mode=sim` 返回 `{commands,history}`：活跃最新版本与包括归档的历史。
- `POST /api/command-definitions?mode=sim` 接受 `{code,name,appId,action,effect,estimateMs,timeoutMs,inputSchema,outputSchema,bindings,mapping?,expectedVersion}`。`appId` 可为 null 表示通用；binding 为 `{kind:"poc"|"adb"|"custom",adapterId,operation}`，只允许逻辑引用。返回201；非法 Schema/字段返回400，版本冲突409。
- `DELETE /api/command-definitions/:id?mode=sim` 与 `DELETE /api/task-definitions/:id?mode=sim`：`id` 为完整版本 ID，须 URL 编码；JSON body `{expectedVersion}`，只归档最新活跃版本，返回200的新 tombstone。恢复时 POST 原可写字段及当前 tombstone 版本号，会追加活跃版本。
- POST/DELETE 同样要求认证、同站 Origin（请求提供时）和 JSON Content-Type；real 写入403。目录读取不领取设备或发送指令。

任务第一条 action 必须为 open；next 前必须 search。同一任务内所有指令属于目标平台或通用。步骤 input 可写字面值，或 `{target:{fromStep:1,path:["items",0,"goodsId"]}}`：fromStep 是展开后的零基索引，只读本次任务此前已验证的结果。输入预检在入队和每条指令派发前执行；空结果导致后续输入缺失时，模拟任务标记 failed 并保留前序回执，确认无在途指令才正常释放设备。错误完成身份/输出格式仍为 unknown＋隔离。完成结果含 `steps:[{stepIndex,code,commandVersion,result}]`，经任务详情读取。

指令归档阻止新模板引用，已有模板仍使用冻结版本；任务最新版本归档阻止其所有版本的新提交，已有 Job 及幂等重放保留。详见 [平台指令目录](platform-command-catalog-2026-10-13.md)。


## 工作台任务管理与调度目录（2026-10-14）

新增 `rule-definitions`、`strategy-definitions` 的 GET/POST/DELETE 版本化目录、`strategy-apply`、`workstation-demo`、`jobs/:id/assignment`、`jobs/:id/queue-cancel` 和 `devices/:id/sim-capabilities`。请求字段、版本校验、归档语义与默认策略行为见 [工作台 API 增量](workstation-strategies-2026-10-14.md#api-增量)。这些新增管理写接口仅在模拟域开放。读取页面/目录不会派发任务；人工指派不能迁移已领取任务。

迁移 `008_scheduling_strategies.sql` 只新增规则/策略表与种子，保留旧机架、任务、App 冷却和既有循环策略。已运行真实设备仍沿用原接口与授权边界。

## 账号池与策略 2.0（2026-10-15，V2-2）

- `GET /api/accounts?mode=`：账号列表（绑定设备、24 小时次数、在途、冷却/退避、最近信号、累计），以及信号类型字典 `signals`。不进入轮询的 `/api/state`。
- `POST /api/account-status`：`{id, status: active|limited|review|retired, reason, revision, confirmed?}`。版本不符返回 409；恢复为 `active` 需要 `confirmed:true`；`retired` 不能恢复；账号不存在返回 404。
- `POST /api/account-signal`：`{id, kind: captcha|rate-limited|logged-out|risk-warning, detail?}`。账号转 `review`，退避 10 分钟起、按近期信号翻倍、最长 24 小时。
- `POST /api/strategy-auto`：`{rack, revision, enabled, calmStrategyId, busyStrategyId, enterPressure, exitPressure, minDwellMs, maxSwitchesPerHour}`。要求 `exitPressure < enterPressure`、两个策略不同；启用时按当前压力立即应用对应策略。
- `POST /api/strategy-shadow`：`{rack, strategyId}`。只读，返回 `current` 与 `candidate` 两份规划摘要。
- `/api/state` 的 `scheduling.devices[].pacing`：每台设备的节奏解释（设备作用域与每个 App 的会话、账号作用域，含原语、来源和截止时间）。

账号接口：测试令牌只能操作模拟域，真实域只接受管理员令牌。自动切换与影子评估当前仅限模拟域（真实域返回 403）。迁移 `011_accounts.sql`、`012_pacing_rules.sql` 只新增数据。详见 [V2-2 节奏账本](v2-2-pacing-ledger-2026-10-15.md)。
