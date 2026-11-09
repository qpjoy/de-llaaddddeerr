# Google Play 接入验收

日期：2026-09-13；原表序号：193。Windows / Python 3.13.3 / Node 22.16.0。

复制整个 193 目录至隔离目录，清除 PYTHONPATH，按自身 scripts/setup.ps1 在全新 Python 环境安装普通 wheel 和锁定的 Node 后端。导入路径确认为该虚拟环境的 site-packages，不依赖父工程。TLS 校验开启，使用本机已配置的代理；不保存代理凭据。

| 功能 | 实测结果 | 条数 | 证据 |
|---|---|---:|---|
| app | 通过 | 1 | [真实结果](verification/live-app.json) |
| search | 通过 | 3 | [真实结果](verification/live-search.json) |
| reviews | 通过 | 150 | [真实结果](verification/live-reviews.json) |
| list | 通过 | 3 | [真实结果](verification/live-list.json) |
| developer | 通过 | 3 | [真实结果](verification/live-developer.json) |
| suggest | 通过 | 5 | [真实结果](verification/live-suggest.json) |
| similar | 通过 | 10 | [真实结果](verification/live-similar.json) |
| permissions | 通过 | 16 | [真实结果](verification/live-permissions.json) |
| datasafety | 通过 | 1 | [真实结果](verification/live-datasafety.json) |
| categories | 未取得有效分类，返回 unknown | 0 | [真实结果](verification/live-categories.json) |

默认实测输入为 Google Translate 包名、Google Translate 搜索词、Google LLC 开发者、TOOLS 免费榜；语言 en，地区 us。以上仅代表已测样本和入口。

- [两页评论](verification/live-reviews-two-pages.json)：取得超过一页的有效评论，并保留续页标记。
- [续页查询](verification/live-reviews-resume.json)：取得后续页，有新的评论 ID。
- [请求预算验收](verification/live-reviews-request-limit.json)：max_requests=1、max_pages=2，返回 partial/REQUEST_LIMIT，首个完整评论页和续页标记保留。
- [不存在的测试包名](verification/live-missing-app.json)：未返回成功；不能单凭来源错误判断应用下架。
- [11 个回归测试](verification/tests.log)通过，使用合成来源验证输入校验、实际子进程超时取消、空数据拒绝、续页、失败/限额保留、代理凭据脱敏和独立运行目录。合成数据不作为平台取数证据。
- pip check、CLI 和 Python 示例通过。步骤与最终源码哈希见 [独立安装记录](verification/independent-install.json)。

## 限制与原表标记

categories 的上游页面选择器未取得实际分类，仅补入固定 APPLICATION；本项目明确返回 unknown，不计入已支持功能。保留此入口供诊断，不宣称完整分类目录可用。

app 返回的版本可能是 VARY，表示因设备而异；没有完整历史版本归档。datasafety/categories 上游入口不保证按 country 切换。原表同时要求版本记录等更广能力，因此两张工作表的“本项目接入状态”标记“部分接入”，逐项列出 9 类已通过功能，保留原总体覆盖状态。

Node 后端采用上游 MIT 源码，修复 similar 后续请求遗漏代理/超时配置的问题；源文件与修改哈希见 upstream.lock.json。作者主要审核社区 PR，页面变化需复测。

验收 JSON 的 execution.run_dir 和日志中的路径属于临时测试环境；结果已随本目录保存，临时环境清理后这些路径不是运行依赖。业务方只需交付 193 目录并按 README 安装。
