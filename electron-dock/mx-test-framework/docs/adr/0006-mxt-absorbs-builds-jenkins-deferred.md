# ADR-0006：MXT 吸收「构建」这个动作，Jenkins 暂不启用

状态：已接受（2026-09-01）
取代：[15 §5](../15-server-side-first-run.md#5-jenkins-的边界) 与
[17 §2](../17-one-console.md) 里"Jenkins 负责构建"的分工。
`mx-base` 保留，Jenkins 保持 `replicas: 0`。

## 背景

前几轮的结论是"Jenkins 构建、MXT 测试"，并据此建了 `electron-dock/mx-base`。
再往下核实之后，两个事实推翻了这个分工的前提。

**事实一：`mx-launcher` 的 Release Center 已经实现了，不是设计稿。**
`mx-launcher/server/src/modules/release/` 里有 controller 和 publisher。
[docs/17](../../../mx-launcher/docs/17-mx-h2i-release-center-update-system.md) 描述的能力
——制品 URL、digest、签名、平台、渠道、灰度、回滚——都已经在跑，
MX-H2I 客户端的热更新与全量更新链路建立在它上面。

更关键的是 doc 17 第 51 行：

> Internal evaluates Release Center plans, rollout rules, feature gates, **and E2E evidence**.

**发版链里本来就给测试结果留了插槽。** 这正是 [ADR-0001](0001-standalone-platform.md)
说的"需要门禁的人自己调 `/api/v1/runs/:id` 判断"。

**事实二：真正缺的能力只有一条。**
把三个系统摆在一起看，缺口小得多：

| 能力 | 谁已经有 |
| --- | --- |
| 制品存储、digest、签名、渠道、灰度、回滚 | mx-launcher Release Center ✅ |
| 定时、派发、能力匹配、产物上传、结果与历史 | MXT ✅ |
| 用例目录、drift、报告、脱敏分享 | MXT ✅ |
| **在 Windows / macOS 上执行一条命令** | ❌ |

而 MXT 的本地执行机**已经是**"在符合能力要求的机器上跑命令、上传产物、回报结果"。
它与构建 agent 的差别只有一个：产物是 JUnit 还是安装包。

## 决策

**给 MXT 加一个 `kind: build` 的作业类型，不启用 Jenkins。**

```
MXT build job（Windows 执行机）
    pnpm build:electron:exe  →  安装包 + sha256
        ↓
    发布给 mx-launcher Release Center
    （它已经会做 OSS 上传、签名、渠道、灰度）
        ↓
MXT test job（同一台机器，另一个作业）
    下载那个包 → 校验 → 跑 e2e → 结果入库
        ↓
Release Center 查 MXT 的 API 当 E2E evidence，自己决定发不发
```

三条边界，缺一不可：

1. **MXT 不碰 OSS 上传，不碰客户端更新推送。** 那是 Release Center 的职责，
   且在 MX-H2I 的用户路径上。MXT 交出的是"这个文件 + 它的 sha256"，到此为止。
2. **MXT 不做门禁。** 它回答"这次跑的结果是什么"，不回答"能不能发版"。
   Release Center 拉取结果自行判断——这是一个 HTTP 请求的事。
3. **依赖方向单向**：Release Center → 读 MXT。MXT 从不调用 Release Center 去触发发版。

### MXT 到此为止

这条线比"加什么"更重要，因为 [13 号文档](../13-platform-review-and-redesign.md)
最尖锐的那句批评就是冲这个来的——**"你把 CI 重写了一遍"**。

> MXT 做的是：**在符合能力要求的机器上跑一条命令，留下产物和结果。**
>
> MXT 不做：多阶段流水线 DSL（stages / parallel / when / input）、
> 扇出扇入、人工审批门、环境间的产物晋升、插件体系。

需要上面任何一条的时候，就是 Jenkins 或 Argo 该进来的时候，而不是在 MXT 里
长出一个更差的流水线引擎。

## 理由

**Jenkins 对当前范围没有不可取代之处。** 逐条核对：

| Jenkins 能力 | MXT 现状 | 补上的代价 | 不可取代？ |
| --- | --- | --- | --- |
| Windows / macOS 上执行 | 本地执行机 + 能力匹配 + 产物上传，**已有** | `kind: build`，约 1 天 | 否 |
| 定时 | cron 调度器 + Job 状态回收，**已有** | 0 | 否 |
| 凭据管理与日志脱敏 | `secretRefs` 只存不注入，**设计了没实现** | 约 1 天 | 否 |
| Webhook / 分支发现 | 无 | 半天 | 否 |
| 构建队列、能力路由 | 能力匹配 + claim 窗口，**已有** | 0 | 否 |
| **多阶段流水线 DSL** | 无 | **很大** | **是** ← 唯一一条 |
| 插件生态 | 无 | — | 与本场景无关 |

**唯一真正难复制的是流水线 DSL。而当前的流水线是三步**：
构建 → 发布给 Release Center → 通知。为三步引入一门 Groovy DSL 不成比例。

**代价那一侧是具体的。** 启用 Jenkins 意味着：一个 JVM 常驻服务、一条插件供应链
（每个插件都是一次可以读到 controller 全部凭据的代码执行）、一份 JCasC、
一块 PVC、一个"日常没人愿意打开"的运维 UI——**全部为了在一台机器上跑一条
`pnpm build:electron:exe`**。

**而且这会是第三个系统。** 目前已经有 Release Center 和 MXT 各自承担了一部分
CI 语义。第三个系统带来的不是能力，是三处都要维护的边界。
对一个人维护的内部平台，系统数量本身就是成本。

**对 MX-H2I 更是零收益。** 它的发版链已经在跑，构建产物已经进了 Release Center。
MXT 在那条链上要做的只有一件事：把测试结果放在 Release Center 能读到的地方。
不需要构建，更不需要一个新的 CI。

## 后果

- `mx-base` **保留**，但 Jenkins 保持 `replicas: 0`。镜像、JCasC、清单都已就绪，
  需要时 `manage.sh deploy` 即可启用。这是一个成本为零的期权，不是一个待办。
- `mx-base` 的定位从"CI"收窄为**共享设施的货架**：将来的镜像仓库、MinIO、
  GitOps 控制器仍然归它。ADR-0001 的边界推理不变。
- MXT 需要新增：`kind: build` 作业、构建产物上传与登记、`secretRefs` 的真实注入
  （现在只存不注入）、Webhook 触发。
- **`mxt_suites.kind` 必须现在就加**，哪怕只有 `test` 一个取值。
  等到有第二种作业时再加，会牵动已经落库的每一行。

## 什么时候启用 Jenkins

写死触发条件，避免"要不要上 Jenkins"变成每季度重开一次的争论：

1. 需要**多阶段 + 扇出扇入**的流水线（例如 4 分片并行后合并，且合并步骤本身有逻辑）
2. 需要**人工审批门**（有人点确认才继续）
3. **超过 3 个人**各自配置构建，需要独立的权限与审计面
4. 需要**多平台并行出包**（Windows + macOS + Linux 同时构建并汇总）

满足任意一条就启用。在那之前，把它留在货架上。

> 注意第 1 条与分片的区别：Playwright 的 `--shard` 是**一次执行内的并行**，
> MXT 建 N 个 run 再合并即可，不需要通用 DSL。
> 触发条件说的是**跨阶段**的扇出扇入。

## 被否决的方案

- **启用 Jenkins 只跑一个构建 job**：代价与收益严重不成比例，且引入第三个系统。
- **MXT 长出完整流水线引擎**：这正是 13 号文档批评的"把 CI 重写一遍"。
  三步的流水线不需要 DSL；真需要 DSL 时也不该是自研的。
- **MXT 直传 OSS 并触发客户端更新**：会把测试平台放到 MX-H2I 的用户更新路径上，
  违反每一版 ADR 都在守的那条约束。
- **MXT 做发版门禁**：[ADR-0001](0001-standalone-platform.md) 已否决，理由不变。
- **用 GitHub Actions 做构建**：服务器能出网，托管的 Windows runner 也确实省事。
  但上传制品要回内网 OSS，仍然需要自托管 runner 才能打通——省不掉那台机器，
  却多一套凭据和一个外部依赖。等真需要多平台并行出包时可以重新评估。
