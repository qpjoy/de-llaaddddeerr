# 宿主机 bind 挂载的启动与恢复备选方案

**方案调整：本文仅保留为宿主机 bind mount 的兼容备选，不再作为多项目的通用默认。当前优先验证 Docker NFS volume，长期以 Kubernetes PV/CSI 管理存储。原生机制、重试边界及数据库扩展见 [统一存储方案](storage-platform.md)。不要按本文直接把所有容器改为 restart=no。**

状态：备选设计和验收要求，**尚未安装生产启动控制程序或 unit**。用户决定保留 Docker 的 `20-requires-nas.conf.bak`，不恢复全局 `RequiresMountsFor=/mnt/nas`。fstab 是否已取消注释尚未收到执行回执，不能把当前 NFS 可访问当作重启已验证。

## 选择该 bind 备选时的三层职责

1. Linux、SSH、Docker daemon、SSD 上的 PostgreSQL/Redis 及无 NAS 依赖的服务正常启动。Docker 全局不依赖 NAS。
2. systemd 管理 NAS 挂载与按需挂载。它解决挂载时机，不能证明媒体已复制完整或应用可正常读写。
3. 两套媒体实例各有独立启动控制入口，确认正确导出、已完成迁移、当前应用权限后，才启动媒体消费者。它还要负责容器退出后的受控恢复，并支持人工暂停。

两套实例各 10 个消费者使用候选 [Compose 模板](../templates/compose.delta-raw-media-nas.yml.example) 的 `restart: "no"`；DB/Redis 保持本地策略。**覆盖文件与控制入口必须一起部署**：只改 restart=no 会失去自动恢复，只装前置检查却保留 unless-stopped 会被 Docker 重启绕过。[Docker restart policy](https://docs.docker.com/engine/containers/start-containers-automatically/)

## 各种启动顺序的预期行为

| 场景 | 主机/Docker/本地 DB | 已迁移的媒体实例 | 恢复动作 |
| --- | --- | --- | --- |
| NAS 已就绪，服务器后开 | 正常启动 | 校验后启动 | 检查全部消费者、任务和播放 |
| 服务器先开，NAS 稍后开 | 正常启动 | 等待；不往本地空目录写 | 独立入口周期重试挂载，成功并校验后启动 |
| NAS 长期不可用 | 本地服务继续运行 | 保持等待，告警；入口返回维护状态 | 修复 NAS/网络；不恢复 Docker 全局依赖 |
| 仅 Docker 重启 | 按本地策略恢复 | 不自动绕过检查；由独立入口重新核对 | 确认实际容器状态；live-restore 是否开启也要纳入验证 |
| NAS 在运行中断线 | 无 NAS 依赖的服务继续；不承诺整机绝无 I/O 影响 | hard NFS I/O 可能等待；关闭新任务/流量 | 同一挂载恢复后核对任务；不自动切回 SSD |
| NAS 被卸载/重挂、导出换源或出现 stale handle | 本地服务照常 | 保持维护状态 | 检查挂载身份变化，受控重建消费者；不假定容器自动看到新挂载 |
| 人工停止媒体服务做维护 | Docker/DB 不受影响 | 保持暂停 | 只有显式恢复运行意图才允许自动启动 |

这里只隔离有 NAS 依赖的业务。若其他未纳入清单的容器、cron、K8s 或监控也访问 NAS，它们仍可能受到 NAS 故障影响。前面的消费者清单是一次快照，需要在切换前复查。

## fstab 的正式候选配置

如果用户已取消原行注释，只表示恢复旧的开机挂载；原行没有 nofail/automount。正式方案将该行调整为：

```fstab
nas-storage:/volume1/data1 /mnt/nas nfs rw,_netdev,nofail,x-systemd.automount,hard,vers=3,proto=tcp,rsize=524288,wsize=524288,timeo=600,retrans=2,sec=sys,x-systemd.mount-timeout=60s 0 0
```

- 保留现场 NFSv3/传输参数和原 60s 挂载超时，本阶段不同时调优协议。
- `nofail` 让启动目标不把挂载成功当作必需条件；automount 在访问时触发挂载，访问者仍可能等待。两者不保证所有依赖 NAS 的服务都能继续启动，也不缩短 hard NFS 数据 I/O 的等待时间。
- 不设置 idle-timeout 自动卸载生产媒体挂载。NAS 来源或挂载变化时要重新检查消费者。
- `network-online.target` 不等于 NAS/NFS 服务可用。核对 `nas-storage` 的解析是否依赖尚未启动的容器/K8s；若有循环依赖，在确认固定 NAS 地址后使用受维护的本机解析或固定地址。
- 修改并备份 fstab 后，`daemon-reload` 可重新生成单元；它不等于重挂当前 NFS。当前挂载仍在使用时，不为启用 automount 执行 umount、mount -a 或 restart mount/automount。首次转换和重启安排在维护窗口。

这些选项在现场 systemd 239 的文档中已有定义。[systemd 239 mount](https://raw.githubusercontent.com/systemd/systemd/v239/man/systemd.mount.xml)

## 独立控制入口的实现约束

采用每个实例一个本地 systemd 定时检查入口，建议 30 秒周期（这是控制重试频率，不是 I/O 超时）。入口在本地 SSD 保存 `desired_state=RUN/HOLD`、审核过的卷/路径、镜像身份和迁移完成记录；两套实例的配置不能混用。

每次按顺序执行：

1. 获取本地独占锁；读取 RUN/HOLD。HOLD 时不拉起容器。维护流程必须先设置 HOLD，再排空任务和停止；不能只执行 docker stop，否则下一次检查可能重启它。
2. 查询 Docker 是否可用；不可用则记录等待。NAS 挂载任务由入口主动请求 `mnt-nas.mount`，失败后下一轮重新尝试，不把 NAS 作为检查入口本身的强制启动依赖。
3. 先读内核挂载表核对 source/type/mount ID；再用单个受控 NFS 检查核对预登记标识、两套实例各自的路径和迁移完成记录。仅 mountpoint、目录存在、ping 成功、一次 TCP 连接成功都不足够。
4. 如果从未运行且目标已完成停写校验，核对原 project/env-file/完整 Compose 顺序、父卷、只读 gateway、image ID 和原环境；明确选择媒体服务，禁用 pull/build，不使用通用部署脚本。
5. 先验 DB/Redis 可用，再启动必要应用，最后开放入口/beat/任务生产者。线上 tasks.py 与本地不同，具体排空和恢复命令须按运行版本审查。web 的 migrate、worker 的恢复任务行为须纳入切换检查点。
6. 每次检查都读真实容器/健康状态；仅 `up -d` 返回或 systemd oneshot 为 active 不能代表容器存活。已经正常运行时不反复执行 up/recreate。发生退出时，只在 NAS 身份和读写仍通过、任务恢复策略明确时恢复所需服务；持续失败应退避并告警，不无限重复数据库启动钩子。

定时入口不能依赖 `RequiresMountsFor` 成功才执行：依赖失败时程序本身可能根本没运行，不能只靠 Restart=on-failure 处理 NAS 晚到。systemd timer 的被调度 service 不使用 RemainAfterExit=yes，以免只执行一次；同一 service 尚未完成时不会再开一个实例。[systemd 239 unit](https://raw.githubusercontent.com/systemd/systemd/v239/man/systemd.unit.xml)、[timer](https://raw.githubusercontent.com/systemd/systemd/v239/man/systemd.timer.xml)

hard NFS 的检查可能卡在 D 状态。控制入口需要把网络/NFS 检查与本地状态报告分开，保留一个在途检查及其锁，不每 30 秒再创建新探测进程。只有确认前一检查结束才可重试；独立的本地 watchdog 根据上次完成时间告警。超时或 kill 不是能回收所有 D 状态操作的保证。[NFS 手册](https://man7.org/linux/man-pages/man5/nfs.5.html)

迁移完成标识放在媒体目录之外，内容包括卷名、源检查点、目标路径、校验结果及人工切换状态；在 NAS 与本地各保存对应记录。禁止由“mkdir 成功”“复制进程结束”或本次小批复制脚本直接产生 production-ready 标记。

## 运行期异常与关机

- NFS 断线：先在不依赖 NAS 的入口上阻止新请求和批量采集，暂停 beat/外部生产者。已有写入等待恢复；不能以自动退回 SSD 的方式制造两份可写库。
- 连接恢复且同一挂载仍有效：检查旧 I/O 是否完成、任务是否超时/被重复投递、媒体路径和内容，再逐步开放业务。不能直接把网络 ping 成功当作任务恢复完成。
- stale handle/换挂载：保持维护状态，待原消费者可受控停止后重新核对并重建挂载。容器 bind mount 不保证自动跟随宿主机的新挂载。
- 计划关机顺序：暂停生产者 → 排空任务 → 停止媒体消费者 → 确认无写入 → 按原流程停止主机；NAS 保持在线直到消费者退出。上电时 NAS 先开可减少等待，但方案不能依赖人工严格按这个顺序。
- 保留现有最长 10 分钟 worker stop_grace_period。不能用一个默认 90 秒的外层 TimeoutStopSec 提前强杀它；D 状态时正常停止也可能无法按期完成，需要故障处置而非强制 umount。

## 切换前的隔离验收

使用测试实例和独立路径，验证 NAS 先开、服务器先开且延迟 NAS、NAS 缺席、Docker 单独重启、容器异常退出、HOLD 维护、网络断开/恢复、挂载身份改变。每次记录“媒体未启动时无本地新文件”“父卷不变”“全部十个消费者来源一致”“DB 未被停止/重建”“任务与 Range 播放恢复”。正式生产重启演练放在复制、停写校验、回滚与备份门槛通过之后。

**本轮不安装空壳 unit，不改变现有容器 restart policy。** 现在 SSD 仍是权威源，先执行小批复制，再做全量预复制。若最终选择此 bind 备选，控制入口必须在切换前完成实现及以上验收；原生 NFS volume 路线按统一存储方案验收，不强制部署这套控制入口。整个 Docker 无需恢复那份 .conf。

如需回传当前开机配置，只需这组只读检查，不访问 NAS 文件内容：

```bash
sudo bash <<'BASH'
grep -nE 'nas-storage|/mnt/nas' /etc/fstab
systemctl show docker.service mnt-nas.mount mnt-nas.automount \
  -p Id -p LoadState -p ActiveState -p FragmentPath -p DropInPaths \
  -p RequiresMountsFor -p NeedDaemonReload
findmnt -rn -M /mnt/nas -o TARGET,SOURCE,FSTYPE,OPTIONS
getent hosts nas-storage
BASH
```
