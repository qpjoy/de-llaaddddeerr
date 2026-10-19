# 取消企业超管专属码二次校验

2026-10-19 用户明确要求移除“验证企业超管身份”。超管完成原有 MX 登录并取得 DataPort 应用准入后，按当前有效企业成员关系和角色直接进入系统，无须额外 owner 专属码。

- DataPort 移除验证表单、页面权限门禁及 challenge BFF 白名单；会话仍要求有效企业权限结构。
- Hub 不再读 owner_codes/owner_sessions 裁剪权限；移除 challenge 路由、专属码配置 API、Hub 配置页面和菜单。保留 ownerChallengeRequired:false 兼容旧前端。
- MX 登录与首次应用准入、有效企业/成员/角色、独立员工首次改密、网关及 Origin/CSRF 检查继续执行。没有新建或提升任何账号权限。
- 不删除旧表、摘要或审计记录，不新增迁移，不重置账号/密码或轮换密钥。历史审计动作名称仍可显示。

## 验证

本地隔离 PostgreSQL 回归验证无 owner code/session 记录时超管可读取授权页面、新会话无须专属码，旧数据保持不变；跨企业、普通员工 owner 操作、停用成员/企业/身份继续拒绝。HTTP 会话保留完整权限，旧 challenge 与 owner-code 写接口返回404。员工登录、首次改密、退出及网关/Origin/CSRF 回归继续执行。自动化结果与生产浏览器验收分开记录；尚未发布复测，不代表全量验收通过。

本地结果：Hub 企业与浏览器 SSO 路由24项通过（隔离 PostgreSQL，无跳过）；DataPort 全套94项通过，另将原先跳过的数据库会话迁移用例单独连接隔离库执行通过，共95项。Hub/DataPort 类型检查及生产构建通过。DataPort 构建资源为 main-D_79CX4G.js，Hub 主资源为 index-C4y2nu9o.js。

## 发布

同步本次 pro 后，**先 Hub，后 DataPort**；只部署数港不能解除旧 Hub 后端门禁。无需部署 Launcher/Auth/Pay，不执行 enroll 或旧邀请码初始化。

在服务器的 electron-dock/mx-insight-hub 中：

```bash
MX_INSIGHT_SYNC_LAUNCHER=0 MX_SMOKE_DATA=0 MX_INSIGHT_BUILD_PROXY=http://127.0.0.1:7788 bash scripts/manage.sh ops internal-production deploy
```

Hub 发布并就绪后，在 electron-dock/mx-dataport 中：

```bash
MX_HARBOR_BUILD_PROXY=http://127.0.0.1:7788 bash scripts/manage.sh ops internal-production deploy
```

发布后在原超管标签刷新，再验证退出重登和企业账号直达页无须专属码。若部署仍 rollout 超时，应先核对当前副本版本和就绪状态，不把超时当发布成功。功能验收流程 AUTH-03～06、PLAT-01～03 已按本轮要求修订；旧验收记录仍仅代表当时要求。
