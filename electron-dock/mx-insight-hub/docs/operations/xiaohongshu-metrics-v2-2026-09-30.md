# 小红书详情与博主指标双接口（2026-09-30）

## 当前合同

用户确认：两个接口独立调用。`note_id` 返回全 0 或缺失指标也不自动补数；用户需要时自行使用 `user_id` 指定页码查询。因此本节取代此前的自动翻页补数方案。

| Hub JSON POST | 输入 | 行为 |
| --- | --- | --- |
| `/api/v1/data/xiaohongshu/notes/detail` | `note_id`，可选 `deliveryMode` | 保留原 PGY `get_note_detail`，只返回原详情；不因 0/null 请求博主列表 |
| `/api/v1/data/xiaohongshu/users/notes/analytics` | `user_id`、`page_number`、`page_size`、`note_type`、`order_type` | 独立调用 PGY `get_blogger_notes_v2` 的指定一页，不自动翻页、补详情或重试 |

PGY 别名 `/api/v1/xiaohongshu/pgy/get_note_detail`、`/api/v1/xiaohongshu/pgy/get_blogger_notes_v2` 与各自 Hub 路径共用合同和幂等身份。原“获取用户笔记”App V2 接口、游标和 `social.users.posts` 权限保持不变。

[TikHub 官方 v2 合同](https://docs.tikhub.io/506372191e0) 的页码从 1 开始；`page_size` 为 1–8，`note_type` 为 0 全部/1 图文/2 视频，`order_type` 为 1 最新/2 阅读最多/3 互动最多。Hub 保留这些数字类型，默认 1/8/0/1；无固定 15 页上限。返回 `data.items / total / page / pageSize / nextPage / hasMore`。空页或达到 total 时 nextPage=null；total 未提供时 hasMore=null，非空页可显式查询 nextPage。不能因为短页就断言数据已取完。

字段直接映射 readNum→views、impNum→impressions、favNum→collected、engageNum→engaged。列表未提供的点赞、评论、分享为 null，不能从总互动反推。详情的来源零值原样保留，不承诺它们已经核实。列表只承诺上游提供的摘要/封面；受限原始响应完整留证，但摘要不会覆盖 canonical 中已有完整笔记正文。

## 权限与采购配置

两个入口共用 `xiaohongshu` 平台和 `social.posts.analytics` 能力，无新增权限。消费方和当前 Key 已授权二者即可使用；只有普通详情/搜索/用户笔记权限的 Key 不会自动扩权。

授权与采购政策仍复用 analytics 操作，采购端点价格互相独立。客户计价也分开：note_id 使用原 `social.posts.analytics`，user_id 每页使用新计量键 `social.users.notes.analytics`。后者只是计费键，不是新权限。管理员在“套餐与配额 → 逐接口价格”可点击“添加小红书详情 / 博主指标两项费率”分别填写、发布并分配给调用者；保留既有价格，新增项不预填。已发布的 v1/v2 套餐不会自动改动，未配置新覆盖价时遵循既有租户默认单价（显式免费、shadow、disabled 规则保持不变）。`xiaohongshu.pgy.note-detail.v1` 的原采购价继续服务 note_id；`xiaohongshu.pgy.blogger-notes.v2` 必须有独立、经复核的采购价才能调用 user_id 接口，不能继承详情或全局单价。原来已经发布这项价格的配置继续有效；没有发布时 user_id 入口在派发前返回 `503 external_platform_cost_control_unavailable`，note_id 仍正常。

上游操作页面显示“正常”只代表原必需端点就绪，不代表可选 v2 采购价已配置；这与租户/Key 授权是不同层。代码不自动改生产权限、价格、预算、密钥、余额或开关，不需要数据库迁移。

## 缓存、计费与验证

- note_id 保留 `cache_first / refresh`；共享采集指纹升级为详情专用版本，新请求不会命中历史自动补数快照。
- user_id 新请求始终查指定页；不提供 cache_first，也不读取历史共享快照。每个成功页（含空页）按独立的 social.users.notes.analytics 客户价格计一次用量，上游采购也单独留证。
- 同一 Idempotency-Key 和规范化参数重放原交付，不再采集/扣费；参数改变须用新标识。历史详情交付保持不可变，重放时可能仍有 metricsSupplement/metricSources；新详情不再生成这些字段。
- 调试页并列“按笔记 ID 获取详情与阅读量”和“按用户 ID 获取笔记指标”；切换入口、编辑参数不自动发送。用户编辑 page_number 后主动发送下一页，同参数要取新数据则点“以当前参数新建请求”。

验证示例：user_id=`624560f5000000000100ffab`，page_number=1、page_size=8、note_type=0、order_type=1；在 items 中找 externalId=`6aaa708b0000000025036d6e`，未找到时按 nextPage 手动继续。截图里阅读 619、曝光 6499、收藏 27、互动 107 是历史观察值，不是生产实时预期。

本地定向回归 476 项通过、1 项按环境条件跳过，涵盖接口、鉴权、逐页独立计价、空页收费、原请求重放、上游错误留证与公开文档；构建、类型检查通过。合成计价测试用详情 20 分、分页 7 分验证“1 次详情 + 2 页（含空页）=34 分”，这些不是拟定生产价格。Chrome 使用实际组件和本地脱敏数据验证第 20/21 页、同请求重放、全零详情不自动补数，以及套餐两项费率保持原价/独立输入/不重复添加；控制台无错误。未调用生产收费接口。

实现与测试均限于 mx-insight-hub；不修改 MX-H2I/Launcher 的登录、Internal 配置、VPN/DNS 或现有联网链路。此轮仅本地修改，尚未部署。
