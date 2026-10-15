# Night-All config.json → Hub 缺失供应商凭据

2026-10-14：Twitter 已切换到 Hub 自有 RapidAPI 链路后，
`external_platform_operation_blocked / credential_missing` 表示 Hub 没有可用凭据，
此时 `liveAttempted=false`，尚未调用供应商。Night-All 的 Key 不会自动成为 Hub 的 Key。

## 随服务器部署迁移

`bash scripts/manage.sh ops internal-production deploy` 和 `apply` 在 Hub Admin 就绪后、
采购价补齐前执行迁移，无需另跑导入命令，无需本机连接服务器。
沿用部署已有的 Admin Token，固定请求本机 `http://127.0.0.1:18151`。

优先使用服务器 `.env.internal` 的 `NIGHT_ALL_CONFIG_PATH`，未指定时查找已知的
Night-All 兄弟工作区。非标准目录加一行即可：

```dotenv
NIGHT_ALL_CONFIG_PATH=/实际服务器目录/Night-All/config.json
```

路径是**服务器上**的 JSON，不是开发电脑的路径。若已配置 `NIGHT_ALL_DATABASE_URL`，
Web Search 继续只走其 SQL 迁移，JSON 只负责 RapidAPI/TikHub/JustOne；
未配置 SQL 时，JSON 覆盖下表全部十一家。
每家供应商每次部署只选择一个来源，SQL 失败不会回退 JSON，
JSON 无效或写入结果不明也不会回退旧脚本。
仅自动发现不到 JSON 时保留旧 Facebook 环境凭据导入兼容行为；
显式指定的无效路径会告警，不能被其他来源掩盖。

缺失/无效来源只输出告警，不中止 Hub 启动；因此 `deploy OK` 不代表所有供应商 Key 已迁移。
查看迁移输出中每家 `migrated`、`preserved` 或 `source_*` 状态，并在 Hub 管理页核对。

## 单独预览或导入

在 Hub 仓库运行 `scripts/migrate-night-all-credentials.mjs`，显式指定
`NIGHT_ALL_CONFIG_PATH`、`MX_INSIGHT_ADMIN_BASE_URL` 和 `MX_INSIGHT_ADMIN_TOKEN`。
目标允许 HTTPS origin 或 loopback HTTP，拒绝重定向。
只从指定 JSON 读取，不执行 Night-All 代码，不回退环境 Key、其他 JSON 或数据库。

支持的映射：

| Hub 供应商 | config.json 字段 |
| --- | --- |
| rapidapi | crawlerProviders.rapidapi.apiKey |
| tikhub | crawlerProviders.tikhub.apiKey |
| justone | crawlerProviders.justOne.apiKey |
| baidu / exa / tavily / serper / you / searchapi / firecrawl / serpapi | searchApis.<供应商>.apiKey |

Web Search 沿用现有导入规则：源条目必须 `enabled=true`。
不猜测其他配置条目的归属，不创建供应商或改变操作开关。

下面在本机 **Bash** 中运行；Token 交互输入，不写入命令历史，不贴到聊天。
第一遍只读预览；将 `--dry-run` 改为 `--apply` 才会写入。

```bash
(
  cd /Users/qpjoy/workspace/qpjoy/de/de-llaaddddeerr/electron-dock/mx-insight-hub || exit
  read -r -s -p 'Hub Admin Token: ' MX_INSIGHT_ADMIN_TOKEN </dev/tty
  printf '\n'
  export MX_INSIGHT_ADMIN_TOKEN
  export MX_INSIGHT_ADMIN_BASE_URL='https://hub.minsight-ai.com'
  export NIGHT_ALL_CONFIG_PATH='/Users/qpjoy/workspace/mingxi/Night-All/config.json'
  node scripts/migrate-night-all-credentials.mjs \
    --providers rapidapi,tikhub,justone,baidu,exa,tavily,serper,you,searchapi,firecrawl,serpapi \
    --allow-readable-config --dry-run
)
```

`--allow-readable-config` 允许读取用户已有的 0644 文件；仍要求当前用户拥有的普通文件，
拒绝符号链接、组/其他用户可写文件及超大文件，不修改源文件权限。

## 写入与核验

只有 Hub 返回 `credentialConfigured=false` 且 `revision=0` 才可写入。
已有环境或数据库 Key、`revision>0` 的手动清空均保留。
写入使用原 Admin credential API 的 `expectedRevision`，并检查成功确认的
数据库来源、已配置状态及 revision 加一。冲突、超时和确认异常不会自动重试；
先在 Hub 查看状态，再重新运行以读取最新 revision。

迁移后在「外部平台 → 供应商 → API Key 管理」维护；Web Search 也可在其供应商管理页维护。
普通详情不返回明文，编辑框默认空白、密码形式；保存后清空草稿。
查看/复制已保存的 Key 仍需第二次输入 Admin Token。
单值供应商沿用原凭据存储，Web Search 沿用现有加密凭据封装。

输出只包含供应商、状态和 revision 等元数据，不含 Key、Token 或原始错误体。
`migrated` 只证明凭据已保存，不证明供应商额度、订阅或真实搜索正常。
本脚本不发起付费搜索，不改价格、授权、操作开关、代理或历史请求，不重启服务。
不改变 MX-H2I 登录或用户联网；显式配置的 Web Search SQL 来源仍保持权威。

## 本地验证

迁移器与部署接入 33 项测试通过，既有凭据存储、权限与管理界面 49 项回归通过，
原部署 shell 测试、Node/Bash 语法和 diff 检查通过。
使用合成凭据和本地/模拟 Admin API，覆盖已有 Key、人工清空、并发更新、
未知写入、来源互斥和失败隔离。生产迁移由用户在服务器 deploy 时执行；
未连接服务器写入凭据，未发起供应商搜索。
