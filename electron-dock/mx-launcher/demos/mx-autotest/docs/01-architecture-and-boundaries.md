# 01 · 架构与边界

> 状态：提议。拓扑、命令名称和资源名称是目标设计，需由后续实现与环境验证确认。

## 总体结构

    ┌────────────────────────────────────────────────────────────┐
    │ Internal：应用注册、身份、策略与配置真相源                │
    │   mx-launcher public contracts / user-center / network     │
    └───────────────────────┬────────────────────────────────────┘
                            │ 稳定 API；只读配置与身份校验
    ┌───────────────────────▼────────────────────────────────────┐
    │ mx-autotest：standalone launcher 桌面应用                  │
    │   项目工作台 · 任务编排 · 报告查看 · 本地 runner 管理      │
    │   MX-H2I 未打开时可独立运行；两者可同时运行                │
    └───────────────┬───────────────────────────────┬────────────┘
                    │ REST / 按需 SSE                │ 本地执行
    ┌───────────────▼──────────────────────┐   ┌────▼──────────────┐
    │ mx-auto-server，独立 K8s namespace   │   │ Desktop Runner    │
    │ API + bounded scheduler              │   │ Electron / GUI    │
    │ migration Job + PostgreSQL           │   │ 官方工具链缓存    │
    │ artifact store + runner Jobs         │   └───────────────────┘
    └───────────────┬──────────────────────┘
                    │ K8s Job
             ┌──────▼────────┐
             │ Server Runner │
             │ Web/API/load  │
             └───────────────┘

## Standalone launcher 合同

MX Autotest 与 demos/luopan 一样作为 standalone launcher 应用注册。这里的“独立”至少包含：

- 安装、启动和退出不依赖 MX-H2I 窗口或业务进程处于运行状态；
- MX Autotest 与 MX-H2I 同时打开时，端口、窗口、协议、缓存目录和本地服务实例不冲突；
- 账号登录走 mx-launcher 的稳定身份合同，不复制用户表，不保存用户口令；
- 通用联网、权限和用户能力通过 launcher 已公开的能力使用，不绕过或重写其实现；
- MX Autotest 自身升级或故障不能触发 MX-H2I 重启。

`mx-autotest` 的 enabled ProductNetwork 必须拥有全局唯一的 service VIP；不能复制
MX-H2I、Luopan 或任何 embed/standalone 产品的 `/32`。Launcher 当前代码在 upsert
和 builtin save 前预检，并由 PostgreSQL IPv4 CHECK 与 enabled-only partial unique index 处理并发
写；索引按 IPv4 四段数值比较，历史前导零别名无法绕过。disabled 冲突记录在启用时
仍会被拒绝；enabled VIP 缺失或越界会让 migration fail closed。该约束只有在目标环境
应用对应 migration 且历史冲突预检成功后才生效，不能把仓库中的实现状态写成线上已验收。

这不意味着把 mx-auto-server 放进 mx-launcher 的进程或 deployment。桌面集成与服务部署是两条独立边界。

## Internal 是唯一配置真相源

这里的“真相源”同时约束操作入口和持久化责任：组织级、跨应用的配置必须由 Internal 管理；Project、Suite、Task 等测试领域对象虽然由 mx-auto-server 的独立数据库持久化，但只能通过 Internal 授权的服务合同和操作面创建或修改。桌面应用只是客户端和本机 runner，不拥有另一份组织配置。

这并不要求 mx-auto-server 与 launcher 共库。Internal 是操作面与配置权威，mx-auto-server 是测试领域数据服务；二者通过受版本管理的合同连接。

| 配置 | 权威位置 | 本地行为 |
| --- | --- | --- |
| 应用注册、可见性、入口 | Internal | 可缓存，带版本与过期时间 |
| 用户身份和组织信息 | Internal identity contract | 只持有短期会话，不复制账号 |
| audience、服务地址、策略 | Internal | 本地不得永久覆盖生产值 |
| 项目、套件、任务、目录策略 | Internal 授权的 mx-auto-server | 独立持久化；所有组织级修改经 Internal 操作面 |
| run、case result、artifact index | mx-auto-server | 执行事实，不允许桌面离线篡改 |
| runner 本机路径、缓存容量 | 本机设置 | 只影响该 runner，不成为组织配置 |
| Domestic 用户、DNS、网络状态 | launcher 现有控制面 | MX Autotest 不写、不迁移、不接管 |

离线缓存可以让桌面 UI 展示最近项目或已下载证据，但不得在无法确认权限时创建远程任务、修改组织配置或伪造登录成功。

## 登录与授权边界

目标流程：

1. mx-autotest 向 launcher 身份合同请求 audience 为 mx-autotest 的用户会话。
2. mx-auto-server 通过 Internal introspection 校验不透明 token；短 TTL 正向缓存与 3 秒失效负缓存降低重复流量，同 token 并发只发起一次校验。introspection 每 socket 来源默认 6 次/10 秒、2 并发，全局 emergency ceiling 为 30 次/10 秒、8 并发；公开密码登录按 socket 来源与用户名 digest 限制为 3 次/10 秒、1 并发，全局为 10 次/10 秒、4 并发。单攻击来源先被局部截断，不会饿死其他来源；多来源洪泛仍被全局边界 429/503 截断。合法登录随后的 introspection 使用独立预算；上游网络错误/5xx 不缓存为失效身份。来源只取 socket remoteAddress，不信任 X-Forwarded-For；单节点 NodePort 用 externalTrafficPolicy Local 保留 peer，不硬编码 CIDR。
3. mx-auto-server 将 principal 映射到自己的项目角色：viewer、operator、maintainer、admin。
4. launcher 回答“这个人是谁”，mx-auto-server 回答“这个人可以操作哪个测试项目”。
5. runner 使用独立 runner token 认领任务，并为单次 run 换取作用域受限、结束即失效的 run token。

严禁：

- 把 gateway header 当作最终授权；
- 把 launcher token 写入日志、报告或测试产物；
- 让 runner token 读取任意项目或任意历史 run；
- 让 mx-auto-server 写 launcher 用户表或共享其数据库；
- 为部署 mx-auto-server 而修改或滚动 Internal / Domestic deployment。

Launcher 暂时不可达时，新的用户登录和需要重新鉴权的敏感操作应明确失败；已认领的 run 继续执行并使用其短期 run token 回报。这是降级，不是绕过认证。

## mx-auto-server 的独立 K8s 拓扑

建议第一阶段保持少而清晰：

| 工作负载 | 责任 | 隔离要求 |
| --- | --- | --- |
| mx-auto-server Deployment | API、归一、目录、有限调度器、按需事件 | 初期单副本，避免定时重复触发 |
| migration Job | checksum migration，成功后才滚动 API | 每次部署重建；失败即停止 |
| PostgreSQL StatefulSet | 项目、配置、任务、run、目录与索引 | 独立实例和 Retain PVC |
| artifact PVC / store | JUnit、sidecar、报告、视频、trace、日志 | 独立容量、配额与保留策略 |
| runner Job | Web / API / load 等无头执行 | 独立 ServiceAccount、资源限额、无平台数据库权限 |
| Desktop Runner | Electron 与真实桌面执行 | 在用户机器运行，不进入 K8s |

namespace、Secret、PVC、ServiceAccount 和 NetworkPolicy 均归 mx-auto-server 自己所有。可以与 launcher 使用同一物理集群和通用 ingress / DNS 能力，但不能共享数据库、PVC、应用 Secret、hostNetwork、hostPort 或 Docker socket。

## 控制面与数据面

### 控制面

- Project / Catalog / Suite / Task 配置；
- 手动、一次性、有限 cron 调度；
- runner 能力匹配与租约；
- run 状态归一；
- 权限、审计、通知与报告索引。

### 执行数据面

- K8s Job 或 Desktop Runner；
- 固定版本工具链；
- 被测源码和测试源码的不可变 checkout；
- JUnit XML、rich sidecar 和引擎原生证据；
- 分片、重试和资源消耗。

runner 永远不直连平台数据库。它只用 run token 访问当前 run 的事件、产物和完成接口。测试代码被视为不可信工作负载。

## 调度的刻意上限

第一阶段 mx-auto-server 只实现：

- manual：人工触发；
- once：指定时间一次；
- cron：有限重复任务；
- webhook / API：由外部系统触发；
- 能力匹配、并发配额、超时和取消。

它不实现通用 stages、任意 fan-out/fan-in DSL、审批门、环境晋升和插件市场。需要这些能力时，MX Autotest 作为质量控制面与 Argo、GitLab CI、GitHub Actions 或 Jenkins 集成，而不是在内部复制它们。

## 部署和迁移合同

目标是一条入口脚本提供：

- plan / preflight；
- deploy；
- migrate；
- verify；
- status；
- logs；
- clean；
- down。

建议 deploy 顺序：

1. 获取部署锁并做配置、端口、容量和依赖预检；
2. 构建、测试并导入不可变镜像；
3. 应用 namespace、Secret、存储和独立 PostgreSQL；
4. 等待数据库 ready；
5. 删除并重建不可变 migration Job；
6. 迁移成功后滚动 mx-auto-server；
7. 断言实际运行镜像 digest；
8. 执行 API、调度、artifact 和身份 smoke；
9. 执行 MX-H2I 登录非回归检查。

down 默认只停止计算工作负载，保留 PostgreSQL、PVC、Secret 和迁移历史。删除数据必须使用另一条显式、可恢复并需要确认的操作。

## 桌面开发与打包合同

与 mx-h2i 类似，mx-autotest 应提供一条入口脚本区分：

- dev：本地 renderer / main 开发，使用明确的开发配置；
- run：启动本地已构建应用；
- package：生成当前 OS / arch 的安装包；
- run-packaged：安装或挂载刚生成的包并做桌面 smoke；
- verify：检查 standalone 注册、Internal 配置、登录和共存。

模式切换必须显式显示当前 profile、Internal endpoint、应用标识和产物路径，不能靠修改隐藏配置文件残留状态。脚本不得启动、停止或重配 MX-H2I 来完成 mx-autotest 开发。

## 网络与安全边界

- 默认拒绝 ingress / egress，再显式放行 DNS、独立 PostgreSQL、Kubernetes API、Internal 身份合同和被测目标。
- 控制面 Pod 不获得访问任意被测网络的权限；需要广泛 egress 的是隔离后的 runner Pod。
- K8s server runner 的 ServiceAccount 只能管理自身 namespace、带指定标签的 Job / Pod / logs。
- runner Pod 禁用自动挂载 ServiceAccount token，非 root、只读根文件系统、禁止提权，并设置 CPU、内存、临时盘和运行时长限制。
- 项目级目标 allowlist 是长期目标；NetworkPolicy 无法按域名稳定过滤，不能虚假承诺 DNS 名级别安全。
- 密钥按精确值脱敏，只在运行作用域解密，不写进 manifest、shell 参数、Git URL、报告或视频元数据。

## 故障隔离矩阵

| 故障 | 允许的影响 | 不允许的影响 |
| --- | --- | --- |
| mx-autotest UI 崩溃 | 当前用户无法操作工作台 | MX-H2I 登录、联网或已在服务器执行的 run 中断 |
| mx-auto-server 不可用 | 新任务、报告查询暂不可用 | launcher deployment 被滚动或用户登出 |
| artifact store 满 | 新产物受阻，run 明确标 blocked | 数据库损坏或其他 namespace 写满 |
| Internal 身份暂不可达 | 新登录失败，敏感操作拒绝 | 使用缓存绕过权限或停止已认领 run |
| runner 工具下载失败 | 单个 run blocked，可重试 | 自动切换到未固定的 latest 版本 |
| migration 失败 | mx-auto-server 停止发布并输出诊断 | 继续滚动 API 或触碰 launcher 数据库 |

## 与现有系统的关系

| 系统 | 关系 |
| --- | --- |
| mx-launcher | 提供 standalone 注册、身份和通用客户端能力；不是 mx-auto-server 的宿主 |
| MX-H2I | 首个重要非回归对象；不是依赖项，也不是被接管的发布链 |
| electron-server | 可参考迁移与脚本经验，但其高权限 Docker socket 模式不得复制 |
| mx-base | 可作为未来共享设施货架；初期不可成为 deploy 或 run 的强依赖 |
| mx-insight-hub | 独立产品与数据域；不共享数据库、迁移和运行时故障 |
| 被测项目 | 提供被测制品或源码；测试源码可位于独立 QA 仓库 |

架构边界的正式决策见 [ADR-0001](adr/0001-standalone-internal-and-login-isolation.md)。
