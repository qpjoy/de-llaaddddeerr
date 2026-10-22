# Public API 单 Pod 多进程与读取并发

2026-10-22。起因：评估 PG 配置是否够用、是否把读取并发调到 8；以及为提高 QPS 增加 Public API 的处理能力。

## 结论

- **PG 配置够用，读取并发调到 8 合理。** `mx-common` PG 的上限是 16 核、48 GiB，`max_connections=200`。Pay、Launcher 各有自己的库。Hub 原来约占 90 个连接，本次改完后约 110 个。读取请求大多数时间在等 ES，原来每个进程只放 4 个，PG 大部分时间是闲着的。
- **Public API 不能靠加副本扩容。** 它用 `hostNetwork` 直接绑定主机的 `10.88.88.88:18150`，才能访问本机 Night-All（`127.0.0.1:13141`）。集群只有一个节点，同一个端口只能有一个 Pod。去掉 `hostNetwork` 会改变下游访问 Hub 的网络路径，所以没有这样做。
- **改为一个 Pod 里跑 4 个 Node 进程，共用同一个端口。** Node 是单线程，一个进程最多用满一个核；现在最多可以用到 4 个核。地址、端口和网络路径都不变。
- **不新增环境变量，不加部署步骤，不做数据库迁移，**随 Hub 正常 `deploy` 生效。

## 改动

| 项目 | 改前 | 改后 |
| --- | --- | --- |
| 读取并发（`MX_INSIGHT_DATA_API_READ_CONCURRENCY`） | 每进程 4 | 每进程 8：Public 4 个进程合计 32，Admin 8。服务器 `.env.internal` 里如果显式写了 4，会覆盖这个默认值 |
| Public 进程数 | 1 | 4（代码内置 `PUBLIC_API_PROCESSES`）。主进程只负责拉起、替换和停止工作进程，请求由 4 个工作进程处理 |
| 工作进程异常退出 | — | 1 秒后补一个，连续快速失败时间隔加倍（最长 30 秒）。如果连续 5 次都在启动后 30 秒内退出，整个 Pod 退出，交给 Kubernetes 重启并显示出来 |
| 停止 | 进程收到 SIGTERM 后关闭 | 主进程把 SIGTERM 转给每个工作进程，各自处理完请求、关闭连接池后退出。25 秒还没退出的强制结束（低于 Kubernetes 默认 30 秒的终止宽限期） |
| PG 连接池 | 每进程 10 + 10，合计 20 | 每进程 5 + 5，合计 40。规则是「单进程池的两倍，平分给所有进程」 |
| 上游并发等进程内限额 | 每个 gateway 实例一份 | 每个进程取四分之一（向上取整，至少 1），整个 Pod 合计不变。涉及：供应商并发、单客户并发、排队数、商品图片中继并发、每客户每分钟请求数、图片缓存。供应商 RPM 本来就在 PG 里共享，不变 |
| 每个工作进程的堆 | 默认 | 768 MB。Node 会按整个容器估算默认堆大小，4 个进程叠加可能在回收前就超出 Pod 限额 |
| Public 资源 | request 250m / 256Mi，limit 2 核 / 1Gi | request 1 核 / 1Gi，limit 6 核 / 4Gi |
| Admin | 单进程 | 不变。通知、余额监控、支付对账等定时任务不能跑两份 |

**注意：** 上游限额按份额拆分时，原值很小的项没法精确平分。比如某个客户的并发限额是 1，每个进程至少也得是 1，整个 Pod 合计最多会变成 4。默认值（供应商并发 32、单客户图片并发 16、每客户每分钟 1200 次图片请求）都能整除。Admin 后台保存的限额仍按配置值显示；被拒请求的错误详情里给出的是单个进程的份额。

## 资源实测（本机，空闲）

| 进程 | 内存（RSS） |
| --- | --- |
| 主进程 | 约 146 MB（加载了完整模块，但不处理请求） |
| 每个工作进程 | 约 185–193 MB |
| 合计 | 约 0.9 GB（原来单进程约 0.19 GB） |

空闲时 CPU 接近 0；处理请求时，每个工作进程最多用 1 个核。进程和 Pod 一样一直常驻。服务器约有 128 核、105 GB 空闲内存，资源充足；需要控制的是 PG 连接数和磁盘。

## 验证

- 新增 `tests/server/api-processes.test.mjs`：
  - 拉起 4 个进程，并带上堆上限；
  - 进程退出后补进程，且间隔按次数加倍；
  - 连续崩溃时整个 Pod 退出；
  - 收到停止信号时优雅退出，超时后强制结束；
  - 每个进程的连接池和上游限额份额正确；
  - 真实入口用本机 PG 启动 4 个进程，在同一端口连续收到 20 个请求后，收到 SIGTERM 正常退出（退出码 0）。
- Hub 全量服务端测试：4030 通过，42 个失败全部是改动前就存在的；部署脚本检查 186 项、类型检查都通过。原来一条按「4 个读取执行槽」写死的测试，已改为按新默认值 8。

## 部署后核对

```bash
kubectl -n mx-insight-hub logs deploy/mx-insight-hub-public | grep -E "started 4 API processes|listening on"
```

应该看到 1 行 `started 4 API processes`，以及 4 行带不同 `process <pid>` 的 `listening on`。

```bash
kubectl -n mx-insight-hub exec deploy/mx-insight-hub-public -- cat /sys/fs/cgroup/memory.current
```

```bash
kubectl -n mx-insight-hub exec deploy/mx-insight-hub-public -- cat /sys/fs/cgroup/cpu.stat
```

在高峰期，隔 60 秒各读一次 `cpu.stat`，用 `usage_usec` 的差值除以 60,000,000，得到平均使用的核数。超过 1，说明多进程已经在起作用。

PG 连接数可以这样看（只读）：

```bash
kubectl -n mx-common exec -i statefulset/mx-common-postgres -- psql -X -U mx_common -d mx_common -c "SELECT datname, application_name, count(*) FROM pg_stat_activity GROUP BY 1, 2 ORDER BY 3 DESC"
```

## 不变

- 访问地址 `10.88.88.88:18150`、`hostNetwork`，以及 Recreate 发布方式：发布时 Public 仍会像以前一样短暂中断。
- MX-H2I 登录和联网、Launcher 认证、计费、幂等、回放。
- PG 实例本身的配置；Admin 和后台 worker。

## 回退

- 读取并发：在 `.env.internal` 里设 `MX_INSIGHT_DATA_API_READ_CONCURRENCY=4`，再重新部署。
- 进程数：把 `server/index.mjs` 里的 `PUBLIC_API_PROCESSES` 改回 1（或回退本次提交），再把 `30-public-api.yaml` 的资源改回原值，重新部署即可。不涉及数据变更。
