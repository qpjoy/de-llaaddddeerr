# Dailymotion — 原表序号 101

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

**已取得真实数据（限下列能力）。** 换用 API 查询得到的有效视频，补装 curl_cffi 后成功；旧测试视频已失效。频道、评论未验收。

## 安装与配置

已在 Windows / Python 3.13.3 的独立虚拟环境安装固定源码提交并检查导入。运行依赖已记录在 [requirements.lock.txt](requirements.lock.txt)；这份锁针对本次验证环境，不代表所有操作系统均已通过。

在本平台目录执行：

```powershell
python -m venv .venv
.\.venv\Scripts\python.exe -m pip install -r requirements.lock.txt
.\.venv\Scripts\python.exe -m pip install --no-deps ".\upstream\yt-dlp__yt-dlp"
```

运行依赖锁已包含 curl_cffi；仅安装 yt-dlp 基础包时，本次视频需要的 Firefox 请求模拟不可用。

业务方可复制本平台目录独立安装上游项目。此阶段验证上游原生调用，尚未提供统一业务返回模型或 HTTP 服务。凭据用环境变量传入，不写入源码。

## 实际验证

- 验证时间（UTC）：2026-09-10T16:41:24.247344+00:00
- 结论：换用 API 查询得到的有效视频，补装 curl_cffi 后成功；旧测试视频已失效。频道、评论未验收。
- 通过能力：video_metadata, media_url。
- 本次成功样本：`https://www.dailymotion.com/video/xhfpjn`。
- [原始调用结果](validation/live-03.json)、[安装环境](validation/environment.json)、[安装日志](validation/install.log)。历次失败及补装日志也保留在 validation 目录。

验证使用公开页面/API，未下载音视频文件。探测请求默认超时 20 秒，单次探测进程总时限 110 秒，批次最多 3 个并发；这属于验收脚本的限制，上游原生接口不一定都具有同等保护。

## Python / CLI 调用

以下使用上游原生返回类型。需要凭据的示例尚未真实调用；通过的示例仅代表上述已验收能力。

```powershell
.\.venv\Scripts\python.exe -m yt_dlp --list-extractors
.\.venv\Scripts\python.exe -m yt_dlp --skip-download --dump-single-json --playlist-end 5 --socket-timeout 30 --retries 1 "替换为实际公开URL"
```

Python 调用：

```python
import os
from yt_dlp import YoutubeDL

options = {"skip_download": True, "quiet": True, "playlistend": 5,
           "socket_timeout": 30, "retries": 1}
with YoutubeDL(options) as client:
    info = client.extract_info(os.environ["SOURCE_URL"], download=False)
    result = client.sanitize_info(info)
print(result)
```

输入为本平台支持的公开 URL。单条结果常见字段有 id、title、webpage_url、uploader、timestamp、duration、formats；列表结果使用 entries，字段可能缺失。`sanitize_info` 用于得到可序列化数据。异常要单独处理；以上不下载视频。下载媒体时才进一步检查 FFmpeg 等依赖。


## 能力边界与错误处理

视频链接、播放列表及用户视频列表的提取器；输出视频元数据。不承诺评论采集；地区、年龄和访问权限可能限制部分视频。

空数据、权限错误和网络失败需分别处理，不应统一返回成功。业务封装还需加入输入校验、分页/总量限制、整体超时、受限重试、独立运行目录以及来源和观察时间。只有部分条目能力通过时，原表保留覆盖状态并逐项备注。

## 源码和版本

- 上游：[yt-dlp/yt-dlp](https://github.com/yt-dlp/yt-dlp)。
- 源码：[upstream/yt-dlp__yt-dlp](upstream/yt-dlp__yt-dlp/)，[原生 README](upstream/yt-dlp__yt-dlp/README.md)。
- 固定提交：`bbc809a1161d3bfca51fa36f59dda35556ee85a0`，提交时间：2026-08-30T15:58:45+02:00。
- 源码核验：[upstream.lock.json](upstream.lock.json)。实时验收以 validation 中记录为准。

本目录复测：按本文安装依赖后，运行 `.\.venv\Scripts\python.exe main.py --target "实际公开 URL" --timeout 110 --output data/recheck.json`，检查返回状态和实际数据。
