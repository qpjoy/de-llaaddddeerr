# Harbor 发布与域名接入

正式域名：`https://harbor.minsight-ai.com`。以下在相应服务器仓库目录运行；保留既有环境参数。

1. Internal，`electron-dock/mx-harbor`：日常代码发布，一键建库/迁移/重启/就绪检查。

   ```bash
   MX_HARBOR_BUILD_PROXY=http://127.0.0.1:7789 bash scripts/manage.sh ops internal-production deploy
   ```

2. 同目录，首次域名接入（已 deploy 成功可直接执行），可幂等重试：

   ```bash
   bash scripts/manage.sh ops internal-production enroll
   ```

3. Internal，`electron-dock/mx-launcher`：使用原 `bash scripts/manage.sh ops internal-production deploy` 和原有环境参数，发布新增 Auth client/Harbor 邀请准入。该流程有原有服务发布步骤，完成后验证 MX-H2I 登录、联网；不重置身份或网络配置。随后在 `electron-dock/mx-insight-hub` 发布兼容 Hub：

   ```bash
   MX_INSIGHT_BUILD_PROXY=http://127.0.0.1:7789 bash scripts/manage.sh ops internal-production deploy
   ```

4. Internal，`de-mingxi`：

   ```bash
   bash scripts/manage.sh internal-harbor-install
   ```

5. 将域名 DNS 指向 Domestic，保证 80/443 可达。Domestic，`de-mingxi`：

   ```bash
   bash scripts/manage.sh harbor-install
   ```

   包含首签/已有证书按需续期、内网 health/ready、Nginx 检查与 reload、续期 dry-run 和 timer。之后可单独检查或续期：

   ```bash
   bash scripts/manage.sh cert test-renew harbor.minsight-ai.com
   bash scripts/manage.sh cert renew harbor.minsight-ai.com
   ```

6. 管理员保持 Hub 开放注册，单独开启 Harbor 邀请；用专用账号检查原型登录/注册、邀请码准入、共享空间与权限。`/status` 的 configured 仅表示配置有效，不表示远端验证成功。日常 Harbor 更新只运行步骤 1；没有新增 Auth client 或 Hub 代码时无需反复发布 Launcher/Hub。

¥1 管理员验收购买、Pay 返回 Harbor、完整 IP 查询闭环仍待实现，本阶段不要开放正式销售。详见 [实施说明](docs/implementation-and-operations.md)。
