# Medium — 原表序号 96

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

**已取得真实数据（限下列能力）。** 补装 ua-generator 后，成功读取公开文章并转换为 Markdown；搜索、作者、出版物、评论未验收。

## 安装与配置

已在 Windows / Python 3.13.3 的独立虚拟环境安装固定源码提交并检查导入。运行依赖已记录在 [requirements.lock.txt](requirements.lock.txt)；这份锁针对本次验证环境，不代表所有操作系统均已通过。

在本平台目录执行：

```powershell
python -m venv .venv
.\.venv\Scripts\python.exe -m pip install -r requirements.lock.txt
.\.venv\Scripts\python.exe -m pip install --no-deps ".\upstream\sarperavci__medium-scraper"
```


业务方可复制本平台目录独立安装上游项目。此阶段验证上游原生调用，尚未提供统一业务返回模型或 HTTP 服务。凭据用环境变量传入，不写入源码。

## 实际验证

- 验证时间（UTC）：2026-09-10T16:40:37.733405+00:00
- 结论：补装 ua-generator 后，成功读取公开文章并转换为 Markdown；搜索、作者、出版物、评论未验收。
- 通过能力：public_article_markdown。
- 本次成功样本：`https://medium.com/@sarperavci/two-million-hackthebox-write-up-7433944c2efa`。
- [原始调用结果](validation/live-02.json)、[安装环境](validation/environment.json)、[安装日志](validation/install.log)。历次失败及补装日志也保留在 validation 目录。

验证使用公开页面/API，未下载音视频文件。探测请求默认超时 20 秒，单次探测进程总时限 110 秒，批次最多 3 个并发；这属于验收脚本的限制，上游原生接口不一定都具有同等保护。

## Python / CLI 调用

以下使用上游原生返回类型。需要凭据的示例尚未真实调用；通过的示例仅代表上述已验收能力。

```python
import asyncio
import os
from medium_scraper import RequestsRequestSender, MediumMarkdownParser

async def main():
    async with RequestsRequestSender(timeout=20) as sender:
        response = await sender.fetch(os.environ["SOURCE_URL"])
    if response.status_code != 200:
        raise RuntimeError(f"HTTP {response.status_code}")
    result = MediumMarkdownParser().parse_html(response.text, source_url=response.url)
    if result.error:
        raise RuntimeError(result.message)
    print(result.title)
    print(result.markdown)

asyncio.run(main())
```

这是本次验证的文章读取路径。按标签搜索的 MediumExplorer 尚未验收。`requirements.lock.txt` 已包含上游漏声明的 ua-generator。

## 能力边界与错误处理

公开文章发现、文章信息及 HTML 转 Markdown；提供 Python 库与 CLI。采用直接请求模式即可，不强制使用付费代理 API；评论、完整作者图谱及付费正文不计入已验证能力。

空数据、权限错误和网络失败需分别处理，不应统一返回成功。业务封装还需加入输入校验、分页/总量限制、整体超时、受限重试、独立运行目录以及来源和观察时间。只有部分条目能力通过时，原表保留覆盖状态并逐项备注。

## 源码和版本

- 上游：[sarperavci/medium-scraper](https://github.com/sarperavci/medium-scraper)。
- 源码：[upstream/sarperavci__medium-scraper](upstream/sarperavci__medium-scraper/)，[原生 README](upstream/sarperavci__medium-scraper/README.md)。
- 固定提交：`9cf365c5c052074e41e1dbde6a7618e89dee9db2`，提交时间：2025-11-14T22:41:34+03:00。
- 源码核验：[upstream.lock.json](upstream.lock.json)。实时验收以 validation 中记录为准。

本目录复测：按本文安装依赖后，运行 `.\.venv\Scripts\python.exe main.py --target "实际公开 URL" --timeout 110 --output data/recheck.json`，检查返回状态和实际数据。
