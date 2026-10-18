# 2026-10-18 线上验收问题修复与发布

本轮对应线上页面/功能测试中的五项问题。修改覆盖数港、Hub 数港服务端、Auth 数港账号入口及其部署挂载；没有新增平台管理员角色，不改变真实供应商、支付、MX-H2I 登录或网络权限。原型只读，截图和模拟验收产物仍放工作区 `screenshot/fix-20261018/`。

## 修改结果

| 问题 | 修改 | 发布范围 |
| --- | --- | --- |
| 新建子账号503 | 补齐专用账号令牌/持久加密密钥的可选挂载与保留式配置命令；区分未配置、配置无效、结果未确认的固定诊断，页面显示请求编号 | Auth、Hub Admin、DataPort |
| 账单逐字输入丢焦点 | 读取和失败时始终保留筛选框，仅更换结果区；失败不展示旧筛选结果，加载期间禁用导出 | DataPort |
| Key长名称/脱敏Key跨列 | 固定表格列宽内允许换行，名称保留完整title，操作按钮可换行 | DataPort |
| 审计目标长路径跨列 | 固定列宽、目标和追踪编号允许断行，不覆盖结果与时间 | DataPort |
| 画像请求编号无法检索审计 | 新事件分别保留画像请求ID、页面请求ID、查询记录ID、批次ID；历史事件按同企业查询记录关联，列表/筛选/导出共享该投影，不改写旧事件 | Hub、DataPort |

同时补上报错工单的画像请求编号和 `ticket.created` 的中文名称。原画像响应、订阅消耗、旧请求幂等、平台权限、历史审计原文均不改写。

## 503的部署缺口与适用边界

此前代码读取 `MX_DATAPORT_ACCOUNT_TOKEN_FILE`、`MX_DATAPORT_CREDENTIAL_KEY_FILE` 和 Hub 的 `MX_DATAPORT_ACCOUNT_ORIGIN`，但默认 Internal 部署清单没有提供这组配置。仅重新构建并不能自动补出配置。该缺口与线上503现象吻合；尚未读取生产服务端日志，不能断言它是线上唯一原因，也不能断言上次Auth完全没有受理。

现在两端使用各自命名空间的独立 Secret `mx-dataport-accounts`：

- Auth `mx-internal-shadow`：`account-token` 和64位十六进制 `credential-key`，只读文件挂载。
- Hub Admin `mx-insight-hub`：同一份 `account-token` 和固定内网 `account-origin`；**不接收密码加密密钥**。
- DataPort 浏览器、BFF、Hub Public及其他worker不接收这些凭证；不使用平台 Admin/Ops Token 代替专用令牌。
- 挂载可选，缺配置仅使托管账号功能不可用，不阻止原 SSO、服务启动或 readiness。加密密钥必须长期保留并安全备份；后续普通部署不会生成或覆盖这两个Secret。

`accounts` 命令仅支持现有 canonical Internal Hub 与 Auth Deployment，不重启服务、不创建用户。它核对固定集群与本机就绪节点；只创建缺失Secret，不apply覆盖已有值。两端不一致、旧自定义来源、Auth Secret丢失但Hub仍有值、凭证无效均停止，要求恢复原值。Auth已保存而Hub创建失败时，可重新运行普通 `configure`，复用同一份Auth密钥。

## 发布步骤

先将本轮pro提交推送远端；服务器在仓库根同步，保留服务器已有工作区修改和部署参数：

```bash
git switch pro
git pull --ff-only origin pro
cd electron-dock/mx-dataport
bash scripts/manage.sh ops internal-production accounts status
```

### 配置账号服务（发布前）

若Auth已有合法 `mx-dataport-accounts` Secret，只需保留并补齐缺失Hub副本：

```bash
bash scripts/manage.sh ops internal-production accounts configure
```

**仅第一次配置且两端都无此Secret时**使用：

```bash
bash scripts/manage.sh ops internal-production accounts configure --initialize
```

初始化会对已运行Auth的PostgreSQL做只读检查：所有环境都不能已有数港账号命令/托管密码记录，当前Auth也不能已有凭证文件。仅检查确认首次安装后才生成专用随机令牌和加密密钥；检查失败或配置有歧义则不生成。**不能删除账号记录、Secret或旧密钥来绕过检查。** 如果以前曾成功开户、发邀请或有其他自定义挂载，应先恢复/迁入原始凭证，而非初始化新密钥。不要把Secret值发进聊天或日志。

配置过程中有专用ConfigMap锁，带主机/PID和Kubernetes UID；释放限定本次UID。进程被强行结束后如锁遗留，先核对对应主机/PID是否仍在执行，再按运维流程恢复，不能删除其他任务的锁。

### 依次发布Auth、Hub、DataPort

从当前 `electron-dock/mx-dataport` 目录执行，Auth仍使用服务器原发布参数：

```bash
cd ../mx-launcher
bash scripts/manage.sh ops internal-production deploy

cd ../mx-insight-hub
MX_INSIGHT_SYNC_LAUNCHER=0 MX_SMOKE_DATA=0 \
  MX_INSIGHT_BUILD_PROXY=http://127.0.0.1:7788 \
  bash scripts/manage.sh ops internal-production deploy

cd ../mx-dataport
MX_HARBOR_BUILD_PROXY=http://127.0.0.1:7788 \
  bash scripts/manage.sh ops internal-production deploy
bash scripts/manage.sh ops internal-production accounts status
```

各步确认就绪后继续；代理以服务器已验证配置为准。本轮无新增数据库迁移，不修改149/154等已发布迁移，Hub正常部署仍执行尚未应用的迁移。不要重复enroll、修改主账号角色或更换原加密密钥。

`status` 只证明Secret存在和两端一致，不证明运行Pod挂载与业务调用已成功。发布后先核对Auth/Hub的运行版本和挂载，再按新建子账号流程复测。

## 发布后复测

1. 先按线上失败请求 `0c36209d-8e9e-4e0d-a64f-e35e8dd04577`、时间2026-10-18 13:01:53及账号 `qa_dp_20261018a` 核对Auth和Hub是否受理；不因为员工列表为空就换新命令重复开户。需要继续时优先恢复原操作。
2. 用可丢弃托管成员验证创建、独立登录、初始密码以及受限重置。密码输入/提交由用户完成，验证旧凭据及旧会话失效；不操作主账号。
3. 账单逐字输入“年度”、删除、中文输入法、快速改关键字、清空及日期/状态组合；输入不丢焦点，最后查询条件对应最后结果，失败时可继续改筛选重试。
4. 1440×1000和390×844下查看长Key名称、脱敏前缀、长日志路径；追踪编号展开后不跨列，所有操作可达。
5. 对已有8.8.8.8查询，用画像请求ID `05bda25b-e2b8-48c5-ac52-2ec0c2d1b178`、页面请求ID `217a8501-a6b2-4141-a9d6-1ee45dab51a7`、查询记录ID `e516a1bd-2d09-4f86-aaa0-db4db4948612` 分别检索并导出，均能对应同一原始事件；不执行新查询来替代历史兼容验证。
6. 补齐前轮因开户失败阻塞的多角色、跨企业、即时撤权、私人通知、停用旧会话用例。生产不付款、不主动增加真实查询。

## 本地验证与限制

- DataPort类型检查及生产构建通过；全量86/86测试通过（0跳过），包含独立本地PostgreSQL的会话迁移。
- Hub 12项数港企业测试使用独立本地PostgreSQL全部通过，包括新增的两类请求ID/批次ID检索、历史事件保持不变、同名目标不能跨企业关联；Hub类型检查通过。
- Auth生产编译通过；3项实际本地PostgreSQL测试通过，新增Hub账号客户端→本地HTTP→实际Auth Controller→数据库的开户与原命令重放链路，只有一份身份且初始密码加密保存。
- 配置命令测试覆盖只读默认、显式首次初始化、凭证一致、部分创建恢复、既有记录/文件和自定义来源拒绝、失败不回显Secret。测试使用伪kubectl，不代表生产Kubernetes配置已执行。
- 本地合成页面已准备，无线上转发；浏览器保存的网站拒绝权限曾阻止页面验收，页面和生产复测状态以外置验证记录为准。不能用构建或单元测试替代已完成的浏览器/线上验收。

本轮没有远程部署、生产配置写入、开户、真实查询或付款。上线后503根因及恢复结果仍须按上述步骤核对。
