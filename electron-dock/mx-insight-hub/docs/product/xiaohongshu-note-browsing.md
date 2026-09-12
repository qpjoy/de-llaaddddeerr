# 小红书笔记画卷与平台接口（2026-09-13）

本期复用 Hub 的 TikHub 网关、独立操作放行、凭据、成本准入、归档与 canonical 入库。只改变 Hub；不修改 Launcher、MX-H2I、用户登录、DNS 或 WireGuard。

## 发布范围

已有五个 App V2 GET 入口现在也接受同字段 JSON POST：get_image_note_detail、search_notes、search_users、get_user_info、get_user_posted_notes。POST 禁止混用 URL query，page/ai_mode 可传 JSON 整数，其余类型按现有合同校验。两种 HTTP 方法共享 endpoint + 规范化参数幂等身份，不能靠切换传输重复采集。

文档侧边栏按平台原生接口 → JustOne / TikHub 分类。TikHub 的五个端点分别拥有参数表、官方参考链接、示例、授权、分页和错误说明。平台名称只用于文档分类，不新增租户供应方路由字段。外部平台 TikHub 详情连接到文档和画卷。

本期不开放任意路径代理；评论、收藏、话题及视频专用 API 不在此次列表/图文详情发布范围。`/api/v1/xiaohongshu/app/get_note_info` 仍是现有稳定产品合同，通过链接获得 `data.item.text`、`data.item.tags`；并非声称原样转发旧 App V1 响应。

## 列表、详情和分页

- 管理员会话默认读取 `social.posts.v1` 中的小红书笔记，复用 Data Center 的安全展示投影、完整正文和 opaque cursor。按现有 newest 排序；关键词只筛选已存数据。非管理员不会请求跨租户管理历史。
- 手机式列表打开详情后展示当前版本正文、标签及媒体。列表预览明确标记可能不完整，可在详情中点击“获取完整正文与标签”直接读取完整详情，也可带入解析表单选择其它交付策略。详情与原生响应的原始业务内容不在 UI 做长度截断。
- 上划只加载 Hub 历史；下拉只有显式勾选开启后才采集，且必须有 Public Live Key 与输入。按钮也可单独获取一页。关键词采集默认图文笔记；用户列表接受 ID/主页分享链接。
- 搜索 page 与 search_id/search_session_id 延续同一查询；用户列表只使用 Hub 返回的 mxec2 游标。最多 15 页。Hub 历史 cursor 永远不发送给上游；缺失、冲突、空页仍宣称有后续的响应显示错误。
- 每页新幂等键，失败后保持同一键重试，关闭手势续页，绝不后台重试。超出显示批大小的已采集笔记先缓冲展示，再请求下一付费页。跨批按笔记 ID 去重。采集筛选和历史筛选是两个独立区域，避免将上游页码误作 Hub 存储页码。
- API Key 只放页面内存；换 Key 清除结果。原始图片默认关闭；开启后通过原始 HTTPS 地址读取，费用未知，不触发笔记采集。尚未声称接入 mx-static。

## 下游交付

租户继续使用自己的 Live Key、明确的平台和操作能力，不能调用管理历史。兼容接口另需 `compat.xiaohongshu.app_v2`。每次交付保留 requestId，`GET /api/v1/acquisitions/{requestId}` 只允许所属 consumer 读取这次交付和入库证据；可用授权后的 canonical/stored search 检索长期数据，但不将当前状态搜索等同于原始响应重放。异步入库延迟时，当前页面可显示本次响应，管理历史需稍后刷新。

## 官方参考

- [图文详情](https://docs.tikhub.io/420136391e0)
- [搜索笔记](https://docs.tikhub.io/420136398e0)
- [搜索用户](https://docs.tikhub.io/420136399e0)
- [用户信息](https://docs.tikhub.io/420136395e0)
- [用户笔记](https://docs.tikhub.io/420136396e0)

仅文档参考不表示该环境的上游操作已放行；凭据/合同/价格/授权仍须通过现有运行时控制。缺少任何一项只影响数据采集，不影响 Hub 或 MX-H2I 登录联网。

## 本地验证

- 定向服务端、文档、笔记/电商、身份/凭据隔离及 Sites worker 回归：168 通过，3 个 PostgreSQL 集成测试因未配置测试数据库跳过。
- 构建、现有 TypeScript 检查通过；浏览器验证管理登录、无 Key 空态、独立 TikHub 文档页。
- 隔离样例验证：10→20 篇历史续页、长正文和标签详情；无效 Public Key 的采集 401 不退出管理会话。样例只在 /tmp 测试服务，不写入生产库或代码内置数据。
- 未执行真实付费 TikHub 调用、线上数据库验证或部署。
