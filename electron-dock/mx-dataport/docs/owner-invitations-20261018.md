# 企业超管的 DataPort 专用邀请

2026-10-18 用户确认：企业超管仍需 Launcher 用户中心“注册与邀请”签发的 DataPort 专用邀请；员工使用数港独立子账号。此前将 MX 邀请准入一并关闭导致企业 B 已注册、已加入 Hub 企业仍无法进入数港，本次恢复这条受控流程。

## 开通与权限

1. 管理员在 Launcher 用户中心 → 注册与邀请，核对 DataPort 注册方式为“邀请码注册”，邀请用途选择“DataPort 注册与首次进入（仅开通 DataPort）”，按测试需要限定名额和期限。保留现有默认/Hub 策略；全局明确关闭时仍拒绝准入，不自动扩大其他应用注册。
2. 已有 MX 账号在数港“企业超管 · MX 登录”填写原账号、密码和专用邀请码；新超管可在该入口选择“邀请码注册”，填写账号、密码、确认和专用邀请码。已开通账号之后登录可留空邀请码。
3. 普通统一邀请、其他来源、过期/撤销/满额邀请码不能开通。已有 MX 首次兑换只追加数港准入，不修改密码、资料、角色和其他应用；成功后重试不再扣名额。显式禁用优先，关闭策略继续生效。
4. 邀请只开通数港应用，不创建 Hub 企业关系、owner 或平台管理员。企业 B 已完成 Hub 所有者邀请，使用 `qa_dp_20261018_b_owner` 原账号开通即可，无需重新注册。已有企业超管专属码校验保持原流程；它与 Launcher 的应用准入邀请码不是同一凭据。
5. “子账号登录”不展示 MX 注册、确认密码或专用邀请码，仍调用独立员工登录接口。独立员工创建/改密/会话继续由 Hub `dataport` schema 处理。

## 发布

需要发布 **Launcher Internal API/Auth → DataPort**。Launcher 桌面“注册与邀请”已有专用邀请界面，无需为本次修改更新桌面程序；Hub 复制修复已单独发布，本次没有 Hub 代码/迁移。

在 Internal 服务器同步本次 `pro`，沿用原环境参数和已验证代理，例如：

```bash
cd ~/mx/workspace/de-llaaddddeerr/electron-dock/mx-launcher
git pull --ff-only origin pro
MX_INSIGHT_HUB_DEPLOY=0 MX_LAUNCHER_BUILD_PROXY=http://127.0.0.1:7788 \
bash scripts/manage.sh ops internal-production deploy

cd ../mx-dataport
MX_HARBOR_BUILD_PROXY=http://127.0.0.1:7788 \
bash scripts/manage.sh ops internal-production deploy
```

使用现有部署档案、数据和密钥，不执行 identity init、重新 enroll 或账号服务初始化。邀请码、密码和管理 Token 由使用者在页面亲自处理，不发到聊天或测试报告。

## 验证边界

本地执行真实原生账号处理器的密码先校验、邀请码传递、失败重试、已开通免兑换和来源/客户端约束；注册及 OIDC 的数据库集成测试覆盖名额、重复请求、失效、显式禁用、凭据不变及旧会话撤权。真实 PostgreSQL 与监听器受运行环境限制时须记录跳过/阻塞，不能计为通过。本地合成页面只证明实际组件的输入、提交和布局，生产开通企业 B、邀请码名额及跨企业隔离仍待发布后验收。
