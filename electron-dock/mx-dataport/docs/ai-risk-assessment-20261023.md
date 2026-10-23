# IP 风险 AI 分析接入（2026-10-23）

按工作区 `ip_risk_assessment_api.md` 的异步协议接入，用户已确认：查询成功后自动生成，复用罗盘 `application.yml` 中的 `DELTA_API_TOKEN` 默认值，通过新增服务端 Secret 配置。

## 页面与业务流程

- 单次查询和批量查询中，每个有有效画像的数港查询记录自动提交一次 AI 分析。原画像先返回，AI 独立执行，不改原查询状态、账单、额度和原始数据。
- 查询详情展示“AI 风险分析”，保留可展开的规则参考建议。批量表格新增“查看分析”，查看同一份派生结果。已有历史详情只读已有 AI 记录；旧记录未分析时明确说明，不因查看或导出而创建付费任务。原导出中的规则参考建议保留，未将其标成 AI 结论。
- 页面展示提交、排队、执行、完成、失败、取消、中断、暂停及结果未确认。仅 `succeeded` 的 `result.result`（或 `run.output.result`）作为结论；错误、计量和上游诊断不显示为结论。输出按纯文本渲染。
- 正常轮询间隔 1.5–2 秒；网络故障有界退避至 30 秒。页面等待 120 秒或连续失败 6 次后停止自动等待，保留后台任务，提供“继续查看分析”；不会再次 POST 或重查 IP。暂停任务停止自动轮询，手动查看只执行 GET。

## 服务端与隔离

Hub migration 165 新建 `dataport.ai_assessments`，以 `(tenant_id,query_id)` 唯一约束保存原始输入快照、原查询人、环境、凭据指纹、状态、`run_key` 和结果。数港查询的重放、并发标签或副本不会再次提交。同 IP 的新查询有新的查询记录与独立 AI 分析。

输入使用已保存的完整 `payload.response` JSON 序列化字符串，保留所有嵌套字段、`null`、空数组、布尔值、日期、元数据和未来扩展字段；不从浏览器接受任意画像，不伪造缺失值。`uid` 固定为 `dataport:<tenantId>:<原查询memberId>`。请求只有 `uid/input/async:true/stream:false`，不传模型、会话或回调。

调用地址固定为文档中的 prod/dev origin 和 Agent key，不接受浏览器或任意 URL 配置。Token 只在 Hub Admin 服务端读取。轮询固定从返回的有效 `run_key` 构建路径，忽略 `poll_url`；拒绝重定向，并限制响应体、请求超时及结论长度。凭据或环境变化时不在另一身份下读取旧任务。

客户只能 GET `/bff/v1/enterprises/<tenantId>/assessments/<queryId>`。Hub 保持最新成员/角色校验：`history.read` 可查看企业记录；只有 `query.execute` 时仅可查看自己原查询的分析。无独立的浏览器提交、重跑或任意 Delta 代理入口。GET 不提交分析；分页和导出不触发任务。

Delta 提交超时/异常不自动重试。取得有效句柄即保存，异常 202 也保留可核对的句柄。进程在取得外部句柄与数据库落盘之间终止时，或未取得句柄的超时，记录保持未确认，需管理员核对；不宣称外部提交具备跨系统的严格 exactly-once。原画像仍完整保留。

轮询使用数据库 CAS 租约与递增版本避免多个标签/副本重复轮询或迟到响应覆盖新结果。AI 未配置或派生服务异常不会使原查询失败，也不影响 Hub/DataPort 的启动就绪或 MX 登录。未增加账号权限、商品扣次或新 AI 收费规则。

## 凭据与部署

当前本地已从 `/Users/lanan/Desktop/yjj/compass/public-opinion-tracking-backend/src/main/resources/application.yml` 提取默认 Token，三份候选罗盘配置的默认值一致；已核对生成的 Secret 与该值一致。私密文件位于 Git 仓库之外的工作区 `.secrets/dataport-ai-secret.json`，目录 0700/文件 0600，未输出 Token、未提交 Git、未写入前端。

线上发布顺序：**创建 Secret → Hub（含 migration 165）→ DataPort**。无需更新 Delta Agent、Auth、Launcher 或 Pay，无需重新 enroll 或改动 MX-H2I/身份网络。

若在服务器复用其已有罗盘配置，从仓库根目录执行（替换真实 application.yml 路径）：

```bash
mkdir -p /root/.config/dataport
chmod 700 /root/.config/dataport
node electron-dock/mx-dataport/scripts/configure-ai.mjs \
  --from-compass /实际罗盘路径/application.yml \
  --out /root/.config/dataport/ai-secret.json --environment prod
kubectl -n mx-insight-hub apply -f /root/.config/dataport/ai-secret.json
```

生成工具仅写私密文件，不直接操作集群，不覆盖已有文件，拒绝将 Secret 写进仓库。也可以将本机已生成的私密文件安全传至服务器后 apply，不在聊天、Git 或日志中粘贴内容。完成后沿用既有 Hub 与 DataPort 部署命令。

Hub Admin 清单增加可选 Secret `mx-dataport-ai`：`token` 挂载至 `/run/dataport-ai/token`，`environment` 通过 `MX_DATAPORT_AI_ENV` 读取。缺失时不影响其他业务。独立本地运行可指定 `MX_DATAPORT_AI_TOKEN_FILE`；生产不挂载罗盘源码或依赖其文件路径。

## 验证与未完成项

使用隔离 PostgreSQL 和模拟 Delta 响应验证完整输入、并发去重、持久化与重启读取、租户/权限隔离、超时不重 POST、固定轮询地址、异常句柄保留、暂停/终止/备用输出、过大/错误响应及原查询成功优先。Secret 生成与 BFF 白名单另有测试。Hub 68 项与 DataPort 38 项相关测试通过（0 失败、0 跳过），DataPort 类型/构建与 Hub 类型检查通过；日志位于 `screenshot/ai-integration-20261023/`（仓库外）。

本地 Delta 域名解析失败，未完成 Token 在线有效性或真实 Agent 调用验证，未提交生产分析任务、部署或迁移。浏览器预览仍未打开，不以本地测试代替页面验收。发布后需用授权测试查询验证排队到结论、刷新读取、批量记录和员工权限；自动分析可能消耗 Delta 额度，应与测试查询一起确认。
