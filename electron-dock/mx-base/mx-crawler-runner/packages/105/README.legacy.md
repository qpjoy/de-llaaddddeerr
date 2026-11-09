# Substack — 原表序号 105

## 本序号的实现入口

直接打开 [main.py](main.py)：`collect()` 是供业务方调用的 Python 入口，CLI 复用同一实现。此文件可在本序号目录独立调用；upstream 保存原生依赖源码，validation 保存验收证据。

按下方说明安装依赖后，在本目录运行：

```powershell
python main.py --target "实际公开 URL" --timeout 110 --output data/result.json
```

```python
from main import collect
result = collect("实际公开 URL", work_dir="data", timeout=110)
```

`timeout` 是整个调用的秒数上限；采集在独立子进程运行。返回包括 id、target、observed_at、status、live_data_verified，以及可用时的 data、capabilities_verified、limits；错误返回 error_type/error。请检查 status，不能只看 CLI 是否退出。95 当前入口仅诊断兼容性，103 尚未通过真实采集。

**已取得真实数据（限下列能力）。** 成功读取 One Useful Thing 的 2 篇文章元数据及第一篇的公开正文；评论、完整作者资料未验收。

## 安装与配置

已在 Windows / Python 3.13.3 的独立虚拟环境安装固定源码提交并检查导入。运行依赖已记录在 [requirements.lock.txt](requirements.lock.txt)；这份锁针对本次验证环境，不代表所有操作系统均已通过。

在本平台目录执行：

```powershell
python -m venv .venv
.\.venv\Scripts\python.exe -m pip install -r requirements.lock.txt
.\.venv\Scripts\python.exe -m pip install --no-deps ".\upstream\NHagar__substack_api"
```

该项目使用 setuptools-scm；安装必须保留 upstream 内的 `.git`。本次最初用无 Git 元数据的源码归档安装失败，改用含 `.git` 的同一提交副本后通过；不是平台采集失败。

业务方可复制本平台目录独立安装上游项目。此阶段验证上游原生调用，尚未提供统一业务返回模型或 HTTP 服务。凭据用环境变量传入，不写入源码。

## 实际验证

- 验证时间（UTC）：2026-09-10T16:39:20.340460+00:00
- 结论：成功读取 One Useful Thing 的 2 篇文章元数据及第一篇的公开正文；评论、完整作者资料未验收。
- 通过能力：newsletter_posts, post_metadata, post_content。
- 本次成功样本：`https://www.oneusefulthing.org`。
- [原始调用结果](validation/live-01.json)、[安装环境](validation/environment.json)、[安装日志](validation/install.log)。历次失败及补装日志也保留在 validation 目录。

验证使用公开页面/API，未下载音视频文件。探测请求默认超时 20 秒，单次探测进程总时限 110 秒，批次最多 3 个并发；这属于验收脚本的限制，上游原生接口不一定都具有同等保护。

## Python / CLI 调用

以下使用上游原生返回类型。需要凭据的示例尚未真实调用；通过的示例仅代表上述已验收能力。

```python
import os
from substack_api import Newsletter

newsletter = Newsletter(os.environ["SUBSTACK_NEWSLETTER_URL"])
for post in newsletter.get_posts(limit=5):
    print(post.get_metadata())
```

输入为 Newsletter URL；`get_posts` 返回 Post 列表，`get_metadata` 返回字典，`get_content` 返回 HTML 或空值。也可运行 `.\.venv\Scripts\python.exe -m substack_api --help` 查看上游 CLI。

## 能力边界与错误处理

Newsletter 文章、文章元数据/内容、作者和用户信息。非官方接口可能变化；订阅内容需要有权访问的会话；评论支持需另行验收。保留原表已有覆盖标记。

空数据、权限错误和网络失败需分别处理，不应统一返回成功。业务封装还需加入输入校验、分页/总量限制、整体超时、受限重试、独立运行目录以及来源和观察时间。只有部分条目能力通过时，原表保留覆盖状态并逐项备注。

## 源码和版本

- 上游：[NHagar/substack_api](https://github.com/NHagar/substack_api)。
- 源码：[upstream/NHagar__substack_api](upstream/NHagar__substack_api/)，[原生 README](upstream/NHagar__substack_api/README.md)。
- 固定提交：`714f4e564786af97a076595fd6bf5942dccc42a2`，提交时间：2026-05-29T08:56:17-05:00。
- 源码核验：[upstream.lock.json](upstream.lock.json)。实时验收以 validation 中记录为准。

本目录复测：按本文安装依赖后，运行 `.\.venv\Scripts\python.exe main.py --target "实际公开 URL" --timeout 110 --output data/recheck.json`，检查返回状态和实际数据。
