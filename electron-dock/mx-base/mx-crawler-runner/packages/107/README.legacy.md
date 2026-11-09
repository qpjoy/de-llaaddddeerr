# WordPress.com — 原表序号 107

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

**已取得真实数据（限下列能力）。** 成功采集 WordPress.com 博客中的 1 个页面和 1 篇文章；HTML 包含额外页面内容，需清洗；结构化作者和评论未验收。

## 安装与配置

已在 Windows / Python 3.13.3 的独立虚拟环境安装固定源码提交并检查导入。运行依赖已记录在 [requirements.lock.txt](requirements.lock.txt)；这份锁针对本次验证环境，不代表所有操作系统均已通过。

在本平台目录执行：

```powershell
python -m venv .venv
.\.venv\Scripts\python.exe -m pip install -r requirements.lock.txt
.\.venv\Scripts\python.exe -m pip install --no-deps ".\upstream\bohdanbobrowski__blog2epub"
```


业务方可复制本平台目录独立安装上游项目。此阶段验证上游原生调用，尚未提供统一业务返回模型或 HTTP 服务。凭据用环境变量传入，不写入源码。

## 实际验证

- 验证时间（UTC）：2026-09-10T16:41:47.359658+00:00
- 结论：成功采集 WordPress.com 博客中的 1 个页面和 1 篇文章；HTML 包含额外页面内容，需清洗；结构化作者和评论未验收。
- 通过能力：blog_content, page_content。
- 本次成功样本：`https://19thcentury.wordpress.com`。
- [原始调用结果](validation/live-reviewed.json)、[安装环境](validation/environment.json)、[安装日志](validation/install.log)。历次失败及补装日志也保留在 validation 目录。

验证使用公开页面/API，未下载音视频文件。探测请求默认超时 20 秒，单次探测进程总时限 110 秒，批次最多 3 个并发；这属于验收脚本的限制，上游原生接口不一定都具有同等保护。

## Python / CLI 调用

以下使用上游原生返回类型。需要凭据的示例尚未真实调用；通过的示例仅代表上述已验收能力。

```python
from dataclasses import asdict
from pathlib import Path
from blog2epub import Blog2Epub
from blog2epub.models.configuration import ConfigurationModel
from blog2epub.common.interfaces import EmptyInterface

work = Path("data").resolve()
work.mkdir(exist_ok=True)
url = "https://19thcentury.wordpress.com"
settings = ConfigurationModel(url=url, limit="2", skip="0", include_images=False,
                              use_cache=False, destination_folder=str(work))
client = Blog2Epub(url=url, configuration=settings,
                  interface=EmptyInterface(), cache_folder=str(work))
client.download()
result = asdict(client.crawler.get_book_data())
print(result)
```

本次验证的是采集核心返回的 BookModel/ArticleModel，未生成 EPUB。返回包含 articles（url、title、date、content 等），date 需要序列化转换。原始 HTML 尚有页面杂项，comments 字段在样本中为空，不能当作评论功能通过。

上游部分网络调用没有请求超时参数。本次外层进程设置 110 秒总时限并为 requests 补充默认 20 秒超时；业务封装需要保留同类限制。

## 能力边界与错误处理

针对 wordpress.com 博客采集正文，部分站点可带评论，生成 EPUB。原生输出为 EPUB，尚需适配业务 JSON；不是 WordPress.com REST SDK；作者、页面及外链字段需逐项验证。

空数据、权限错误和网络失败需分别处理，不应统一返回成功。业务封装还需加入输入校验、分页/总量限制、整体超时、受限重试、独立运行目录以及来源和观察时间。只有部分条目能力通过时，原表保留覆盖状态并逐项备注。

## 源码和版本

- 上游：[bohdanbobrowski/blog2epub](https://github.com/bohdanbobrowski/blog2epub)。
- 源码：[upstream/bohdanbobrowski__blog2epub](upstream/bohdanbobrowski__blog2epub/)，[原生 README](upstream/bohdanbobrowski__blog2epub/README.md)。
- 固定提交：`97ab6fe30793623ad5e1eafcffb1609b20842a33`，提交时间：2025-11-27T21:04:58+01:00。
- 源码核验：[upstream.lock.json](upstream.lock.json)。实时验收以 validation 中记录为准。

本目录复测：按本文安装依赖后，运行 `.\.venv\Scripts\python.exe main.py --target "实际公开 URL" --timeout 110 --output data/recheck.json`，检查返回状态和实际数据。
