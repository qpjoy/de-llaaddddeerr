# vivo 应用商店 验收记录

- 验收日期：2026-09-12；上游提交 fd1e873299734b60a2bda20a20f454a1f4c43839。
- 本次详情样本：40439；有效应用：QQ；实测状态：success。
- [真实详情结果](verification/live.json)；[上游原始探测](verification/upstream-live.json)。
- 本次可见字段：package, app_id, name, version, version_code, developer, rating, privacy_policy_url, updated_at, icon_url, download_path。
- 边界：详情提供开发者、评分、隐私政策及备案信息；appComments 本次为空，不宣称评论采集完成。APK 字段为相对路径，未拼接未经验证的下载域名。
- 应用详情接入完成。原表已有条目若还要求评论等未实现能力，保留原总体覆盖状态，备注逐项标记；新增条目按本次明确的详情范围标记。

## 独立交付验收

复制本目录至隔离路径，清除 PYTHONPATH，在新的 Python 3.13.3 虚拟环境执行自身 scripts/setup.ps1。安装、pip check、site-packages 导入、CLI 帮助、Python 示例和真实联网 smoke 均通过；没有安装上游整体工程或导入父目录。

- [步骤与源码 SHA-256](verification/independent-install.json)
- [独立环境真实查询](verification/independent-live.json)
- [7 个回归测试日志](verification/independent-tests.log)
- [安装日志](verification/independent-setup.log)

真实查询证据的 execution.run_dir 和安装日志含验收时临时绝对路径；临时环境清理后，该路径不作为交付依赖，结果文件已随本目录保留。
