# 数港平台管理与 taku 授权

本轮代码位于 `pro`。平台管理是统一 MX 认证中的独立应用授权：角色 `mx-dataport-admin`（数港平台管理员），scope `mx:dataport:admin`。用户名 `taku` 本身不产生权限；也不自动向 `root`、MX Admin、Hub 管理员或企业 owner 授权。

## 网页入口

部署后，在 Launcher「成员与访问 → 用户与账号」搜索 `taku`，打开账号，保留原角色并勾选「数港平台管理员」，保存。保留原密码和应用准入设置。若数港被明确禁止，应先核实并由管理员单独处理；角色不会绕过应用禁止规则。

用 `taku` 登录数港后，左侧出现「平台管理」，网址为 `https://dataport.minsight-ai.com/#/platform`。此页面独立于企业超管的邀请码验证：平台管理员可以开通企业，无需先拥有个人企业，但访问企业业务页面仍须真实成员权限和超管验证。

- 企业列表按名称搜索并服务端分页。平台管理员可查看企业名称及有效超管的账号资料、邀请码配置状态，不返回邀请码原文、密码或业务记录。
- 「创建企业」只建立企业，不自动把平台管理员加入企业，也不发放产品、额度、Key 或订阅。
- 「添加企业超管」可创建新 MX 账号，或邀请已有 MX 账号。已有账号须用邀请指定的账号登录并确认加入；邀请 24 小时有效，发起人的数港管理员授权撤销或账号/企业停用后不能再使用。
- 新账号仍由统一 MX 认证管理，只获得数港准入，不获其他应用管理权限。企业超管权限在 Hub 内绑定。初始密码按原账号链路加密，只有显式点击查看时返回；超管修改密码后原初始密码失效。关联已有账号不能查看其密码。
- 为已加入的超管点击「配置邀请码」或「重置邀请码」，可输入 12–128 位专属码或生成随机码。专属码用于超管登录验证，与 Launcher 的注册邀请码不同。只存 scrypt 摘要，不支持回显；保存前妥善记录并交付。重置即使原超管会话许可失效。
- 创建企业和开户使用稳定命令 UUID；未确认的命令保留在当前登录成员的浏览器会话存储中，刷新或重新打开页面后沿用原编号重试。未知结果不能换编号重建；确认无副作用的账号已存在/输入错误可重新填写。
- 普通成员、企业超管及仅有 MX/Hub 管理员角色的账号不能使用此入口或对应 API。BFF 仅允许明确的平台企业管理路由，Hub 每次重新验证 MX 身份及数港 scope；不转发原 Hub 通用管理接口，不向浏览器交付平台令牌。

## 首次配置账号服务文件

如果上一轮已手工配置账号服务，必须保留并复用原 token 和加密密钥，先备份并迁移到下述 Secret；不要重新生成密钥，否则已有初始密码密文无法解密。先检查两个 namespace 中是否已有 `mx-dataport-accounts`。已有 Secret 时跳过创建并保留原值；两端 token 必须相同。

首次尚未配置时，在部署服务器仓库根目录执行（仅在两端 Secret 均不存在、无历史账号密钥时）：

```bash
umask 077
mkdir -p electron-dock/mx-dataport/secrets/accounts
# 已存在文件必须复用，不覆盖
[ -f electron-dock/mx-dataport/secrets/accounts/token ] || openssl rand -hex 32 > electron-dock/mx-dataport/secrets/accounts/token
[ -f electron-dock/mx-dataport/secrets/accounts/credential-key ] || openssl rand -hex 32 > electron-dock/mx-dataport/secrets/accounts/credential-key
kubectl -n mx-internal-shadow create secret generic mx-dataport-accounts \
  --from-file=token=electron-dock/mx-dataport/secrets/accounts/token \
  --from-file=credential-key=electron-dock/mx-dataport/secrets/accounts/credential-key
kubectl -n mx-insight-hub create secret generic mx-dataport-accounts \
  --from-file=token=electron-dock/mx-dataport/secrets/accounts/token
```

命令使用服务器原有、已核对的集群 context。`create` 遇到已存在会拒绝覆盖；不要改成自动覆盖来绕过冲突。部分完成时仅补齐缺失的一端，并复用已保存文件；不得一端生成新 token。私有文件不能提交 Git，须与 Auth 数据共同安全备份。

本轮部署清单已挂载该独立 Secret：Auth 同时只读挂载 token 和 credential-key；Hub Admin 仅挂载 token，origin 指向现有 Launcher Internal Service。文件缺失只使相关数港开户/密码/邀请确认功能失败，不阻塞其他应用启动或登录。

## 同步与部署

先把本地 `pro` 推送成功，再在服务器仓库根目录同步：

```bash
git fetch origin
git switch pro
git pull --ff-only origin pro
```

服务器首次尚无本地 pro 时使用 `git switch --track origin/pro`。若有未提交改动或分支分叉，先核实和保留，不能强制重置。随后按 Auth → Hub → DataPort 顺序，逐段在对应目录执行：

```bash
cd electron-dock/mx-launcher
MX_INSIGHT_HUB_DEPLOY=0 MX_LAUNCHER_BUILD_PROXY=http://127.0.0.1:7788 \
  bash scripts/manage.sh ops internal-production deploy
```

```bash
cd ../mx-insight-hub
MX_INSIGHT_SYNC_LAUNCHER=0 MX_SMOKE_DATA=0 MX_INSIGHT_BUILD_PROXY=http://127.0.0.1:7788 \
  bash scripts/manage.sh ops internal-production deploy
```

```bash
cd ../mx-dataport
MX_HARBOR_BUILD_PROXY=http://127.0.0.1:7788 \
  bash scripts/manage.sh ops internal-production deploy
```

保留原服务器部署所需的其他环境参数。Hub 由原流程新增执行 migration `151_dataport_platform.sql`，依赖已应用的 `149_dataport_enterprise.sql`；不改写旧迁移。Auth 发布后会登记内建数港管理员角色，但不会自动给任何用户名授权；需按上文给 `taku` 明确勾选并保存。

本地合成页面/独立数据库验证不代表线上已发布或 `taku` 已获权。授权完成后，刷新数港会话可看到入口；撤销角色后下一次服务端请求即拒绝，页面聚焦或定时刷新后隐藏入口。验收使用已有记录及账号权限，不需调用付费查询或付款。
