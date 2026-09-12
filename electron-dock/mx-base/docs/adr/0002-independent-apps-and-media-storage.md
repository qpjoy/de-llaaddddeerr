# ADR-0002：按应用管理基础设施，独立多媒体采集与存储

状态：历史决策，2026-09-12。对象盘迁移与 Hub 接入现由 [ADR-0003](0003-detachable-nfs-archive.md) 覆盖。用户确认尚未上线，可整理初版结构。本 ADR 补充 ADR-0001 的服务范围；保留 Jenkins 不进入 MXT 调度关键路径的约束。

## 边界

mx-base 是多个独立服务的集合，不是统一进程。mx-static 拥有自己的队列、文件存储、凭据、Compose 和发布版本；Jenkins 保留原 Kubernetes 资源。管理脚本仅按应用分发操作，不一键修改整个 namespace。应用状态来自实际执行上下文，不能将本机无容器解释为生产未部署。

数据业务可以明确依赖基础设施的数据能力，但不得把媒体服务的健康检查加入 MX-H2I 登录/联网或 Hub 管理认证的启动条件。Hub 缓存归档扩展可关闭；mx-static 不可用时媒体代理按现有安全规则降级。Jenkins 不承担 MXT 测试调度。

## 技术选择

这是“持久媒体采集管道 + 文件/对象存储 + 多级读取缓存”。Node 异步 fs 负责文件 I/O；可靠性来自持久队列、租约、幂等去重、原子发布和磁盘同步，不来自 fs 这个模块名称。

首发使用单主机、单 writer、SQLite WAL/FULL 控制库，Node 24 LTS 镜像固定版本。任务提交成功后才返回 202。下载可重试，URL 与 project/scope 隔离；同来源在途请求合并。文件保存为不可变对象，完成提交受租约 owner 限制，避免过期 worker 更新新结果。请求断开不会取消已接收任务。成功完成只清除任务中的来源 URL，失败项保留用于诊断与显式重试。

对象盘和控制盘分别挂载；控制盘必须是本地磁盘。SQLite WAL 要求同主机共享内存，不将控制库迁往 NAS。对象盘可迁 NAS，但须验证 rename/fsync、权限和故障语义。单机故障可恢复不等于跨主机高可用；磁盘损坏仍需要备份。

内存只作可丢弃缓存：Hub 64 MiB/60 秒；每个 static 进程 64 MiB/60 秒，单对象 ≤1 MiB，最多 2048 个条目。大文件走流式读取和 OS page cache。缓存在请求时检查 TTL，并周期清理；磁盘对象不会随 TTL 删除。刷新页面读取已存媒体，显式重新采集商品数据仍遵守 Hub 数据请求策略。

## 借鉴与扩展条件

- [SQLite WAL](https://www.sqlite.org/wal.html)：提交持久性、单机读写并行及网络文件系统限制；运行镜像需包含已修复 WAL-reset 的 SQLite 版本。
- [RabbitMQ reliability](https://www.rabbitmq.com/docs/reliability)：确认后再交付、至少一次处理、幂等消费者。当前用本机持久队列实现这些语义；未来多机 worker 可改为消息代理与共享元数据库。
- [Nginx proxy cache](https://nginx.org/en/docs/http/ngx_http_proxy_module.html)：请求合并及更新时读旧缓存的模式。当前在鉴权后的应用层实现，不直接对带租户凭据或签名的 URL 开启公共代理缓存。
- [Linux page cache](https://www.kernel.org/doc/html/latest/admin-guide/mm/concepts.html)：文件读写也可命中内核缓存，磁盘读取不等于每次物理寻道。

只有出现跨主机扩容、单机队列延迟或对象容量达到实测瓶颈时，再引入共享消息代理、S3 兼容对象存储及受控 CDN；不把首次单机部署描述为无限并发平台。当前验收包括崩溃恢复、并发队列、缓存淘汰、权限隔离及 Compose 持久化，生产吞吐仍须在目标磁盘/网络条件下压测。
