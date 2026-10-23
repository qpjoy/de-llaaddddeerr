# 02 事件中心：Hub → Delta → Java

状态：设计中，未实现。

## 1. 问题与结论

链路是「Delta（下游业务）→ Hub（数据中台）→ Night-All（自建爬虫，自带 BullMQ）」。Delta 想及时拿到爬虫数据，Hub 在中间转接。Hub 在 k8s 里，Delta 和 Night-All 是 Docker，Hub 的数据服务（mx-common）对外是隔离的。

**结论：**

- **不在 mx-common 或 mx-base 里开一个对外的消息中心让 Delta 直连。** 消息中心就是 Hub 自己的事件接口：数据存在 Hub 的 PG 里，通过 Public `:18150` 用 HTTP 对外，不需要新的网络入口。
- k8s 和 Docker 之间的隔离不是障碍。Hub Public 现在是 hostNetwork，多节点后由 hub-edge 接住（见 [01](01-topology-and-multinode.md)），对 Docker 来说始终只是一个宿主机端口。
- **可靠性来自「持久事件日志 + 游标」，长连接只负责及时唤醒。**

## 2. 为什么不直连中间件

1. **业务归属。** Delta 要的是「我提交的采集完成了」「我订阅的主题有新内容」。这带有租户、授权、计量和证据的含义，属于 Hub。直连 Redis 或 PG 就绕过了 Key 校验和计量。mx-common 的 README 明确写了它「不包含任何业务语义」。
2. **Night-All 的 BullMQ 是执行队列，不是通知总线。**
   - Delta 如果注册成 Worker，就会和 Night-All 自己的 worker 竞争领取同一批任务。
   - `QueueEvents` 底层是会被裁剪的 Redis Streams。
   - lifecycle runner 的 completed 返回值只是 `true`，不是结果。
   - 队列名属于 Night-All 的内部实现，而 Night-All 正在按接口逐个退役。
3. **隔离。** mx-common 的 PG、Redis 是 ClusterIP 加 NetworkPolicy。对 Docker 开放就意味着开 NodePort 或 hostPort，把共享数据面暴露出去。
4. **运维。** RabbitMQ、Kafka、NATS 都是新的有状态系统。单节点上 PG 和 etcd 已经共盘，现在的量级也用不上。
5. **数据来源对下游透明。** 事件从 Hub 的规范化数据 outbox 产生。数据来自 Night-All 还是 TikHub 原生接口，Delta 都感知不到。

**分工：**
- mx-common 将来可以提供一个**库级原语**（PG 追加日志、按游标读、LISTEN/NOTIFY 唤醒、分区清理），供 pay、dataport 复用。
- mx-base 不新建消息服务。

## 3. Night-All → Hub

- **由 Hub 主动拉取：**
  - 同步接口：Hub 的执行者直接调 `/search/raw`（[03](03-self-hosted-engines.md) 第一阶段）。
  - 异步接口：调 `/crawlers/library/:id/run` 拿到 taskId；Hub 用带租约的任务，按退避间隔查询 `GET /tasks/:id`。Hub 重启后能续上（第二阶段）。
- **可选「先通知再拉取」：** Night-All 完成后回调 Hub 内部接口（Admin 面，需要工作负载凭据），Hub 收到后立即去拉。**回调只是提示，拉到的结果才算数。**
- **一个事务提交：** 结果、原始证据、规范化数据、outbox、任务状态、事件。
- **禁止** Hub 在 Night-All 的队列上注册 Worker，否则会抢走本该由 Night-All 执行的任务。

## 4. 事件的生成

- **来源：**
  - `outbox.projection_events`：已经和规范化数据在同一事务中写入（迁移 005、006）；
  - 任务状态变化：和任务行在同一事务中写入。
- **分发 worker：** 运行在 Hub 的 worker 部署里，**每个分片只有一个写入者**（PG advisory lock 选主）。它从 outbox 按租约领取（和 projector、迁移 086 的 retrieval 触发器同一种模式），匹配订阅，然后追加写入 `events.deliveries`。
- **序号由唯一的写入者分配**，所以每个消费方的 `seq` 连续、单调递增。这样能避开一个经典坑：直接用数据库 sequence 当游标时，先拿号的事务可能后提交，消费方读 `id > cursor` 会永久漏掉它。
- **唤醒：** 同一事务里执行 `pg_notify('hub_events', consumer_id)`，提交后才会发出。
- **存储：** 按天或按周分区，默认保留 7 天，到期直接 DROP 分区，不用 DELETE 加 VACUUM。因为写放大和慢盘的历史问题，这一点很重要。
- **批量写入：** 每个事务写 200–500 条，一批只等一次落盘。

拟定表结构（未实现）：

```sql
CREATE TABLE events.deliveries (
  consumer_id uuid NOT NULL,
  seq bigint NOT NULL,
  event_id uuid NOT NULL,
  type text NOT NULL,
  subject text NOT NULL,
  revision integer NOT NULL,
  occurred_at timestamptz NOT NULL,
  payload jsonb NOT NULL,
  PRIMARY KEY (consumer_id, seq)
) PARTITION BY RANGE (occurred_at);
```

## 5. 事件格式

```json
{ "id":"6c0f…(uuid)", "cursor":"c1.MTgzNDI", "type":"job.succeeded", "specversion":"mx.1",
  "occurredAt":"2026-10-23T10:00:00Z", "subject":"job/7a1e…", "revision":3,
  "data":{ "jobId":"7a1e…", "status":"succeeded", "resultUrl":"/api/v1/data/wechat/self-hosted/jobs/7a1e…/result" } }
```

- **事件要轻：** 结果较大时只给 `resultUrl`；小的规范化记录可以内联，上限约 64KB。
- **`cursor` 是不透明字符串**，带版本前缀，调用方不能解析。这样以后换成 JetStream 等后端时，调用方不受影响。
- **第一批类型：**
  - 任务生命周期：`job.accepted / job.running / job.succeeded / job.failed / job.unknown / job.cancelled`
  - `batch.completed`
- **以后再加：** 主题订阅的 `record.matched`。
- **只给管理员看的类型：** `engine.attention_required`，引擎被隔离时发出。

## 6. 交付接口（拟定）

| 接口 | 用途 |
|---|---|
| `GET /api/v1/events?after=<cursor>&limit=500&wait=25` | 长轮询：有事件立即返回；没有就最多等 25 秒，被 NOTIFY 唤醒后返回 |
| 同一路径，带 `Accept: text/event-stream` | SSE：`id:` 就是 cursor，断线后用 `Last-Event-ID` 续上；每 10 秒一次心跳 |
| `POST /api/v1/subscriptions` | 主题订阅（以后）。自己提交的任务的生命周期事件默认推给自己，不需要订阅 |
| `PUT /api/v1/event-cursors/{group}` | 可选：多个实例需要 Hub 负责分派时，在服务端保存消费组游标（claim / ack，见审计详稿第 10 节） |

- **鉴权：** 使用同一个 Hub API Key。事件按 `consumer_id` 隔离，能看到的事件等于这个调用者当前的授权范围。
- **游标过期：** 返回 `410 cursor_expired`，消费方改用现有查询接口按更新时间补齐，然后从最新游标继续。
- **连接名额：** **长轮询和 SSE 不能占用 Public「每进程 8 个读取并发」的名额**，要单独开一条通道，单独设上限（例如每进程 64 个，内置值）。否则 8 个长连接就能卡死所有读接口。
- **跨进程唤醒：** 每个 Public 进程各开 1 个 `LISTEN` 连接，只唤醒挂在自己身上的等待者。状态都在 PG，所以任何进程、任何节点都能服务任何消费方。

## 7. 交付语义

- **至少一次：** 消费方按 `id` 去重。
- **顺序：** 同一个消费方内按 `cursor` 有序；同一个对象（subject）可以用 `revision` 丢弃过时的事件。
- **事件只是通知：** 结果以 `GET` 读到的为准，事件丢了也能补查。
- **保留期：** 默认 7 天，需要和 Delta 可能离线的最长时间一起确认（[05](05-roadmap-and-decisions.md) Q4）。

## 8. Delta 怎么消费

- **单独开一个容器** `delta-hub-events`，运行 `manage.py consume_hub_events`。**不要放在 gunicorn 里**，Delta 的网页层撑不住长连接。
- **多实例：** 用 Delta 自己 PG 的 advisory lock 选出唯一的消费者；需要 Hub 负责分派时，再改用服务端消费组。
- **事务内落库（transactional inbox）：** 去重记录、业务状态、Celery 后续任务、游标，在同一个 Django 事务里提交。效果上等于「恰好处理一次」。

```python
cursor = HubCursor.objects.get(name="hub").value
with httpx.Client(timeout=40) as client:          # 内网直连，trust_env=False 等同
    while True:
        response = client.get(f"{HUB}/api/v1/events", params={"after": cursor, "wait": 25},
                              headers={"Authorization": f"Bearer {KEY}"})
        for event in response.json()["data"]:
            with transaction.atomic():
                if HubEventInbox.objects.filter(event_id=event["id"]).exists():
                    continue
                HubEventInbox.objects.create(event_id=event["id"], type=event["type"])
                apply_event(event)                 # 更新 run 状态
                transaction.on_commit(lambda e=event: handle_result.delay(e["data"]["jobId"]))
                HubCursor.objects.filter(name="hub").update(value=event["cursor"])
            cursor = event["cursor"]
```

- 重活（拉取结果、分析）交给 Celery worker。Celery beat 继续负责 Delta 自己的计划排程。
- 「调 Hub 然后干等 60–90 秒」改成「提交任务 + 等事件」，Celery worker 不再被长请求占住。

## 9. Delta 与 Java 之间

| 交互 | 推荐做法 |
|---|---|
| Java 对 Delta 发命令或查询 | REST。长任务返回 202 和 taskId |
| Delta 通知 Java（任务完成、业务事件） | **webhook**，见下文 |
| LLM 逐字回答 | SSE（现有做法） |
| Java 推给浏览器 | 现有的 WebSocket 或 SSE |

**Webhook 规范（拟定）：**

- **发送方：** Delta 的 Celery 任务调 `POST <java>/internal/delta/events`。
- **请求头：**
  - `X-MX-Event-Id`
  - `X-MX-Signature: t=<unix>,v1=<HMAC-SHA256(secret, t.body)>`
- **重试：** 按指数退避，大致 1 秒、10 秒、1 分钟、10 分钟、1 小时；失败的进 Delta 的死信表。Delta 侧用 outbox 表记录待发送事件，避免「业务已提交、通知没发出」。
- **接收方：** Java 用 `delta_event_inbox`（`event_id` 唯一）去重，先落库再返回 2xx；重启后用 `GET /tasks/{id}` 对账。`DeltaTaskRecoveryRunner` 可以因此简化。

**为什么不用 Java 和 Delta 之间的长连接：**
- Delta 的网页层是同步 gunicorn；
- 要支持长连接，就得在 Delta 里再实现一套事件日志服务端。

**以后 Delta 的下游变多时：** 可以用 uvicorn（依赖里已经有了）对外提供和 Hub 同一套 `/events` 协议。

## 10. 传输方式对比

| 方式 | 方向 | 断线续传 | 穿过代理 | 客户端支持 | 用在哪 |
|---|---|---|---|---|---|
| 长轮询 + 游标 | 拉 | 天然支持 | 无障碍 | 不需要额外库 | **Hub → Delta 的首选** |
| SSE + `Last-Event-ID` | 推 | 支持 | 需要关闭缓冲（Hub 已设置 `x-accel-buffering: no`） | httpx-sse / Spring WebClient | 需要实时性时 |
| WebSocket | 双向 | 需要自己设计确认和续传 | 需要 upgrade | 都支持 | 只有确实要双向通信时才用。提交命令频率很低，用 HTTP 就够了 |
| Webhook | 推 | 发送方负责重试 | 无障碍 | 都支持 | 接收方是常驻服务时，如 Java、以后的外部客户 |
| 直连 Redis / BullMQ | — | 会被裁剪 | — | — | **不用** |

## 11. 多节点与扩展

- **跨节点唤醒：** `LISTEN/NOTIFY` 跨节点可用，前提是所有 Pod 连接同一个 PG 主库。
- **分发 worker 选主：** 用 advisory lock，可以多副本部署，只有一个在写。
- **hub-edge 的超时设置：** 见 [01](01-topology-and-multinode.md) 4.1 节。
- **什么时候换成 NATS JetStream（3 副本）**，满足任一条即可：
  - 节点数 ≥ 3，且事件总线需要独立于 PG 的高可用；
  - 持续超过约 5000 条事件/秒（估算）；
  - 独立消费的应用超过约 10 个；
  - 需要跨机房复制。
  
  替换方式：分发 worker 改为写 JetStream，事件接口改为从 JetStream 按序号读。游标是不透明的，**调用方不用改**。
- **在那之前**，PG 的高可用（S3）就是事件日志的高可用。

## 12. 容量估算（未实测）

| 项目 | 估算 |
|---|---|
| 写入 | 每批 500 条、每条约 1KB，单个 PG 能撑每秒数千条；瓶颈是落盘延迟（事故中出现过单次 1.5 秒），所以必须批量 |
| 读取 | 走 `(consumer_id, seq)` 主键，亚毫秒级 |
| 唤醒延迟 | 从提交、NOTIFY 到客户端被唤醒，约 10–50 ms |
| 连接 | 下游消费方很少（Delta、Java 等），每进程几十个长连接足够 |

## 13. 拟定实现清单

| 位置 | 内容 |
|---|---|
| 迁移 | `events` schema、分区表 `deliveries`、`subscriptions`、`cursors`（可选）、分区维护 |
| Hub worker | 分发 worker：outbox 和任务状态 → deliveries，批量写入，advisory lock 选主，NOTIFY |
| Hub Public | `/api/v1/events` 长轮询和 SSE、独立的连接通道和上限、每进程 1 个 LISTEN |
| 文档 | `server/public-docs.mjs`、OpenAPI、接入指南 |
| Delta | `consume_hub_events` 命令、inbox 表和游标表、Compose 新服务 |
| Java | `/internal/delta/events` 接收端、inbox 表、HMAC 校验 |
