# Twitter 空标题兼容修复

2026-09-23 更新：Facebook 内容现采用相同规则；下文“其他平台不变”指此次扩展前的
2026-09-21 范围。最新范围及分页修复见 [搜索兼容修复](night-all-search-compatibility-2026-09-23.md)。

2026-09-21。范围仅限历史 Night-All / Hub 链路中的 Twitter 内容，不改变其他平台标题、账号资料、MX-H2I 登录或联网。

## 原因

Night-All `crawlers/china_social/unified.py` 原先将平台名、空格和正文合并空白后截取 120 个字符，作为 `title` 和旧版展示 `name`。搜索标准化和 Hub 兼容入库会继续保留该标题。详情和存储另有正文补标题逻辑；Hub data-search 入库还会在 Twitter 标题为空时使用正文前 80 字符。

本地用用户提供的示例文本复现了完全相同的 120 字符标题。该复现定位生成规则，不代表已读取或确认生产 ID `2087779969447686278` 的真实请求链路。

## 修复边界

- Night-All Twitter 内容的标准 `raw_data[].title` 为 `""`；data-search/export 标准记录的可空 `title` 为 `null`，保持各自现有字段类型。
- Python 采集包装层停止填写 Twitter 内容标题。旧版展示 `name` 保留，标准内容响应不再从该字段补回标题。
- RapidAPI 和采集器存储归一化不再用正文补 Twitter 标题。正文、原始 ID、作者、媒体、指标、分页和计数保持原契约。
- Hub 的 Night-All data-search / 兼容内容入库将 Twitter 标题规范为 `null`，保留原始 payload。Twitter data-search 内容摘要包含解析器版本，使旧内容在再次正常入库时产生对应修订和索引事件；其他平台的摘要算法不变。兼容记录的 canonical 摘要重新计算，原始 payload 摘要保留。
- Twitter `raw_info` 账号名称及其他平台的标题、名称兜底不变。Hub HTTP 转发、授权、计费、幂等和历史响应快照不改写。
- 不涉及独立外部归档源的映射、全库清洗、搜索索引重建或其他数据产品。

## 发布与历史数据

修改位于两个仓库：`Night-All` 和 `de-llaaddddeerr/electron-dock/mx-insight-hub`，需要发布对应服务。仅发布 Hub 不会改变仍由旧 Night-All 返回的兼容响应正文。

本次不运行迁移、不回填、不重新采集。旧 Hub canonical 行、索引和不可变响应快照不会自动被重写；旧幂等键的响应复现继续返回当时保存的内容。Night-All 已存数据经过更新后的 data-search 标准化读取时，Twitter 标题会输出 `null`，数据库原文证据保留。后续正常采集/入库采用新规则。

## 本地验证

全部使用合成数据和桩，不调用供应商 API：

- Python：统一采集的 Twitter 搜索、动态、归档、详情、评论、纯媒体内容；账号和其他平台不变。
- Night-All：真实内容标准化与响应序列化、详情、存储、旧合成标题/名称、data-search 幂等标准化、正文/ID/作者/媒体/分页保持。
- Hub：data-search / legacy 内容入库空标题、账号名称、原始 payload 不变、canonical 摘要一致性；原有兼容转发、计费和幂等快照回归测试。

生产 PostgreSQL 集成检查需要独立测试数据库，本次不连接生产数据库验证。
