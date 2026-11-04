# 刷新调用身份 500：用量统计耗尽 PostgreSQL 动态共享内存

## 已确认的原因

请求 `10830a57-fad8-4639-955d-6c6b0fcd6ac1`，2026-10-30 00:12:39（北京时间），在 Admin `POST /internal/v1/admin/demo-credentials` 失败。操作者提供的日志：

```text
could not resize shared memory segment "/PostgreSQL.604768474" to 16777216 bytes: No space left on device
code: 53100
routine: dsm_impl_posix
PostgresStore.usage -> HubService.getApiKeyOverview -> HubService.createDemoCredential
```

00:14:02 的 `751e9cb9-1d21-4153-a27e-b6a7d70cbf98` 出现同样的错误。这里是 POSIX 动态共享内存段扩容至 16 MiB 失败，不是 Key 无效或供应商余额不足，也不能仅凭 No space left on device 判定数据盘已满。

`createDemoCredential` 原来调用完整的 `getApiKeyOverview`，但仅使用返回值中的 operations。完整概览同时查询累计用量、账单汇总、近期请求、套餐和配额快照；其中 usage 查询失败，经 Promise.all 使凭据签发失败。53100 未被当前 hubDatabaseFailure 分类，最终显示通用 internal_error。

## 本地修复

- 提取原有的操作可用性读取逻辑为 `#operationAvailability(consumerId)`，由概览和凭据签发共同使用。
- 凭据签发不再执行完整概览、历史用量/账单聚合、套餐或配额概览查询；只取它实际展示的操作状态。
- Key、consumer、tenant 状态、有效期、租户成员身份与权限交集检查保持原样。临时凭据仍引用原 Key，实际 Public API 调用的权限、准入、配额和计费检查没有修改。
- 可用性响应继续只公开 ready/effectiveState。原有供应商状态读取失败的容错语义保持不变，实际派发仍会重新检查。
- 完整 Key 概览和用量报表仍执行真实统计，不吞掉统计失败或伪造零用量。它们仍可能遇到线上共享内存问题，需继续处理数据库容量。

Hub 修复没有修改数据库参数或全局错误分类，也没有更改 Launcher/MX-H2I 登录、SSO 或网络代码。收到容量证据后，另行准备了下述 mx-common 挂载模板修改，未应用到线上。

## 验证

新回归用例先注入与生产一致的 usage 53100，修改前失败、修改后通过。验证 Admin 与租户临时凭据均能签发、不调用 usage/quotaSnapshot，操作状态保持一致且不泄露供应商私有字段，权限读取失败仍拒绝签发；完整概览仍如实报告 usage 失败。

凭据套件 12 项通过；Key 健康、配额及限额相关测试 30 项通过、2 项数据库集成测试跳过；类型检查及 diff 检查通过。未声称完成生产数据库容量复现或线上恢复。

## 线上容量确认（只读）

故障时 mx-common PostgreSQL 模板只挂载数据卷，没有显式 `/dev/shm` 卷。使用以下命令确认实际运行容量：

```bash
kubectl -n mx-common exec mx-common-postgres-0 -c postgres -- \
  df -h /dev/shm /var/lib/postgresql/data

kubectl -n mx-common exec mx-common-postgres-0 -c postgres -- \
  df -i /dev/shm /var/lib/postgresql/data
```

这是当前快照；查询结束后共享内存可能释放，所以当前占用低不能否定历史耗尽。PostgreSQL 官方说明，动态共享内存可以使用 POSIX shm_open，並行查询可能向操作系统临时申请额外共享内存：https://www.postgresql.org/docs/16/runtime-config-resource.html 。日志尚未提供执行计划，具体是否并行聚合/hash join 导致本次申请仍待证据。

## 容量已确认与模板修复

操作者回传：`/dev/shm` 64 MiB，使用 2.3 MiB，剩余 62 MiB；数据盘 1.0 TiB，剩余 647 GiB；两者 inode 使用率均为 1%。因此有证据支持共享内存容量瓶颈，而非数据卷或 inode 耗尽。事后 4% 占用与历史查询申请 16 MiB 失败不矛盾；精确峰值与触发并发尚未测量。

已将 `mx-common/deploy/k8s/common/10-postgres.yaml` 修改为：

```yaml
# postgres container
volumeMounts:
  - name: data
    mountPath: /var/lib/postgresql/data
  - name: dshm
    mountPath: /dev/shm
# Pod spec
volumes:
  - name: dshm
    emptyDir:
      medium: Memory
      sizeLimit: 1Gi
```

1 GiB 是基于仓库现有 48 GiB 容器内存上限选定的初始有界容量，比故障时 64 MiB 提高 16 倍；不是实测峰值保证，也不是预留内存。实际使用计入容器内存。保留原数据卷、数据库参数、容器资源和 `OnDelete` 策略；不扩大 work_mem，不删除 PostgreSQL 共享内存文件。

本地使用 kubectl kustomize 离线渲染并解析 YAML，确认 tmpfs 与 data 分别挂载、原 PVC 保留、策略仍为 OnDelete。运行现有 OnDelete 与存储身份保护测试。没有连接生产集群或重启任何服务。

## 分阶段生效

1. 先通过 Hub 正常发布流程更新应用，解除临时凭据签发对历史统计的依赖。无需数据库迁移或重启 PostgreSQL；发布后仅点击刷新调用身份验证，不发起付费采集。
2. 共享数据库模板通过既有 mx-common 发布流程收敛。OnDelete 下模板更新不会自动重建已有 Pod，`ensure`/就绪检查成功也不等于挂载已生效。
3. 重建前只读核对在线 Pod 的内存限制、StatefulSet 待生效的镜像/参数/挂载差异与存储身份，防止连带应用尚未审查的历史模板改动。再在允许共享数据库短暂不可用的维护窗口安排重建；Hub/DataPort 等使用该实例的应用会受到短时影响。本次没有执行或授权自动重建。
4. 重建后检查 Pod Ready、原数据库身份与应用连接，并执行上面的 df 命令，确认 `/dev/shm` 显示约 1 GiB；在正常业务负载下继续观察 53100，而不是以低负载成功宣称所有峰值已解决。

Kubernetes 的 memory emptyDir 及内存记账说明：[Volumes](https://kubernetes.io/docs/concepts/storage/volumes/)。

## 后续：移除调用对历史报表的依赖，并限制报表资源

用户要求避免历史统计使下游调用被卡住。代码核查结果：

- 普通机器 Key 的 `authenticate` 只查 Key/consumer/tenant 状态，不调用 usage 或 getApiKeyOverview。临时凭据旧路径误用了完整概览，已按上文去掉。
- 剩余 `store.usage()` 调用用于管理概览/仪表盘、工作空间用量和显式 `/api/v1/usage` 报表请求，没有发现普通数据 API 在鉴权时调用它。报表和数据业务仍共享数据库，不能承诺完全没有资源争用。
- 真正的业务准入仍有 Key/consumer 窗口及套餐周期计数，它们是配额检查，和本次无时间范围的历史报表聚合不同。本次没有删除配额、账本、历史证据或幂等记录。
- 给发生本次事故的 `PostgresStore.usage()` 只读事务加上 `SET LOCAL max_parallel_workers_per_gather = 0`、`statement_timeout = '5s'`、`lock_timeout = '1s'`。不再为该报表启用并行查询；每条 SQL 最多运行 5 秒、锁等待最多 1 秒（不是整个 HTTP 请求的五秒总时限）。结束事务后设置自动恢复，不影响连接后续执行业务事务。
- 报表超时回滚并报告失败，不伪造零用量，也不返回半份统计。所有原过滤条件、计数和账单聚合保持原样。本次限制针对 usage()，未声称所有报表/usageDaily 已完成资源隔离。

凭据、客户计费和报表边界测试合计 28 项通过；类型检查通过。新报表回归覆盖精确计数与筛选、第一条/中途 SQL 取消时回滚释放连接，不交付部分或零结果。此项无需数据库重启，只需发布 Hub；与 `/dev/shm` 扩容可分开生效。

## 发布状态

应用修复和共享内存模板均仅在本地，尚未部署；原有 PostgreSQL Pod 仍应视为 64 MiB。数据库共享内存问题未宣布线上修复。
