# 单帖评论：跨平台非 JSON 404 与快手未支持

现场 Twitter requestId：`af456ad4-2523-4f73-a1fc-c95104b329a4`。

截图中的请求已经到达 Hub 18150。`night_all_rejected` + `invalid_upstream_content_type` 表示 Hub 的 Night-All adapter 收到非 JSON 的错误响应；不是评论为空的证据。四个平台同类 404 优先排查共同上游路由，但仅截图不能确定是旧部署、错误 base URL、代理改写还是应用返回的 404。postId/contentId 两种标识都被本地合同接受，切换字段不能修复路由。

此前实现是 Hub → Night-All 的兼容桥，并没有迁移成 Hub 直接采集。单元测试中的模拟成功响应不能证明运行中的 Night-All 已发布该路由。当前本地 Night-All `routes/v1/search.js` 有 POST `/post-comments`，发布环境须独立核验。

## 1. 读取保存证据

在服务器 Hub 项目目录执行（现有 Admin 镜像即可，不需要先发布）：

```bash
kubectl -n mx-insight-hub exec -i deployment/mx-insight-hub-admin -c admin -- \
  node --input-type=module - < server/ops/diagnose-post-comments.mjs
```

脚本默认查询上面的 Twitter UUID，可追加 `--request-id UUID`。数据库与事务只读，不发 HTTP，不输出正文、凭据或任意错误内容。没有账本行不能证明没有调用。

## 2. 核对 Public 实际配置与路由

核对当前 Public Pod 的 `NIGHT_ALL_BASE_URL` 的 origin/path、镜像及启动时间；只输出这些字段，不输出整套环境或 Secret。注意 Admin 当前配置不证明历史 Public 的目标。默认值为 `http://127.0.0.1:13141`，不能把默认值当作已核实的现场地址。

在实际上游宿主用 `ss -ltnp` 核对目标端口和进程，按 PID 确认工作目录、启动时间及部署版本。检查该实例的 `routes/v1/search.js` 是否含 `/post-comments`、是否挂载在 `/api/v1/search`，以及代理是否原样保留 POST 与路径。

可从 Public 的网络环境向已确认目标发送空 JSON `{}` 的 POST 路由探测（沿用配置的服务认证，禁止把 Token 打印或放在命令参数）。本地已核实的 Night-All schema 要求 platform，空请求应在验证阶段拒绝，不进入采集。只记录 HTTP 状态、Content-Type、结构化错误 code；不打印返回 HTML。JSON 参数校验错误证明进入了验证链；401/403 只说明鉴权拒绝，仍不能证明业务路由存在；HTML 404 仍需检查实际服务/代理。这个探测不是评论可用性验收。

## 3. 根据证据修复

- 实际目标正确，但运行版本缺路由：完整发布匹配的 Night-All 版本及依赖，使用该实例原有进程管理方式重启；仅发布 Hub 无效。不要猜测 PM2/systemd 服务名。
- base URL/path 错误：修正部署配置来源，使 adapter 拼接后的路径恰好是 `/api/v1/search/post-comments`；避免 base URL 已包含 `/api/v1` 导致重复。更改共享地址前核对 raw/crawl/user-info 等仍用同一 adapter 的调用。
- 代理丢失路由：修复精确路径及 POST 转发，不让 API 请求进入前端静态站点的 404。
- 快手：Hub 当前支持集没有 kuaishou，本地 Night-All 文档也未承诺单帖评论。必须适配真实快手评论供应合同、授权/计费/归档/字段和续页后再发布支持；不能只把 kuaishou 加到数组，商品评论和搜索附带评论也不能替代。当前应向下游明确返回未支持。

修复后再用已确认存在且可访问的帖子做首屏、下一页、终页验收；核对评论 ID 与原帖 ID 的字段语义、作者、时间和互动量，而非只看 HTTP 200。历史失败回执不重写。先核对原 requestId 状态：committed/unknown 不可盲目换键；released 是否可重试以服务状态为准，恢复后的新采集应由调用方明确发起。

本次仅增加只读诊断与运行手册，没有执行生产发布、付费采集或修改 MX-H2I 登录/联网配置。实际运行目标、版本及供应商可用性仍待现场证据。
