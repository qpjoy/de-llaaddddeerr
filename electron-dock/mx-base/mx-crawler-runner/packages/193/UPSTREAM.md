# 来源与修改

- 上游：https://github.com/facundoolano/google-play-scraper
- 提交：1547a3a51bc56390ea0ecae7d8a6eca6d343003d；版本：10.1.3；许可证：MIT。
- 源码保存在 src/mingxi_google_play/node/vendor/google-play-scraper，保留许可证及原 README；根目录 LICENSE 为原许可证副本。
- 2026-09-13 本地修改 lib/similar.js：向后续相似应用请求传递 requestOptions、throttle、num，保证代理、超时和请求次数限制继续生效。其他上游源码未修改。
- 新增 Python/CLI、独立 Node 运行目录安装、自动代理及系统根证书支持、结构化状态、评论整页分页及失败保留；Node 依赖由 package-lock.json 锁定。
- 原始归档、原始文件哈希及修改后文件哈希保存在 upstream.lock.json。
