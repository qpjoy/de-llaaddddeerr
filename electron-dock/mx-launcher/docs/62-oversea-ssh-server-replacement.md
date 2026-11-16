# Oversea 换机同 IP：SSH 恢复

适用现场：`mx-oversea-us01`，`root@34.218.136.162:22`。2026-11-16 按仓库当前部署清单和
SSH 实现整理；本次没有连接生产集群，不能将本地测试视为线上修复完成。
本轮未上线任何改变，也不新增 Launcher SSH 接口或界面字段；正常新服务器的 Bootstrap 流程保持现状。

## 故障边界

服务器重装/替换后，IP 相同也可能出现两个独立错误：

- `REMOTE HOST IDENTIFICATION HAS CHANGED` / `Host key verification failed`：Internal 仍信任旧服务器的主机公钥。
- `Permission denied (publickey,password)`：已连接到新机，但新机尚未授权 Internal 的 SSH 公钥，或者用户名/密码/sshd 策略不匹配。

**IP 没变，不需要修改 Host 地址；需要更新的是 `known_hosts` 中旧服务器的主机公钥。**
如果新服务器已经保留 Internal 公钥的登录授权，更新 `known_hosts` 并验证即可，不需要重新 Bootstrap。

截图中的私钥在 Internal Pod 的 `/app/artifacts/ssh/mx-oversea-us01_rsa`。
新服务器缺少授权时，应将这把私钥对应的**公钥**追加到新机 `root` 的 `authorized_keys`，
不需要删除 Profile、轮换 Launcher 私钥或新建站点。

当前部署清单：namespace `mx-internal-shadow`，Deployment `mx-launcher-internal`，
container `internal-api`。`/app/artifacts/ssh` 挂载独立 PVC `mx-launcher-internal-ssh`，
本地 PV 对应 `/var/lib/mx-launcher/k8s/internal-ssh`。现场若使用不同 namespace/路径，先核对再执行。

已经验证 `SSH_OK` 时，新机已接受原公钥，无需再次复制。同一 K8s 节点上保留 PVC 和宿主机目录，
Pod/容器重建后可继续使用原私钥；当前底层是 hostPath，调度到其他节点、宿主机更换、底层磁盘
丢失或删除上述目录属于不同情况，需要迁移或恢复 SSH 数据备份。
后续 Docker/Hysteria2 安装、Elastic IP 换机与原机换 IP 的服务恢复见
[63 · Oversea 服务检查与恢复](63-oversea-service-recovery.md)。

## 可选脚本：只更新 known_hosts 后验证

先从**新服务器的云控制台/已核验的管理会话**取得主机指纹：

```bash
ssh-keygen -lf /etc/ssh/ssh_host_ed25519_key.pub -E sha256
```

记录输出中的完整 `SHA256:...`。扫描结果只是候选指纹，不能用扫描输出自证可信。
这是 [OpenSSH ssh-keyscan 手册](https://man.openbsd.org/ssh-keyscan) 要求单独核对的原因。

在生产 Kubernetes 控制机的新版仓库中：

```bash
cd /path/to/de-llaaddddeerr/electron-dock/mx-launcher
kubectl config current-context
kubectl -n mx-internal-shadow get pods -l app.kubernetes.io/name=mx-launcher-internal
bash scripts/k8s-ssh-repair.sh refresh 'SHA256:替换为新服务器控制台的指纹'
bash scripts/k8s-ssh-repair.sh verify
```

这两个命令使用 `kubectl exec` 进入现有 `internal-api`，无需发布新版后端：

1. 扫描并核对指定指纹，只信任匹配的那把主机公钥；保留 HostKeyAlias 与 IP 的匹配项。
2. 备份旧文件后原子替换本站 `known_hosts`。扫描失败、指纹不匹配或文件含其他站点时停止。
3. 使用原私钥和 `StrictHostKeyChecking=yes` 做无密码验证。

验证成功即完成。只有返回 `Permission denied`、确认新机缺少授权时，才需要补装原公钥。
如果使用密码安装，可运行 `bash scripts/k8s-ssh-repair.sh install-password`，交互输入新机密码；
密码不进入命令参数或日志。密码认证被禁用时，通过已有服务器控制台安装公钥即可。先运行：

```bash
bash scripts/k8s-ssh-repair.sh public-key
```

把输出的公钥通过新机云控制台追加到 `/root/.ssh/authorized_keys`，保留已有其他授权项，
目录权限 `700`、文件权限 `600`，再运行：

```bash
bash scripts/k8s-ssh-repair.sh verify
```

也可选用 `repair 'SHA256:...'` 一次执行更新和验证；它只在公钥认证失败时提示密码安装，
空密码会显示可供控制台安装的公钥。
其他 namespace、站点、端口和路径的覆盖参数见 `bash scripts/k8s-ssh-repair.sh --help`。

这个恢复过程不执行 `kubectl set env`、`rollout restart`、镜像更新或数据库变更；不会执行
Domestic handoff、WG key sync、用户订阅同步、HY2 重装或 `Sync Remote`。
仅恢复 SSH 不代表新服务器已具备原有 Hysteria/Caddy 服务；远端业务恢复应另行检查，不能由
SSH 恢复脚本自动覆盖用户配置。

## 尚未同步脚本时的直接 kubectl 入口

进入正在运行的容器（[kubectl exec 文档](https://kubernetes.io/docs/reference/kubectl/generated/kubectl_exec/)）：

```bash
kubectl -n mx-internal-shadow exec -it deployment/mx-launcher-internal -c internal-api -- bash
```

在容器内执行以下代码；`expected` 必须替换为新机控制台指纹。此段只更新本题的专属文件，
发现其他主机条目时停止，不删除整个 SSH 目录：

```bash
set -eu
site=mx-oversea-us01
host=34.218.136.162
expected='SHA256:替换为新服务器控制台的指纹'
key="/app/artifacts/ssh/${site}_rsa"
known="/app/artifacts/ssh/known_hosts.${site}"
test -s "$key"
candidate=$(mktemp "${known}.candidate.XXXXXX")
trap 'rm -f "$candidate"' EXIT
ssh-keyscan -T 5 -t ed25519 -p 22 "$host" > "$candidate"
actual=$(ssh-keygen -lf "$candidate" -E sha256 | awk '{print $2}' | sort -u)
test "$actual" = "$expected" || { echo '指纹不匹配，未修改'; exit 1; }
if test -e "$known"; then
  awk -v host="$host" -v site="$site" '
    /^[[:space:]]*#/ || /^[[:space:]]*$/ { next }
    { n=split($1,a,","); for(i=1;i<=n;i++) if(a[i]!=host && a[i]!=site) exit 1 }
  ' "$known" || { echo '文件包含其他主机或特殊条目，停止'; exit 1; }
  cp -p "$known" "${known}.bak.$(date +%s)"
fi
awk -v host="$host" -v site="$site" '!/^#/ && NF>=3 {print host "," site, $2, $3}' "$candidate" > "${candidate}.pins"
mv "${candidate}.pins" "$candidate"
chmod 600 "$candidate"
mv "$candidate" "$known"

if ! ssh -F /dev/null -i "$key" -o IdentitiesOnly=yes \
  -o BatchMode=yes -o ConnectTimeout=10 -o StrictHostKeyChecking=yes \
  -o "UserKnownHostsFile=$known" -o "HostKeyAlias=$site" -o CheckHostIP=no \
  "root@$host" 'whoami; hostname'; then
  echo '按错误分支处理：Permission denied 才需要补授权公钥'
fi
```

若最后一步只是 `Permission denied`，在**同一个容器会话**继续以下命令，交互输入新机密码：

```bash
pub=$(ssh-keygen -y -f "$key" | awk '{print $1 " " $2}')
ssh -F /dev/null -o BatchMode=no -o PubkeyAuthentication=no \
  -o PreferredAuthentications=password,keyboard-interactive \
  -o ConnectTimeout=10 -o StrictHostKeyChecking=yes \
  -o "UserKnownHostsFile=$known" -o "HostKeyAlias=$site" -o CheckHostIP=no \
  "root@$host" "set -eu; umask 077; mkdir -p \"\$HOME/.ssh\"; touch \"\$HOME/.ssh/authorized_keys\"; grep -qxF '$pub' \"\$HOME/.ssh/authorized_keys\" || printf '%s\\n' '$pub' >> \"\$HOME/.ssh/authorized_keys\"; chmod 700 \"\$HOME/.ssh\"; chmod 600 \"\$HOME/.ssh/authorized_keys\""
```

再运行上一段的无密码 `ssh` 验证。网络超时/拒绝连接应检查新机 TCP 22、安全组和 sshd；
不要反复清空指纹、关闭 Strict 检查或用 Rotate 掩盖这些错误。

## Launcher 现有操作流程

在 Internal 的 `SSH Access` 中选择已保存的 `mx-oversea-us01` Profile，确认仍为
`root@34.218.136.162:22`，**Rotate 保持不勾选**：

1. 已确认换机、仅主机公钥变化时，可用现有 **Refresh Host Key** 重新扫描保存主机公钥。
2. 重新执行只读检查；若验证成功，无需 Bootstrap 或其他部署操作。
3. 只有认证失败且新机缺少 Internal 公钥时，再填一次性密码、保持 **Rotate 不勾选**，点击现有 **Bootstrap Key**。
   密码 Bootstrap 沿用现有环境门禁；门禁关闭时可使用上面的 K8s 恢复，不必为了此事滚动 Internal API。
4. **Run Readonly Probe** 的实际执行仍遵循现有 env/policy/request 三层门禁；被 gate 阻止不等于 SSH 失败。

现有 **Refresh Host Key** 与 **Bootstrap Key** 共用后端 bootstrap 流程：除了扫描
`known_hosts`，还会处理 SSH key/config 文件并保存 Profile，因此不能把它视为仅写
`known_hosts` 的操作。如果本次严格限定只更新该文件，使用上面的 `refresh` 脚本或直接
`kubectl` 段落。单独 **Save Profile** 不会修复旧主机公钥。

普通新服务器仍按已有流程填写 site、host、user、一次性密码后执行 **Bootstrap Key**；
此次文档和可选恢复脚本不改变该流程，也不要求增加任何界面输入。

## 验收与回退

- 无密码 SSH 返回 `root` 和新机 hostname；Internal 中只读检查通过。
- 原 Identity 文件内容不变；其他站点 SSH、Domestic WG、MX-H2I 登录/联网配置不变。
- 只回退误更新的 `known_hosts` 时，将本次输出的备份文件复制回原路径并保留 `600` 权限。
  旧 pin 对新服务器通常仍会失败；不能用回退旧 pin 替代核对新主机身份。
- 可选脚本的本地回归覆盖：指纹不匹配/扫描失败保留旧文件、非默认端口 alias、共享文件保护、
  原私钥保留、密码安装幂等、密码不进入参数或日志、导入私钥 comment 的安全处理。

此文的原地恢复不需要部署 Launcher 新代码；本轮未对线上执行修复，不声称生产登录与联网已现场验收。
