# systemd 239：恢复 timer 启用失败的修复

## 已确认的现场原因

2026-09-22 10:18:25，用户回传：恢复策略已经保存为 migrated，timer 的 UnitFileState 已是 enabled，但 timer inactive/dead；service 的 LoadState 为 bad-setting。日志明确拒绝 `Type=oneshot` 使用非 no 的 Restart，随后 timer 因关联 service 未加载而拒绝启动。

这是本仓库原模板的版本兼容性错误，恢复程序尚未运行；此失败未触发业务容器补启动。此前本地测试模拟了 systemd 调用，没有发现该旧版限制，不能把这些测试当成 EL8 单元加载验证。systemd v239 的检查见 [service.c 516–518 行](https://github.com/systemd/systemd/blob/v239/src/core/service.c#L516-L518)。

## 修复行为

- service 使用 `Type=simple`，保留 `Restart=on-failure`、`RestartSec=60s`、`RemainAfterExit=yes`。失败由同一 service 重试；成功退出后保留 active/exited，不持续启动新进程。simple 的 active/running 仅代表程序已启动，不能据此断言恢复完成。[v239 服务类型和 RemainAfterExit 说明](https://github.com/systemd/systemd/blob/v239/man/systemd.service.xml)
- `recovery install` 创建代码快照后，先调用服务器自身的 `systemd-analyze --man=no verify` 校验两个候选单元，通过后才替换 `/etc/systemd/system` 单元和 current 指针。校验失败时保留原单元、指针和恢复选择；候选代码快照保留用于排查。校验不会执行 ExecStart 或启动业务。[v239 verify 说明](https://github.com/systemd/systemd/blob/v239/man/systemd-analyze.xml)
- systemctl/systemd-analyze 的失败输出保存在 `/var/log/mx-static-nas/systemd-error-<id>.json`，root 私有、0600，stdout/stderr 各至多 32 KiB。错误消息给出路径，不把可能含配置值的完整输出直接打印到公共日志。
- timer 启用/启动失败时明确提示“策略已保存，尚不能确认恢复生效”；状态表将 bad-setting 显示为配置错误，不再显示成普通 inactive/dead。

## 服务器执行

同步修复后的 Git 代码，在 mx-static 目录执行：

```bash
bash scripts/manage.sh nas recovery install
bash scripts/manage.sh nas recovery enable --migrated
```

install 会校验候选、替换本工具的单元并 daemon-reload，保留 migrated 策略和项目暂停选择；不重启 Docker、数据库或 NAS。enable 会重试启动 timer，正常业务容器保持运行。当前开机已超过 60 秒，timer 可立即触发恢复检查；若恢复 helper 正持有迁移锁，稍后再执行只读检查即可。

```bash
bash scripts/manage.sh nas recovery check
bash scripts/manage.sh nas infra logs
```

预期：service 已正常加载，检查期间可能 active/running；成功后 active/exited。timer 为 enabled 且 active，触发后子状态可能为 running/elapsed。infra 已核对并纳入；delta 未迁移/等待迁移。以服务日志和实际状态为准，不把 enabled 或策略“已纳入”单独视为恢复完成。

如再次失败，统一入口会给出私有诊断路径，也可只读查看：

```bash
systemctl status mx-static-nas-boot.timer mx-static-nas-boot.service --no-pager -l
journalctl -b -u mx-static-nas-boot.timer -u mx-static-nas-boot.service -n 80 --no-pager -o short-iso
```

## 验证范围

172 项 NAS 本地测试通过。新增 6 项覆盖：候选单元校验失败保留已安装状态、私有 systemd 错误记录、Docker 错误不泄露、bad-setting 明确显示、timer 部分成功提示、保存策略后启动失败不误报成功；原安装测试现在核对校验发生在 daemon-reload 之前。Bash、Python 3.6 语法通过。

本地为 macOS，没有运行 systemd 239；服务器单元校验由修复后的 install 执行。已收到以下服务器成功回执。

## 修复后现场回执（2026-09-22）

用户同步代码后依次执行 install、enable --migrated、check，回传：

- 安装快照：`/usr/local/lib/mx-static-nas/bd7b343be731926be9c8`；安装快照与当前代码/声明一致。修复后的 install 只有在服务器候选单元校验通过后才报告安装成功。
- 策略：migrated；全局暂停为否，`disabled_parts` 为空。
- infra / part1：成功记录、容器身份和挂载一致，已纳入恢复。
- delta / part2：未迁移，等待迁移，未启动未审核项目。
- `mx-static-nas-boot.service`：active/exited，开机设置 static。服务本身由 timer 触发，无需单独 enable。
- `mx-static-nas-boot.timer`：active/running，开机设置 enabled。

该回执确认了实际服务器的安装、启用和本轮恢复检查成功；不需要重复 install/enable。成功后的 service 保留 active/exited，本轮不会每分钟持续巡检；60 秒重试针对恢复程序失败。尚未进行真实重启、NAS 晚启动或断线演练，也尚未收到业务验收和 SSD 回收完成回执。下一步按 [第一卷 SSD 回收](part1-reclaim.md) 完成业务验收后再执行精确清单回收。
