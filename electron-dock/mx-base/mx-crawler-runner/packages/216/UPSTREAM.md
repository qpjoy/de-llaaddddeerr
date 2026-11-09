# 上游与修改记录

- 项目：https://github.com/halifox/app_market_crawler
- 固定提交：fd1e873299734b60a2bda20a20f454a1f4c43839（2026-04-03）。
- 上游 LICENSE 和 pyproject 声明 GPL-3.0-only；本目录保留 LICENSE，连同对应源码一起交付。
- 本目录基于上游 baidu spider 与必要 core/items 代码整理；未包含其他市场 spider 和 MongoDB 管线。
- 修改日期：2026-09-12。调整为独立包内导入，补充 Python/CLI、子进程隔离、总超时、请求与历史记录上限、结果有效性校验、结构化返回。启用 TLS 证书校验，关闭默认 Telnet 控制台。
- 依赖锁定 Twisted 25.5.0，解决 Scrapy 2.13.3 与 Twisted 26 的下载器导入冲突；项目元数据移除重复 license classifier，保留 GPL license expression。
- 豌豆荚版本属性选择器及简介/更新说明顺序已按实页修正；其他市场的核心请求与解析保留上游行为。
