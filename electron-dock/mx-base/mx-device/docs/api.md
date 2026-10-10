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
| GET /health/live | API 进程存活，不检查外部设备 |
| GET /health/ready | 本中心数据库可用，不检查 Hub、手机或 mx-rig |

以上 mode 可按权限使用 sim / real，但场景只能 sim，probe 只能 real。没有任意 URL 转发或命令执行 API。

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

- `GET /api/task-definitions?mode=sim`：版本化定义及逻辑指令目录，`realEnabled:false` 明确当前边界。
- `POST /api/task-definitions?mode=sim`：`{code,name,appId,loop:"small"|"large",resumable?,expectedVersion,steps:[{code,repeat}]}`，返回 201。新代码 expectedVersion=0，后续等于现有最高版本；冲突 409。不修改旧版本。
- `POST /api/jobs?mode=sim`：`{key,definitionId,keyword?,target?,priority?,deviceId?,rack?}`。提交时冻结版本/指令，未绑定设备则由中心匹配；不支持 host 条件。相同 key/规范化参数重放，变更参数 409，活动队列 200 条后 429（精确重放仍可返回原任务）。
- `POST /api/loop-policy?mode=sim`：`{rack,revision,maxInsertions,maxDetourMs,windowMs,smallLimit,largeLimit,cooldownMinMs,cooldownMaxMs,commandDelayMs}`，全部时间为整数毫秒。默认值及边界见 [实验室说明](rack-lab-2026-10-10.md)。
- `POST /api/scenarios?mode=sim`：`{kind:"rack20",key}`，202。没有活动模拟任务/控制会话且十槽都空闲、未隔离、未排空、冷却到期才能开始；同 key 返回原 runId。保留历史、限额与循环配置。

这些写入在 real 模式拒绝；真实 Job 接口仍先执行原来的 confirmed 检查，未确认时可先返回 400。没有新增任意手机操作/ADB 转发接口。指令完成接口目前只在 worker 内部调用，不暴露无需执行身份的通用 webhook。

`GET state` 新增 definitions、loopPolicies、commands。PG 快照返回所有活动任务指令及另外最近 400 条终态指令，省略 receipt/lateEvidence；`GET jobs/:id` 返回该任务完整 Command/Receipt。`yielded` 父 Attempt 会完整返回，仍占用原设备。waiting 的检查点/次数/预算原因与实际领取使用同一规则。规则中“候选”仍需 worker 在事务中再核验。
