// Static, provider-neutral troubleshooting knowledge; no incident IDs or bodies.
export const DIAGNOSTIC_PLATFORMS = [
  ['reddit', 'Reddit'], ['facebook', 'Facebook'], ['instagram', 'Instagram'], ['twitter', 'Twitter / X'],
  ['youtube', 'YouTube'], ['xiaohongshu', '小红书'], ['douyin', '抖音'], ['kuaishou', '快手'],
  ['bilibili', '哔哩哔哩'], ['weibo', '微博'], ['zhihu', '知乎'], ['tiktok', 'TikTok'],
  ['telegram', 'Telegram'], ['wechat', '微信'], ['ecommerce', '电商'], ['other', '其他平台'],
].map(([id, label]) => ({ id, label, specialized: id === 'reddit' }))

export const REDDIT_DIAGNOSTIC_ISSUES = [
  { id: 'reddit_widget_telemetry', title: '纠错或横幅卡片的埋点误判',
    signal: '上游 HTTP / 业务码 200，Hub 记录 invalid_content_search_contract，归档解析为 invalid_content_search_entry。',
    explanation: '历史案例中，一张 SearchSpellCorrectionApplied 卡片曾使同页七条帖子整页失败。trackingContext.post 是埋点引用；telemetry 中的深层 search.scope 也可能触发深度限制。该案例不能证明本次就是同一原因。',
    check: '核对节点类型与完整拒绝路径。旧规则已跳过指定 trackingContext 的整个子树；只有其外的元数据才需要扩大排除范围。逐帖解析及移除卡片的对照只能在内存中进行。',
    resolution: '纠错卡片仅排除根 telemetry、behaviors.corrected.telemetry、behaviors.original.telemetry；SearchBanner 保留根、cta、dismiss 的 trackingContext 例外。其他位置仍检查真实帖子。交付附带 reddit_spell_correction 警告，原检索词不改写。' },
  { id: 'reddit_unknown_widget', title: '未知卡片或真实帖子结构变化',
    signal: 'invalid_content_search_entry / invalid_content_search_identity；提示卡片、列表与帖子混排。',
    explanation: 'SearchInFeedSurveyUnit 等非帖子卡片可与 SearchListComponent 混排；未知节点内也可能携带真实帖子。七个帖子节点存在不等于七条均能解析。',
    check: '检查 __typename、post、children 和帖子身份，分别验证帖子与非帖子节点；通用诊断 samples 为空不证明搜索结果为空。',
    resolution: '只排除已验证的非帖子结构；未知类型继续执行隐藏帖子、数量和深度检查，不按类型名称批量丢弃内容。' },
  { id: 'reddit_relay_pagination', title: 'Relay 末页游标被误判为矛盾',
    signal: 'contradictory_content_search_continuation / missing_content_search_continuation。',
    explanation: 'Reddit 末页可能同时保留 endCursor 和 hasNextPage=false；endCursor 可以只是最后一个节点的位置。',
    check: '核对同一归档的 pageInfo.hasNextPage 与 endCursor，区分末页游标和下一页令牌。',
    resolution: '明确 hasNextPage=false 时结束分页；hasNextPage=true 仍必须有有效下一页游标。不要仅因 endCursor 非空继续采集。' },
  { id: 'reddit_search_notice', title: '空结果提示与上游错误提示混淆',
    signal: 'SearchErrorMessage；可能记录 upstream_search_error_message。',
    explanation: '该节点既可表示无结果，也可表示 Reddit 服务错误，不能统一转换为成功空页。',
    check: '在受限归档内核对提示分类，不把原始提示正文复制到公开响应。',
    resolution: '明确无结果提示交付空页及 reddit_no_results；只有错误提示时失败；错误提示与帖子并存时保留帖子并附警告。' },
  { id: 'reddit_response_quarantine', title: '历史不可用响应导致后续请求阻断',
    signal: 'HTTP 409 external_platform_response_unusable；可能没有当次上游调用。',
    explanation: '近期 succeeded_unusable 可触发同端点、同契约的五分钟响应隔离。它与 unknown、上游限流和供应商熔断不同。',
    check: '先区分 own 调用和 quarantine_candidate，再核对时间窗、端点、契约及恢复记录；没有调用记录本身不证明未派发。',
    resolution: '修复产生不可用响应的原因。邻近失败只是候选，当前保护状态不证明历史状态；不自动解除保护或重发采购。' },
  { id: 'reddit_upstream_failure', title: '上游限流、拒绝或结果未知',
    signal: '上游 HTTP 429、upstream_rate_limited、rejected、unknown 或超时证据。',
    explanation: '这些信号需要按原调用核对，不能套用提示卡片解析修复；HTTP 200 响应头也不证明响应体完整。',
    check: '核对上游 HTTP、业务码、outcome、关联 ID 与计费证据，区分 Hub 交付状态和上游调用结果。',
    resolution: '按已确认原因处理容量或连接问题；结果未知时先查原请求，不自动重试或更换请求身份。' },
]

export const REDDIT_DIAGNOSTIC_VERIFICATION = '使用 provider call ID（不是 Hub request ID）读取 SHA 校验通过的归档；诊断 v4 可输出 previousTrackingContextGuard、当前 guard、parserModuleSha256、hasMore 与 warningCodes。v2/v3 的失败不证明最新修复无效。部署后只读回放验证当前解析器；历史 502 和费用不改写，回放通过也不等于新请求端到端成功。'

export const GENERIC_DIAGNOSTIC_STEPS = [
  '先查询 Hub 请求 ID，区分保存的交付状态、当次上游调用和客户结算。',
  '按上游 HTTP、业务码与 outcome 区分拒绝、响应解析失败和结果未知。',
  '使用原调用 ID、时间与已保存归档核对原因；缺少记录时保留待核对状态。',
  '当前限制与恢复条件另行查看；诊断入口不触发采集、采购、恢复或账本修改。',
]
