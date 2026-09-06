# 25 · 实时执行与执行机自助接入

点了「执行」之后只看到「执行中，稍后刷新」，这是当前平台最刺眼的一处。
这份文档把它连同后面一串问题一起定掉：实时状态怎么来、任务在哪跑由谁选、
一台陌生机器怎么自助变成执行机、通道用什么、在线状态怎么算、宿主机还是容器。

结论先放这里，理由在下面：

| 问题 | 决策 |
| --- | --- |
| 实时状态 | 先有**事件**再谈通道。新增 `run_events`，runner 上报，服务端广播 |
| 浏览器通道 | **SSE**，不用 socket.io。零依赖、原生重连、断点续传 |
| Runner 通道 | **socket.io 值得做，但排在第五步**；HTTP claim 永久保留为兜底 |
| 多标签页归一 | 用 socket.io 的 **room**，不自己在 redis 里维护 socketId 集合 |
| 在线状态 | `last_seen_at` 派生，**不用 redis TTL** |
| Redis | 副本数变成 2 之前不引入。写死触发条件见 §8 |
| 执行机安装 | **宿主机进程**为主；Docker 是服务端的形态，不是客户端的备选 |
| 在哪跑 | 建任务时**显式三选一**：服务器静默 / 我这台电脑 / 指定执行机 |

## 1. 真正的缺口不是通道，是没有人上报

现在一次 run 只有两个可见时刻：`queued` 和 `:complete`。中间十分钟里，
服务端手上**一个字节的进度信息都没有**。

这一点值得说透，因为它决定了动工顺序：**今天就把 socket.io 接上，界面上也只会
实时地显示「执行中」三个字**。通道不产生信息。

所以分三层，从下往上做：

```
产生   Cypress reporter / runner 阶段打点  ──►  一行行 JSON 写到 stdout
传输   runner 解析 stdout → 批量 POST      ──►  run_events（落库，带 seq）
扩散   服务端 → 浏览器                      ──►  SSE，一个页面一条流
```

## 2. 浏览器通道：SSE

**决策：`GET /api/v1/runs/:runId/events`（SSE）。web 端不引入 socket.io。**

- `web/` 是零构建的原生 JS（见 `web/index.html`）。socket.io 的浏览器端要把一个
  压缩后几十 KB 的包 vendored 进仓库、跟着服务端版本一起升级；内网没有 CDN 可用。
  为了一条单向的进度流付这个价钱，不值。
- 浏览器方向的数据**本来就是单向的**：服务器 → 页面。点执行、取消、重跑走已有的
  REST。socket.io 的双向能力在这里没有消费者。
- `EventSource` 自带重连，并且带 `Last-Event-ID`——**刷新页面、切网、笔记本合盖之后
  接着上次的 seq 往下发**，正是这个场景需要的东西，而且是浏览器原生实现的。
- 它落在现有 `node:http` 路由上就是一个不结束的响应，鉴权直接复用
  `SESSION_COOKIE`（`server/core/http.mjs`），不需要第二套。

代价与对策，都不大但都要写下来：

| 代价 | 对策 |
| --- | --- |
| HTTP/1.1 同域 6 连接上限 | **一个页面只开一条流**，多个订阅在同一条流上用 `topic` 区分 |
| 反向代理会缓冲，进度变成一次性到达 | 响应头带 `X-Accel-Buffering: no`，每 15s 发一个注释帧保活 |
| 服务端每条流占一个连接 | 只在「执行中」的页面开流；run 结束服务端主动关闭，不靠客户端 |

## 3. Runner 通道：socket.io 值得，但不是第一步

现在 runner 是 15 秒一次的 claim 轮询（`bin/mxt-runner.mjs` 的 `POLL_IDLE_MS`）。
它能工作。换成长连接买到的是四样东西：

1. 派发延迟从「最多 15 秒」变成「不到 1 秒」——用户点执行，机器立刻动
2. 在线状态实时，不是「最近 50 秒内报到过」
3. 取消能立刻送达正在跑的机器（现在只能等它下次心跳）
4. 日志和步骤可以边跑边推，不必攒批

runner 是 Node CLI，给它加依赖**不影响浏览器**，这也是它比 web 端更适合 socket.io
的原因。

但两条硬约束：

- **HTTP claim 路径永久保留，不是过渡态。** 内网代理、公司 VPN、Windows 上做 TLS
  拦截的杀毒软件，都可能让 WebSocket 连不上。socket.io 自己会退化到 long-polling，
  但**派活这件事不能依赖「它一定连得上」**。连不上就退回轮询，功能少一点，不失效。
- **上报事件先走 HTTP 批量 POST**（每约 1 秒或攒够 20 条），复用现成的 run token
  鉴权。这条路先跑通，用户马上就能看见执行过程；之后再把 claim 换成 socket，
  是纯粹的延迟优化，不改变任何语义。

## 4. 多标签页：room 就是那张 map

问题问的是「用户开多个标签页时，怎么知道这些 socketID 属于同一个用户，
是用 redis 存一个对象 map 多个 socketIDs 吗」。

**不要自己存这张 map。** socket.io 的 room 就是它，而且是库在维护：

```js
socket.join(`user:${principal.id}`)   // 连接时
socket.join(`run:${runId}`)           // 订阅某次执行时
io.to(`run:${runId}`).emit('event', payload)
```

- 断开时自动移出，**不会留下僵尸**。手写 `redis: user:123 -> Set<socketId>` 的
  真正麻烦不是写，是进程被 `kill -9` 之后集合里那些永远不会被清掉的 id：你要么给每个
  id 单独设 TTL（那就退化成 §5 的 presence key，这张 map 也就没意义了），要么定期
  全扫。这个问题库已经解决过一次了。
- 「这个用户在线吗」= room 里有没有 socket。多副本时 `@socket.io/redis-adapter`
  让广播和 `io.in(room).fetchSockets()` 跨节点工作，**仍然不用自己写 map**。

顺带回答 SSE 那一侧：**多开三个标签就是三条流，各自订阅，不需要归一。**
状态一致性来自「事件是幂等的、带单调 seq 的」，不来自「连接是唯一的」。
想在标签页之间省一条连接可以用 `BroadcastChannel` 选主，但那是省资源，
不是正确性，现在不做。

## 5. 在线状态：用最近上报时间，不用 key 过期

**真相源是数据库里的 `runners.last_seen_at` 和 `status`**（两列都已存在）。

```
online  =  now - lastSeenAt < RUNNER_ONLINE_MS    // 90s（server/runner/placement.mjs）
```

**阈值为什么是 90 秒而不是更紧：** 空闲的执行机每 15 秒轮询一次要活干，那次轮询就是
报到；但**正在跑测试**的执行机只每 60 秒续一次租。按空闲的节奏定阈值，会把所有真正
在干活的机器标成离线——正好搞反。等第五步换成 socket，这个数字跟着变小。

（续租现在也会顺手 `touchRunner`。在此之前只有空闲轮询会，于是一台机器跑二十分钟的
测试，其中十九分钟在界面上是「离线」。）

派生，不存。为什么不用 redis 的 TTL key：

- 服务重启后 TTL key 全没了 → 所有执行机显示离线。**而这恰好就是事实**：连接确实断了。
  也就是说 redis 在这里并没有比数据库多给什么。
- 反过来，机器要是还活着，20 秒后它自己就会重新报到，状态自动纠正。
- 用数据库列，重启后旧值还在，最坏情况是**最多 50 秒的陈旧**，然后被真相覆盖。
  对一个执行机列表，50 秒的陈旧完全可以接受。
- socket 的 `disconnect` 事件立刻写 `status=offline`，超时阈值只是兜底。

代价是每台机器每 20 秒一次 `UPDATE`。几十台机器的量级下，一天几万次单行更新，
在 PostgreSQL 面前不构成任何问题。**上千台再来谈 redis。**

## 6. 执行机自助接入

### 6.1 先说清楚浏览器做不到什么

「点击执行后下载必要的组件到本机器上固定位置作为 runner」——这里有一个必须挑明的
限制：**浏览器不能静默下载并执行程序。** 任何看起来像「点一下就装好」的产品，
实际都是下面两条之一：

- (a) 给你一条命令，你粘到终端里；
- (b) 下载一个安装包，你双击，并过一次系统的签名/权限提示。

MXT 以 (a) 为主，(b) 为辅（给不习惯终端的测试同学）。**不假装能做到第三种。**

接入码的三条规则，都是因为那条命令最终会躺在 shell history、聊天记录和便利贴上：

1. **15 分钟**——够找个终端，不够留到明天
2. **只能用一次**——`used_at IS NULL` 写在 UPDATE 的 WHERE 里，两台机器同时兑换只有一台赢
3. **机器不能自称是谁的**——归属取自签发这个码的浏览器会话，请求体里的 `ownerPrincipal` 根本不读

### 6.2 流程

```
执行机页面 →「把这台电脑变成执行机」
    │
    ├─ 服务端签发一次性 enrollment code（15 分钟，绑定当前登录用户）
    │
    ├─ 页面按浏览器 UA 显示对应命令，一键复制：
    │     Windows   powershell -c "$env:MXT_CODE='xxx'; irm <平台>/install.ps1 | iex"
    │     macOS     curl -fsSL <平台>/install.sh | MXT_CODE=xxx sh
    │
    ├─ 脚本：校验 Node → 下载 runner（一个 .mjs 文件）→ 装到固定目录
    │        → 用 code 换 runner token → 注册（上报 os/arch/能力）→ 起 watch
    │
    └─ 服务端看到注册 → 页面上那张卡片自己变成「已连接：DESKTOP-XXX」→ 列表刷新
```

**页面自己会变**，这是这套流程值得做的地方：人粘完命令回到浏览器，不需要刷新，
不需要猜有没有成功。

**这里是轮询，不是 SSE**，和 §2 的结论有意背离，值得点名：卡片问的是**一件事**、
问**最多十五分钟**、而且**有人正看着**，机器一出现或卡片一关就停。为这个再开一条
实时通道，成本大于收益。§2 的理由是「一条会跑十分钟、事件源源不断的流」，
这里两条都不成立。

**下载的是什么：** `bin/mxt-runner.mjs` 一个文件，因为它只 import `node:` 内置模块。
「装执行机」因此是一次下载，而不是包管理器 + 锁文件 + 构建。三个 install 相关的
路由都不鉴权，也必须不鉴权——那台机器此刻还没有任何凭据，**命令里的 code 就是凭据**。

**脚本不替你装 Node。** 一个不问一声就往别人电脑上拉语言运行时的脚本，不该有人敢粘；
而它避免的那个失败（`node: command not found`）一句话能说清，一条命令能解决。

### 6.3 装在哪

| 平台 | 目录 | 要管理员吗 |
| --- | --- | --- |
| Windows | `%LOCALAPPDATA%\MXT\runner` | 不要 |
| macOS | `~/Library/Application Support/MXT/runner` | 不要 |
| Linux | `~/.local/share/mxt/runner` | 不要 |

凭据仍在 `~/.mxt/runner.json`（现有实现），权限 `0600`。
**刻意避开需要管理员的位置**：一个内部工具让人第一步就输管理员密码，接入率会腰斩。

### 6.4 留还是删，权限给到哪一步

- 默认**留**。留着这台机器就一直在 MXT admin 的执行机列表里，之后建任务可以直接
  点名派给它——这正是问题里期望的效果。
- `mxt-runner uninstall` 注销并删凭据；加 `--purge` 连检出和产物缓存一起删。
  界面上执行机那一行也有「移除」（自己的机器自己能删，别人的要管理员）。
  一个**接进来容易、撤出来麻烦**的工具，人们一开始就不会接。
- **第一次接入不申请开机自启。** 前台进程，关窗口就断。用户明确要常驻时，
  再执行 `mxt-runner install-service`（Windows 走 [24](24-windows-local-service.md)
  已经趟过的服务化路子，macOS 走 launchd）。
  理由很简单：**在别人的电脑上装一个开机自启的服务，是需要被信任的行为**，
  把它放在第二步、由人主动触发，而不是混在第一次接入里一起要掉。

## 7. 宿主机还是 Docker

问题是「两套方案，docker 作为保底」。这里要先纠一个前提：**服务端 runner 和
客户端 runner 不是同一个问题的两个答案**，它们跑的根本不是同一类东西。

| | 服务端 runner | 客户端 runner |
| --- | --- | --- |
| 跑什么 | 无头 web e2e | **有头** web e2e、Electron 桌面端 |
| 形态 | 容器（k8s Job），**已实现** | 宿主机进程 |
| 为什么不能换 | RHEL 裸机装浏览器依赖是坑（[11](11-runner-environments.md)） | 容器里没有宿主的桌面 |

客户端不能用 Docker，四条具体原因：

1. **Windows/macOS 上的 Docker 跑的是 Linux 容器。** 被测对象是 `.exe` 和 `.dmg`，
   装不进去也起不来。这一条单独就否掉了桌面端。
2. **有头浏览器要显示器。** 容器里只能 Xvfb 虚拟屏——那和服务端无头没有区别，
   那还不如让服务器跑。客户端的价值恰恰是**真实的机器、真实的屏幕、真实的缩放与输入法**。
3. **Docker Desktop 在企业里有授权门槛，装它本身要管理员权限。** 目标是「任何一台
   机器知道地址就能接进来」，多一个前置就少一半人。
4. **宿主权限问题是真的。** 容器要访问 USB、摄像头、剪贴板、宿主网络（比如
   MX-H2I 的 WireGuard 隧道）都得额外开洞，开完隔离性也就没了——那时候用容器
   已经不比直接装更规范。

**结论：客户端 = 宿主机进程。需要纯净隔离环境时，用的是服务端那条容器路，
而不是在客户端上再套一层容器。**

Docker 在客户端唯一站得住的位置：**Linux 桌面**的自助接入，发行版千奇百怪时
用 `cypress/included` 镜像跑 web 轨。列为可选项，不作为第一版的兜底方案。

## 8. Redis 什么时候真的要加

照 [ADR-0006](adr/0006-mxt-absorbs-builds-jenkins-deferred.md) 的写法，把条件写死，
满足任意一条才动手：

1. `server` 的 `replicas > 1`（现在是 1，见 `deploy/k8s/internal/30-server.yaml`）；或
2. 执行机数量 > 200；或
3. 需要跨进程的锁或限流（例如「同一 suite 全局并发不超过 N」）

在此之前不加。**多一个 redis，就是多一个会挂、会 OOM、会让人在半夜排查的组件，
而它现在不解决任何已经存在的问题。** 真加的时候，第一个用途是 socket.io 的
adapter，不是自己写的那张 map。

## 9. 事件模型

新增一张表，只有一张：

```sql
run_events (
  run_id   text not null,
  seq      integer not null,          -- 服务端分配，每个 run 独立单调
  at       timestamptz not null,
  kind     text not null,
  payload  jsonb not null,
  primary key (run_id, seq)
)
```

`kind` 是**有限集合**，不接受自定义：

| kind | 含义 |
| --- | --- |
| `run.claimed` | 哪台机器接走了 |
| `stage` | `checkout` / `install` / `launch` / `execute` / `upload` |
| `case.started` / `case.finished` | 用例边界，带 caseId |
| `step` | 用例内一步，带 seq / label / status |
| `log` | 一行输出，已脱敏 |
| `run.finished` | 收尾，之后服务端关闭这条 SSE |

四条规则：

1. **seq 由服务端分配**，SSE 的 `id:` 就是它，重连靠 `Last-Event-ID` 续传。
   让 runner 分配 seq，就等于让「网络重传」和「进程重启」变成乱序的来源。
2. **每个 run 最多 5000 条**，超出丢弃并补一条 `log`（truncated）。
   没有上限，就等于给每个死循环的用例发了一张往数据库里写字的许可证。
3. **落库，不是只广播。** 刷新页面就该看到已经发生的过程；跑完之后回看历史 run
   也该有这条时间轴。只广播不落库，会把「我刚才没盯着」变成「我永远看不到」。
4. **过 `server/core/redact.mjs` 再入库**，和 summary 一样。runner 不被信任。

保留期跟产物一致，30 天，随 `manage.sh clean` 一起删。

## 10. Cypress 侧怎么产生步骤（罗盘）

**用例代码只往 stdout 写一行 JSON，不知道 MXT 的地址，也不需要 token。**

```
##MXT## {"kind":"step","case":"LP-FE-AUTH-001","seq":3,"label":"提交登录表单"}
```

- 罗盘业务代码不动。加一个 support 文件（或平台提供 `@qpjoy/mxt-cypress-reporter`），
  挂 Cypress 的 `test:before:run` / `test:after:run`，以及已有的 `step()` 包装。
- **runner 解析 stdout 的这些行**，转成事件上报。服务端 k8s Job 里同样 `tee` 一份。
- 这个接口之所以选 stdout 而不是让用例进程直接 POST：用例进程可能没有网络、
  可能被沙箱限制、可能中途崩溃——**而 stdout 是不会坏的那一根管子**，
  它崩了 runner 也还在，最后那几行照样收得到。
- **没接 reporter 的 suite 不会退化成一片空白**：runner 至少能报 `stage`
  （检出 / 装依赖 / 启动 / 执行 / 上传）和进程退出码，界面上是五段进度，
  而不是「执行中，稍后刷新」。

## 11. 界面：把状态流转画出来

- run 详情页顶部换成一条**执行流水**：认领 → 检出 → 装依赖 → 启动 → 执行 → 收产物 → 归档。
  当前阶段脉冲发光，已完成的连线填充，失败的那一段变红并且**停在那里**——
  一眼看出死在哪个环节，而不是翻日志。
- 执行中：右侧是用例列表，跑到哪条哪条高亮，步骤逐条追加进去。
- 概览页加一张**当前在跑什么**的实时卡片：哪台机器、第几条用例、已经跑了多久。
- 明确不做的：**不做实时录屏推流**（带宽和隐私都不划算，录像跑完再看）；
  **不把控制台日志瀑布作为主视图**——那正是 Jenkins 让人看不懂的原因，日志折叠在
  「详细」里。
- 配色和组件一律用 neon-void 的 token，**不新开调色板**。

## 12. 服务端轨默认不录像

问题里说得很清楚：服务器主要看通过率和速度，不要产出大量视频。写进默认值：

- 服务端轨：`MXT_RECORD_VIDEO=0`；执行机轨：`MXT_RECORD_VIDEO=1`。
- **Cypress 的套件不用改任何配置**：平台同时注入 `CYPRESS_VIDEO=false`，
  这是 Cypress 自己就认的变量。Playwright 没有等价的环境变量（录像是配置项），
  在意的套件自己读 `MXT_RECORD_VIDEO`。
- 界面上在选「服务器静默跑」时直接写明「不录像；要看回放请用执行机跑」，
  而不是让人跑完之后才发现没有。

## 13. 建任务时选「在哪跑」

现在 `newTaskDialog`（`web/assets/app.js`）里没有这个选项，跑在哪由 `suite.surface`
隐式决定。改成显式三选一：

落库的取值只有三个：

| `runsOn` | 行为 |
| --- | --- |
| `server` | 平台自己的容量：k8s Job，或注册为 `kind: server` 的机器。不录像 |
| `any-runner` | 任何在线且能力匹配的执行机，谁先空出来谁跑 |
| `pinned-runner` | 只有 `runnerId` 这一台能认领 |

界面上是四个选项，因为**「我的这台电脑」是个快捷方式，不是第四种去处**：
它解析成当前用户名下、在线、能跑这条套件的那台机器，存成 `pinned-runner`。
理由是**任务要活很久**：凌晨两点触发的定时任务，「谁在这个浏览器前面」不是调度器
能执行的语义，任务记录必须点出机器的名字。代价是这台机器重装后 id 变了任务会失效——
但它是**响亮地失效**（等待执行机 → 已过期），而不是悄悄跑到别的机器上。

一台都没有时不报错，而是就地展开 §6.2 的接入引导。

三条在**选的那一刻**就拒绝的组合，而不是等十二个小时后过期：

1. 桌面端套件 + `server`——服务器上没有 Windows，也没有可以启动的安装包
2. `pinned-runner` 但没给机器——那不是「指定」，是悄悄变回「任意」
3. 指定了一台跑不了这条套件的机器——错误里直接列出它注册时上报的能力

**个人电脑不会被派到 `server` 的活。** 但注册为 `kind: server` 的机器会——
那是团队特意常开的机器，也正是没有 k8s 的部署形态下无头任务唯一的跑法
（[24](24-windows-local-service.md) 的本地服务版靠的就是这条）。`mxt-runner register --kind server`。

## 14. 落地顺序

每一步都能单独验收，前一步不通不做后一步。

| 步骤 | 内容 | 出口标准 | 新依赖 |
| --- | --- | --- | --- |
| **A** ✅ | `run_events` + 上报接口 + SSE + 前端流水条 | 服务端跑罗盘 web，界面上七个阶段依次点亮，不刷新 | 无 |
| **B** ✅ | 建任务的「在哪跑」+ 服务端不录像 | 同一条 suite 能分别派到服务器和自己的机器 | 无 |
| **C** ✅ | enrollment code + install 脚本 + 卡片自动变绿 | 一台干净的 Windows，粘一条命令，30 秒内出现在执行机列表 | 无 |
| **D** | Cypress reporter，步骤级实时 | 罗盘 23 条用例，跑到哪条哪条亮，步骤逐条追加 | 无 |
| **E** | socket.io 替换 claim 轮询 | 点执行到机器开跑 < 1 秒；拔网线 30 秒内标离线 | `socket.io` |
| **F** | Linux 桌面的容器化 runner | 可选，不阻塞 | — |

**A 到 D 一个新依赖都不需要**，而它们覆盖了问题里绝大部分「看不到执行过程」的痛。
socket.io 排在 E，是因为它优化的是延迟，不是可见性——可见性缺的是事件，不是通道。

## 15. A 已落地（2026-09-02）

本机实跑验证过的部分，代码已经在仓库里：

| 落点 | 文件 |
| --- | --- |
| 事件表 | `migrations/013_run_events.sql`（`mxt_run_events`，seq 由服务端分配） |
| 归一、脱敏、上限、总线 | `server/events/run-events.mjs` |
| 上报接口 | `POST /runner/v1/runs/:runId/events`（run 作用域鉴权，一批最多 200 条） |
| 浏览器流 | `GET /api/v1/runs/:runId/events`（SSE，支持 `Last-Event-ID` 续传） |
| 执行机上报 | `bin/mxt-runner.mjs`：阶段打点 + 解析 stdout 的 `##MXT##` 行，每秒批量上报 |
| 服务端轨上报 | `server/runner/dispatcher.mjs`：容器脚本里的 `stage` 函数，派发时补 `run.claimed` |
| 界面 | `web/assets/app.js` 的执行流水与实时用例列表，`app.css` 的 `.mxt-flow` |

实跑确认的三件事：

1. 用例状态、通过/失败计数、步骤在页面上**边跑边变**，不刷新页面。
2. 跑完的一瞬间服务端主动关流，页面自己切到最终结果视图——不是等下一次心跳。
3. 没接 reporter 的 suite 仍然有七段流水：认领、检出、装依赖走完，「启动」这类
   不适用的阶段显示为灰色跳过，而不是一直停在待办。

## 15b. B 已落地（2026-09-02）

| 落点 | 文件 |
| --- | --- |
| 去处的唯一判定 | `server/runner/placement.mjs`（默认值、状态、认领窗口、拒绝理由、在线阈值） |
| 落库 | `migrations/014_runs_on.sql`（存量行按 suite 的 `runner_kind` 回填，行为不变） |
| 认领规则 | 两个 store 的 `claimRun`：`server` 只给 `kind: server`，钉住的只给那一台 |
| 录像开关 | `runnerEnv` 注入 `MXT_RECORD_VIDEO`，Cypress 再加 `CYPRESS_VIDEO` |
| 在线状态 | `GET /api/v1/runners` 现算 `online` / `mine`，续租也会 `touchRunner` |
| 界面 | 建任务的「在哪跑」四选一、任务列表的「在哪跑」列、执行机列表的在线徽标 |

实跑确认：桌面端套件选服务器会当场被拒绝并说明原因；钉住的 run 只有那台机器能认领，
换一台返回 204；服务端轨的 claim 响应里 `MXT_RECORD_VIDEO=0`、`CYPRESS_VIDEO=false`。

## 15c. C 已落地（2026-09-02）

| 落点 | 文件 |
| --- | --- |
| 一次性接入码 | `migrations/015_runner_enrollments.sql`，只存 sha256 |
| 签发 / 兑换 / 查状态 | `POST /api/v1/runners:enroll`、`POST /runner/v1/runners:enroll`（唯一另一条无鉴权写路由）、`GET /api/v1/enrollments/:id` |
| 安装脚本 | `GET /install.ps1`、`GET /install.sh`、`GET /install/mxt-runner.mjs`，地址取自请求本身 |
| CLI | `mxt-runner enroll` / `uninstall` |
| 撤出 | `DELETE /api/v1/runners/:id`（自己的机器自己能删） |
| 界面 | 执行机页的接入卡片（OS 切换、复制、自动变绿）、在线徽标、移除按钮 |

**命令里的地址取自请求的 Host，不取配置**：人正在这个地址上看这个页面、从那台机器上看，
所以那个地址在那台机器上一定解析得通；`MXT_PUBLIC_URL` 只是 Host 不可信时的兜底。
Host 会先过一遍严格的主机名校验再拼进命令里——它最终会被粘进别人的终端，
**不像样的值是拒绝，不是转义**。

实跑验证：在**这台真实的 Windows** 上跑了服务端生成的 `install.ps1` 全程——下载执行机、
用码注册、出现在列表里。过程中抓到一个只有真跑才会暴露的 bug：PowerShell 会把
`node -p 'x.split(".")[0]'` 里层的双引号吃掉，node 收到 `split(.)` 直接语法错误，
于是**每一台 Windows 都会被判定成「Node 版本过低」**。改成 `parseInt(process.versions.node)`，
不带嵌套引号。

还没做的（按 §14 的顺序）：D 的 Cypress reporter、E 的 socket.io。
**这两步都不改上面三节已经落地的契约。**

## 15d. 用例筛选与删除应用（2026-09-03）

两件在本机跑通整套流程时顺手做掉的事。

### 只跑其中几条

`MXT_CASE_FILTER` 从 [04](04-runner-contract.md) 写下的第一天就在契约里，**代码里一处
都没实现**。现在实现了，而且对罗盘是真生效的——`e2e-local.mjs` 会把环境透传给
`e2e-run.mjs`，后者认 `E2E_SPEC`，所以**罗盘一行不用改**。

| 落点 | 文件 |
| --- | --- |
| 解析、翻译、拒绝 | `server/ingest/case-filter.mjs` |
| 落库 | `migrations/016_case_filter.sql`（task 和 run 各一列） |
| 下发 | `runnerEnv` 注入 `MXT_CASE_FILTER` + `E2E_SPEC` |
| 界面 | 失败用例上的「只重跑这条」、建任务时的「只跑其中几条」 |

三个判断：

1. **Case ID 由平台翻成 spec 路径。** 引擎只认文件，而 ID 到文件的映射只有目录知道。
2. **翻不出来就拒绝**，不是跑全量。目录里没有这个 ID、或者这条用例还没有 spec
   （「已登记、待实现」），都在建任务那一刻报错。一个悄悄忽略筛选、把整套跑完的 run，
   比报错糟糕得多。
3. **筛选跑的覆盖率按筛选范围算。** 否则重跑一条用例会把另外 22 条报成「登记了没跑到」，
   `notRun` 这个信号第一次被用就废了。

实跑抓到的第三点的续集：罗盘的 summary **自带全量 23 条的对账结果**，于是被筛掉的 19
条一开始被平台标成了 `unmapped`（「目录里没有这个 ID」）——正好说反了。现在区分成两类：
**在目录里但不在本次范围内**的直接不计入，只在 `catalog.outOfScope` 里留个数；
`unmapped` 仍然只表示「跑了一条目录里没有的用例」。

还有一条只有真跑才知道的事实：**按 Case ID 筛选，跑的是整个 spec 文件。** Cypress
没法只跑文件里的一个 test，所以同文件的兄弟用例也在本次范围内，平台把它们算进分母。

### 删除应用

`DELETE /api/v1/apps/:app`，admin 限定。**有执行记录时默认拒绝**，要加 `?force=true`——
这是平台上唯一会连历史一起删掉的操作，而「我想删的是另一个」没有撤销键。产物在磁盘上，
没有外键够得着，所以路由拿到 run id 列表之后自己去删。

## 15e. 第一次真派 k8s Job 抓到的三个 bug（2026-09-03）

平台部署到 k8s 之后第一次真正派发 Job，三个只有真跑才会暴露的问题：

1. **容器脚本依赖 `curl`，而 `cypress/included` 里没有。** 取密钥和**回报结果**都走
   curl，于是测试跑完了、结果递不回来，run 一直挂在「执行中」直到租约超时。
   改成用 node：**平台在这个镜像里跑的就是 JavaScript，node 一定在，curl 不一定。**
   新增 `/tmp/mxt-api.js` 一个 helper 承担全部回调。
2. **嵌套两层的转义。** 容器脚本是「写在 JS 模板字符串里的 shell，里面又用 heredoc 写
   JS」。嵌入的源码里 `
` 被外层模板吃成了真换行；而 `/tmp/*.js` 旁边没有
   package.json，node 按 CommonJS 解析，**顶层 `await` 直接是语法错误**。两个都要等
   容器跑起来才会发现。现在有测试把每个内嵌脚本按容器的解析方式跑一遍
   （`new vm.Script`），加上一条「不许出现 `curl -`」。
3. **私有仓库的凭据是条死路。** `MXT_GIT_TOKEN_SECRET` 只在 config 里被读，
   **从来没传进 Deployment**，而且 Job 找的键名和 `manage.sh` 写进 Secret 的键名对不上。
   现在默认就指向平台自己的 Secret：`.env.internal` 里加一行 `MXT_GIT_TOKEN=` 就够了。

顺带补上问题里问的两件事：

- **执行过程的输出**：容器的 `mxt-exec.js` 现在把子进程的 stdout/stderr 边跑边转成
  `log` 事件。三道闸：**实时 400 行的预算**（防止进度条刷屏变成几千行数据库写入）、
  **最后 60 行的环形缓冲**（命令失败时无论预算是否用完都送出去，因为末尾才是原因）、
  **每秒一批**。`##MXT##` 标记行不占预算。
- **失败原因显示全**：流水条上的节点只放得下一个标签，失败时下面单独给一条完整原因；
  「详细输出」面板对**已结束的 run 也显示**——最想看日志的时刻正是它失败之后。

## 16. 不变的东西

- [ADR-0006](adr/0006-mxt-absorbs-builds-jenkins-deferred.md) 的 Jenkins 条件不受影响。
  实时通道与自助接入反而让 MXT **更不需要** Jenkins：Jenkins 的 agent 模型解决的正是
  这里的派发问题，而我们只要它的一小部分。
- [04](04-runner-contract.md) 的 runner 契约不变。事件是**增量的旁路**，
  `summary.json` 仍然是判定的唯一依据——一个只写 summary、什么进度都不报的 runner，
  今天怎么接入，明天还怎么接入。
- 不改 mx-launcher 任何代码，不碰 MX-H2I 的联网与登录路径。
