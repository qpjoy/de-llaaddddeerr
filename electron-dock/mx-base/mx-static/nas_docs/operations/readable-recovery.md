# 易读输出与已迁移项目的统一恢复

后续现场发现旧模板与 systemd 239 不兼容；已改为 simple 并加入服务器端 verify。安装/启用失败处理见 [修复记录](systemd-239-recovery-fix.md)，不能仅凭策略“已纳入”或 timer enabled 判定成功。

## 本次现场回传

2026-09-22 的输出确认：infra 十个媒体消费者仍挂载 `mx_data_raw_media_nfs_v1`，容器 running，有健康检查的服务 healthy；PostgreSQL/Redis 正常。宿主机 NFS 挂载匹配，采集时 D 状态进程数为 0。`mx-static-nas-boot.service` 和 `.timer` 都是 `not-found`，恢复列表为空；不能声称已配置开机补启动。`/data` 可用约 64.88 GiB，第一卷仍待业务验收，没有 SSD 回收完成记录。

## 显示方式

默认输出中文说明和表格，字节数转为 GiB，区分“未安装”“未配置健康检查”“业务验收待完成”。`infra status` 不再先打印全部长路径，完整位置仍由 `infra locate` 查看。

```bash
bash scripts/manage.sh nas project list
bash scripts/manage.sh nas host status
bash scripts/manage.sh nas infra status
bash scripts/manage.sh nas recovery check
```

保留机器可读格式，不需要 jq 或额外 Python 包：

```bash
bash scripts/manage.sh nas infra status --json
bash scripts/manage.sh nas project list --pretty
```

`--json` 是原始输出（状态命令为逐行 JSON 事件），适合已有脚本处理；`--pretty` 将事件 JSON 缩进显示。格式参数可放在 nas 后任意位置，一次选一种；`--human` 显式选择默认易读模式。原始 `journalctl` 日志、迁移报告、操作审计和底层 Python 工具继续使用原格式。通过统一入口查看 logs 时仅格式化显示，不改日志本身。失败退出码不会因格式化而变成成功。

宿主进程筛选已排除名称里偶然包含 `rpc/lockd` 的 frpc/kblockd，非 NAS 的 binfmt autofs 也不列为 NAS 挂载；仍列出全部采样到的 D 状态进程，不把 D 状态直接判定为 NFS 故障。

## 一次启用统一模式

同步修改到服务器后：

```bash
bash scripts/manage.sh nas recovery check
bash scripts/manage.sh nas recovery install
bash scripts/manage.sh nas recovery enable --migrated
bash scripts/manage.sh nas recovery check
```

第一/四条是只读统一检查。install 安装当前代码、全部项目声明和持久 systemd 单元，保留已有选择。enable 明确启用“已迁移项目统一管理”模式；会再次核对当前媒体服务/数据库健康、安装快照与当前代码和声明一致。存在未通过检查且未暂停的项目时，启用失败，策略不修改。systemctl 自身若失败，以实际错误与状态为准，不能把已保存设置当成 timer 已生效。

旧设置默认保持逐项目模式，不因更新代码自动启用。统一模式保存在 root 私有的 `/etc/mx-static/nas/auto.json`，不是依靠操作者记住一份 enable 清单。

每次开机重新检查 Git 登记的项目和任务，满足以下条件才补启动：

1. 有对应任务的私有成功切换报告，身份匹配，最终同步通过，NAS 已成为写入来源，阶段为 `running_on_nas`。
2. 本项目有经过审核的恢复适配；实际容器 ID、配置、挂载和原生 NFS 卷参数通过既有检查。
3. 当前项目与全局均未暂停。

容器已正常运行时不重启。数据库和队列继续由原部署平台管理；此工具不执行复制、清理、应用升级或恢复旧 SSD。只完成复制、不完整切换、配置漂移、已使用登记 NAS 卷却缺少成功报告，都不会被静默接受。

`recovery check` / `recovery status` 不带项目名时列出全部登记项目：已核对、尚未迁移、需要处理、遗漏未启用、全局/项目暂停，以及安装快照和单元状态。表格“已纳入”表示策略选择，开机实际生效还要看 timer 是否安装/启用。检查范围是 mx-static 已登记任务，不能保证发现从未登记的任意 Docker/K8s 业务。

## 明晚 Delta 或以后其他业务迁移后

统一模式已启用后，无需逐个 `recovery enable <项目>`。迁移交付仍必须包括：

- 该实例真正成功切换并产出报告；
- 在 mx-static 登记正确的报告、挂载声明和已审核的恢复适配；
- 运行 `recovery install` 更新服务器安装快照，再 `recovery check` 确认覆盖。

只有 JSON 中写 `nas_authoritative=true` 不足以纳入；也不能把 infra 的容器 ID/报告/适配借给 delta。当前 delta 仍只有预复制能力，恢复适配尚未实现；本轮不会把它当成已迁移项目。将来补齐 Delta 实例迁移和恢复适配后，统一策略会自动选择它，不需要再维护独立的 enable 列表。

## 维护时暂停

```bash
bash scripts/manage.sh nas recovery disable infra
bash scripts/manage.sh nas recovery enable infra
bash scripts/manage.sh nas recovery disable
bash scripts/manage.sh nas recovery enable --migrated
```

四条分别用于暂停一个项目、解除该项目暂停、暂停全部、恢复统一策略；不是要顺序执行。单项目暂停作为例外保存，重新 install 和重新启用统一模式都不会清掉这个例外。全局暂停时，解除某个项目暂停不会解除全局暂停。业务容器不会因这些 disable 命令而停止。全局暂停不等待迁移锁，因此恢复 helper 等待时也能保存暂停设置并请求停止 helper；已经提交到 Docker 的单次启动不能据此保证撤销。批次在开始下一个项目之前重读暂停设置。

统一开机服务成功后结束，不是持续扫描的守护程序；运行期断线仍按既有 hard NFS 和 Docker 策略处理。普通项目检查/恢复报错会记录并继续处理其他项目，最终返回失败供 systemd 重试；底层 Docker/NFS 调用无返回时仍等待，不强杀、不制造重复启动。

## 验证

166 项 NAS 本地测试通过，本轮新增 26 项覆盖中文/JSON 显示、失败退出码、风险提示保留、非 NAS 进程过滤、统一路由、旧配置兼容、完整切换记录及适配门槛、遗漏提示、后续迁移自动发现、配置漂移拒绝、安装快照漂移、项目/全局暂停、批量恢复失败隔离。另通过 Bash 与 Python 3.6 语法检查。

尚未在服务器执行安装、启用或重启；实际 EL8/NFS/开机恢复以现场回执为准。
