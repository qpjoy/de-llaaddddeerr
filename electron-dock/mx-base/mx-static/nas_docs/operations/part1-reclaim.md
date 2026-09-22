# 第一卷 SSD 旧媒体回收

## 已确认的范围与前提

第一卷 `po_infra_media_data` 已在 NAS 上运行。现场只读清单通过，包含 194,686 个普通文件和 4 个目录，逻辑大小 534,838,192,708 字节；SSD 分配空间 535,253,102,592 字节（498.49 GiB）。当时 /data 可用 70,917,476,352 字节（66.05 GiB）。实际释放量受打开文件、共享块和业务同时写入影响，以完成后的 df 为准。

本次清单：

```text
/var/lib/mx-static/nas-cutover/po_infra_media_data-830225384207402a8ba23a2364d252d1/reclaim-plan-6e889ff90c744504a739a40d6eb6d102
manifest_sha256=62f03d769bbed7366900c8a14211643c1b70f2efe3db2f297bbf994310c8cca1
source device=66309 inode=1083500031
```

**仅在业务验收通过后执行删除：旧图片/视频、新上传或媒体采集、任务结果都正常。** 清单成功本身不是业务验收。`--business-accepted` 明确表示执行人已完成以上检查，脚本不会自己推断验收结果。当前现场仅回传清单，还未回传业务验收或删除完成结果。

保持这套部署和其他宿主机/K8s 进程对旧 SSD 路径的写入冻结，期间不要在 NAS 上做目录搬动、管理员清理或存储重配置。应用可继续使用 NAS。工具的锁只约束本项目迁移脚本，不能锁住任意宿主机进程或其他 NAS 客户端。

## 执行

用户提交并同步这一轮全部脚本后，在服务器 mx-static 目录运行。先确认脚本已到位：

```bash
bash scripts/nas-reclaim.sh --help
```

**业务验收正常后**，使用独立 systemd 单元避免 SSH 断开中断：

```bash
sudo systemd-run --unit=mx-nas-reclaim-po-1 \
  --property=RuntimeMaxSec=infinity \
  --property=TimeoutStopSec=90s \
  --property=ReadOnlyPaths=/mnt/nas \
  /bin/bash "$PWD/scripts/nas-reclaim.sh" --business-accepted \
  /var/lib/mx-static/nas-cutover/po_infra_media_data-830225384207402a8ba23a2364d252d1/reclaim-plan-6e889ff90c744504a739a40d6eb6d102
```

本次需要写 SSD，**不要沿用预复制/切换命令中的 `ReadOnlyPaths=/data`**。这里 `/mnt/nas` 只对该单元设为只读，不修改宿主机挂载或 Docker 守护进程的挂载命名空间。工具另启一次现有镜像的隔离只读 NFS 身份检查容器，不停止/重建业务容器。

查看结果：

```bash
sudo journalctl -u mx-nas-reclaim-po-1 -n 30 -f -o cat
```

出现 `reclaim_result`、`phase=ssd_files_reclaimed` 和单元 `Succeeded` 后，Ctrl-C 退出日志跟随，再执行：

```bash
df -hT /data
```

回传最终 JSON 和 df。这个阶段只有文件元数据检查和 SSD unlink，不再传输或全量读取 498 GiB；具体耗时取决于 NAS 元数据响应与 SSD 删除速度，不承诺固定分钟数。NAS hard 挂载仍可能等待，不要并发启动第二份任务。

## 脚本边界

- 固定 Part 1 卷与报告路径，校验私有清单 SHA256、文件数、源设备/inode，拒绝绝对/上级/重复路径和链接。清单摘要不等于媒体全量内容哈希；继续沿用已接受的 rsync 传输校验与最终 quick-check 策略。
- 重新检查部署配置、固定容器身份、十个实际 NAS 子挂载、数据库/Redis 身份与健康、NAS marker 和额外 Docker 源卷消费者。批次前继续复查。
- 删除前先检查剩余 SSD 文件与清单精确一致，按清单核对 NAS 对应普通文件的大小、整秒 mtime、mode、uid/gid；NAS 新文件不扫描、不删除。发现 NAS 缺失/属性变化会保留 SSD，停止供人工判断业务变化。
- 每 1,000 个文件先将 unlink 意图写入本地私有日志并 fsync，再通过固定目录描述符逐个核对源文件身份并删除。每个文件删除前再次检查 NAS 元数据，批次后 fsync SSD 父目录。
- **保留全部 4 个目录，包括根目录及其 inode。** 不删除 Docker named volume，不删除父级 media 的其他目录，不处理 delta 第二卷；不运行 rm -rf、rsync、服务重启、镜像拉取/构建或数据库命令。
- 原迁移报告和 NAS marker 留存。完成后记录 `reclaim-result.json`，更新 `execution.json` 的业务验收结果与 `ssd_reclaim` 收据；保持线上 NAS 状态，旧预复制仍被封存 marker 阻止。

## 中断与错误

错误时可能已经释放部分 SSD 文件，NAS 仍是线上权威来源；不自动回滚、不重新从旧 SSD 同步。保留这份清单、`acceptance.json`、`unlink-intents.jsonl` 及全部报告。

确认旧单元已经停止后，可用新单元名（如 `mx-nas-reclaim-po-2`）运行相同脚本、相同业务验收参数和**同一份清单路径**。只有曾写入 durable intent 的清单文件允许已经缺失；新文件、变更文件、额外缺失或目录身份变化均停止。意图日志若出现截断/损坏，工具拒绝自动继续，需要查看具体输出；不得删除日志或重新生成清单来绕过它。

业务运行配置目前包含报告目录里的 `compose.nas.override.json`。后续发布必须继续带上这份 NAS 子挂载配置，不能仅用原 Compose 文件重建。正常重启现有容器会保留其挂载定义；正式升级时还需处理此次固定镜像和安全启动覆盖。详见 [持久部署和重启](part1-cutover.md#业务验收持久部署和重启)。SSD 文件删除后不能直接恢复旧 SSD 数据源。

独立备份目前没有；按用户决定暂缓 OSS，NAS 存储池/快照健康也没有管理端证据。此脚本不会将 NAS 唯一副本变成独立备份。

## 本地验证

103 项 NAS 测试通过，其中新增 14 项针对清理：真实文件精确回收、目录身份/NAS/其他 media 保留、意图先落盘、中断继续、重复调用、新文件/源变化/NAS 变化/未知缺失拒绝、NAS 新文件保留、目录替换/符号链接拒绝、清单/日志异常拒绝、批次前部署检查失败不删除，以及显式验收参数校验。Bash 语法及 Python 3.6 语法检查通过。

本地真实文件测试使用 macOS 临时目录；没有连接线上 Docker/NFS，也未在 EL8 Python 3.6 运行该新脚本。NAS/部署身份检查复用已在现场通过的切换与清单代码；实际执行情况以服务器回传为准。
