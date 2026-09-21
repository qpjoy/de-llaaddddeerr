# NAS 后端验证（OSS 暂缓）

已知：客户端 NFS 读写、基础属性与 1.513 GiB 短测试通过。用户确认是新购的四盘位群晖，具体型号未知；实际文件系统、存储池/硬盘健康和快照仍未知。用户确认当前没有独立备份。NFS 是协议，不能从客户端 `df -T /mnt/nas` 推导 NAS 后端是 Btrfs/ext4/ZFS 或 RAID 健康。

用户最新决定：群晖管理凭据已遗忘，SSH 22 连接超时，先推进保留源数据的在线预复制，不再把取得 NAS 管理端信息作为预复制前置条件。暂不进行阿里云 OSS 备份，不采购资源、不上传文件；下方价格仅保留为历史预算，不作为本轮迁移前置条件。保留“目前无独立备份”的事实，NAS 健康检查不能替代备份。

服务器端 network/df 已回传：eno2 为 1000 Mb/s、full duplex、MTU 1500，NFSv3 hard/TCP，/data 剩余 57G（97%）。已通过的 NFS 写入、权限、小批校验和短时吞吐足以开始保留原数据的 [po_infra 在线预复制](two-night-migration.md)，无需 NAS SSH 登录。后端健康状态保留为未确认，不伪造通过结论；以下管理端检查留待具备访问条件时补充，本轮不重置 NAS/账号或继续猜测登录信息。之后仍需文件一致性、实际容器权限、Docker NFS 子目录挂载及启动/故障恢复验证，才进入最终切换。

## NAS 管理入口（当前暂缓，不阻挡预复制）

在当前服务器 `mx-internal-server`（192.168.1.2）的终端执行下面命令，把 `NAS用户名` 替换为 NAS 自己的管理账号；服务器的 root 身份不代表 NAS 也接受 root 登录，NFS 挂载可用也不代表 SSH 已开启。

```bash
ssh -o ConnectTimeout=10 NAS用户名@192.168.1.3
```

默认连接 TCP 22。如果 NAS 配置了其他 SSH 端口，使用实际端口的 `-p` 参数；不要猜用户名/密码或把密码贴回对话。首次连接按 NAS 的 SSH 主机密钥指纹核对提示，不关闭主机密钥检查。登录成功后先运行 `hostname`、`id`，确认进入 NAS，再执行下方检查；检查结束用 `exit` 返回服务器。[OpenSSH 说明](https://man.openbsd.org/ssh)

- `Connection refused`：22 端口没有接受 SSH 连接，可能未开启服务、端口不同或被防火墙明确拒绝，先核对 NAS 管理端。
- `Connection timed out`：SSH 通道未建立，核对 NAS SSH 监听、端口及两端防火墙；NFS 可用不证明 SSH 端口可达。
- `Permission denied`：连接到了 SSH 服务，但登录认证失败，核对 NAS 账号及其 SSH 权限。

若 NAS 未开启 SSH，先使用 NAS 管理网页查看品牌型号/存储池/硬盘/快照状态；确需 SSH 时，在 NAS 管理端按厂商方式开启并限制到管理网络，无需开放到公网。远程电脑无法直达 NAS 网页时，可经当前服务器做仅绑定本机 127.0.0.1 的 SSH 本地端口转发；需要实际 NAS 网页协议/端口和你现用的服务器连接地址，不能把服务器内网 IP 或某厂商默认端口当作已确认值。此处不自动改 NAS/服务器配置。

## NAS 端只读检查

在 **NAS 自己的 SSH 终端**粘贴以下内容，不能在 mx-internal-server 上用 `/mnt/nas` 代替 `/volume1`。不需要上传项目/压缩包；使用有读取权限的管理员终端，没有相应命令或权限时保留输出，不安装工具或启动磁盘测试。

```sh
sh <<'SH'
if [ ! -d /volume1 ]; then
  echo 'Expected NAS /volume1 not found; stop and report NAS brand/model.'
  exit 1
fi
uname -a
if [ -r /etc.defaults/VERSION ]; then cat /etc.defaults/VERSION; fi
df -h /volume1
if [ -r /proc/mounts ]; then awk '$2 == "/volume1" {print}' /proc/mounts; fi
if [ -r /proc/mdstat ]; then cat /proc/mdstat; fi
if command -v lsblk >/dev/null 2>&1; then lsblk -o NAME,TYPE,SIZE,FSTYPE,MOUNTPOINT; fi
if command -v btrfs >/dev/null 2>&1; then
  btrfs filesystem show /volume1
  btrfs device stats /volume1
fi
SH
```

没有 SSH 时，提供 NAS 品牌/型号、存储管理界面的文件系统、存储池健康、硬盘健康及快照功能状态即可。上面命令仅提供线索：没有 md 阵列或没有 btrfs 命令不等于故障；健康 md 状态也不能替代全部磁盘 SMART/厂商健康评估。Btrfs device stats 不使用清零参数，不执行 scrub、修复、重组或 SMART 自检。它读取已记录的设备 I/O 错误计数，非零值还需结合时间和厂商状态判断。[Btrfs 官方说明](https://btrfs.readthedocs.io/en/latest/btrfs-device.html#subcommand)

服务器侧的 `bash scripts/nas-audit.sh network` 则只读本机路由、NIC 和内核 NFS 信息，不访问 NAS 文件、不改变网络或挂载。

## OSS 历史预算（2026-09-22 查询，本轮暂缓）

按阿里云**公共云中国内地、本地冗余、按量存储**估算，1 TiB=1024 个计费 GB。官方价格页同时列出目录价与官网折扣价；以下优先用官网折扣价，最终以账户实际账单/订单为准，未购买资源包或创建收费资源。

| 类型 | 官网折扣 元/GB/月 | 1 TiB 月存储费 | 目录价对应月费 |
| --- | ---: | ---: | ---: |
| 标准 | 0.09 | 92.16 元 | 122.88 元 |
| 低频 | 0.07 | 71.68 元 | 81.92 元 |
| 归档 | 0.03 | 30.72 元 | 33.79 元 |

按上述标准折扣单价，po_infra 497.47 GiB 约 **44.77 元/月**，两卷 1,426.04 GiB 约 **128.34 元/月**，仅为存储费。实际计费还取决于对象数量、版本保留和所选功能。[OSS 官方价格](https://cn.aliyun.com/price/detail/oss)

普通公网上传流量不收费，请求费另计；不启用传输加速。下载恢复回本地需要公网流出费，当前目录价闲时 0.25 元/GB、忙时 0.50 元/GB，即 1 TiB 约 **256–512 元**，另加适用的取回/请求费。低频和归档读取也有取回计费，不能只用月存储费衡量恢复成本。[流量费用](https://help.aliyun.com/zh/oss/traffic-fees)、[价格表](https://cn.aliyun.com/price/detail/oss)

低频至少按 30 天、归档至少按 60 天计算最低存储时长，提前删除/覆盖可能补收；非标准类型小对象按至少 64 KiB 计量。归档通常需要解冻或另外计费的直读，不适合作为本次立即回滚的唯一副本。[存储费用](https://help.aliyun.com/zh/oss/storage-fees)、[存储类型](https://help.aliyun.com/zh/oss/user-guide/overview-53/)

建议迁移验证期若使用 OSS，先选私有标准存储以便恢复，稳定后再评估生命周期转归档。它是独立备份目的地，不把 PostgreSQL/队列运行目录直接挂 OSS，也不把云端备份代替 NAS 生产卷。备份要包含内容校验清单、数据库一致备份和部署/任务恢复记录；后续需要保留历史版本及限制删除权限，避免把源端误删同步成唯一副本的删除。

外网上行可能决定首次备份能否今晚完成：仅按传输量算，497.47 GiB 在 100 Mb/s 上行约 11.9 小时，1 TiB 约 24.4 小时；1 Gb/s 才分别约 1.19/2.44 小时，均未计协议开销。局域网 NAS 的 55.4 MiB/s 不能当成 OSS 上行速度。当前只做预算，不自动开通或上传，也不因此延迟安全的 NAS 在线预复制。
