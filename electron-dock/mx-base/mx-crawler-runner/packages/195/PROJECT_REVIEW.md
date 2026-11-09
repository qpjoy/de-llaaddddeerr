# app_market_crawler 当前交付范围

更新日期：2026-09-12。上游 [halifox/app_market_crawler](https://github.com/halifox/app_market_crawler)，固定提交 `fd1e873299734b60a2bda20a20f454a1f4c43839`。

按用户要求，已移除验收中出现超时的华为 194 和三星 218 实现；当前只交付以下 6 个已通过独立安装和默认联网查询的市场。原项目需要依赖与解析修整，修改内容见下文。验收以 QQ 为样本，结果限于已测入口和字段；未来接口可用性仍以调用结果为准。

| 序号 | 市场 | 通过范围 | 限制与证据 |
|---|---|---|---|
| 195 | 小米应用商店 | ID 应用详情、开发者、评分、隐私政策、下载链接 | 有评论计数，无评论正文；[验收](VERIFICATION.md) |
| 197 | vivo 应用商店 | ID 应用详情、开发者、评分、隐私政策 | 评论列表实测为空；APK 为相对路径；[验收](../197/VERIFICATION.md) |
| 198 | 应用宝 | 包名应用详情、开发者、评分、隐私政策、下载链接 | 无评论明细；[验收](../198/VERIFICATION.md) |
| 216 | 百度手机助手 | 包名/PID/docid 详情；PID 有界历史版本 | 历史验证 2 条样本，非完整归档；[验收](../216/VERIFICATION.md) |
| 217 | 联想应用商店 | 包名应用详情、开发者、评分、隐私政策 | 无评论明细；[验收](../217/VERIFICATION.md) |
| 219 | 豌豆荚 | ID 应用详情、开发者、隐私政策、有界历史版本 | 直接 APK 链接缺失；[验收](../219/VERIFICATION.md) |

## 已排除的平台

- 华为 194：曾取得有效详情，但独立验收出现 15 秒超时；按用户要求删除实现目录，撤回当前接入标记。
- 三星 218：包名入口曾取得腾讯分发信息，但独立验收两次 15 秒超时，appid 样本也未取得有效数据；按用户要求删除实现目录，撤回“已覆盖”。
- 360 手机助手、PP 助手：请求遇到 TLS 连接中断，未交付；[360 复核](verification/project-review/360-requests.json)、[PP 复核](verification/project-review/ppzhushou-requests.json)。
- 应用汇：包名、应用 ID 入口返回空对象，未交付；[实测证据](verification/project-review/yingyonghui-02.json)。

## 修整内容


- 解决上游 setuptools license classifier 与 license expression 冲突，保留 GPL-3.0-only 声明、许可证和修改说明。
- 固定 Scrapy 2.13.3 与 Twisted 25.5.0，修复安装最新 Twisted 后 HTTPS 下载器无法导入的问题。
- 去除强制 MongoDB 管线，每个序号只保留自身需要的爬虫与核心代码。提供可导入的 collect 函数、CLI、标准 README 和安装脚本。
- 启用系统与 certifi 根证书校验，保留 TLS 域名校验；关闭 Telnet 控制台。限制网络并发、请求总数、单请求和任务总超时。
- 每次调用使用独立子进程运行 Scrapy，支持重复调用；同次任务复用连接池，运行目录相互隔离。超时保留已取得的记录。
- 以名称、应用标识和版本验证有效数据，拒绝空对象和仅回显输入的伪成功。保留原始响应解析字段与诊断结果。
- 修正豌豆荚版本、更新时间和简介/更新说明选择器；历史版本按输入设置上限，避免原生一次展开数十个请求。

## 验收与数据源表

保留的 6 个平台均在单独复制的目录和全新 Python 3.13.3 环境完成安装、导入、pip check、CLI、Python 示例与默认联网 smoke 验证；每个平台 7 个回归测试，共 42 个。真实结果在各目录 verification/independent-live.json，安装与代码哈希记录在 independent-install.json。本次仅移除超时平台并检查保留代码与验收版本一致，未重新发起联网查询。

数据源表两张工作表同步撤回 194、218 的接入标记，保留序号行及历史记录，不将 219 重新编号。195、197、198 保留“应用详情接入完成”的备注及原总体状态，因为原表还要求评论等能力；216、217、219 继续按已验证范围标记“已覆盖”。

业务方只需当前 platforms 中所需序号目录及其 README；无父工程依赖。此次移除记录见 [platform-removal.json](verification/platform-removal.json)。
