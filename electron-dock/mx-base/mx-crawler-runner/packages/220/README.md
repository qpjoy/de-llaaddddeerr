# 220 · Apple Podcasts

美国区默认的播客关键词搜索、分类榜单和单集采集。基于 AudioSpider 固定提交直接请求来源网站/API，不调用 Apify。
单独复制本目录即可安装、调用；独立通用 RSS、B站、小宇宙和喜马拉雅不在本项目的交付接口中。RSS 仅在已发现的节目/书目内部解析。

## 部署条件

- Python 3.11+，Windows/Linux/macOS；本次实际验证系统、版本和结果见 acceptance/verification.json。无需 Node.js、浏览器、Go、数据库服务或 HTTP 服务。
- 不需要 Apple 账号或 API Key。需要访问 itunes.apple.com，以及返回的播客 RSS 和音频 CDN。榜单接口与搜索接口分别验收；地区不等于节目语言，语言取 RSS 元信息。默认不扫描中国区。
- 安装需访问 Python 包源；运行需访问上述来源、RSS 和音频托管站的 HTTP(S) 80/443。仅允许公共地址，拒绝内网地址和带凭据 URL，重定向逐跳校验。尊重部署环境的 HTTP_PROXY、HTTPS_PROXY、NO_PROXY；未配置时直连，不自动寻找代理。直连时检查公共 DNS 地址；显式配置的代理负责远端域名解析，部署代理应限制内网目标访问。代理凭据不输出到日志。
- 每次调用必须提供 `run_dir`，其中存放 SQLite、锁文件、下载文件和元信息。该目录需可读写、磁盘空间足够，不能指向已安装包目录。不同平台必须用不同运行目录。
- 默认只采集信息和音频 URL，不下载文件。下载原格式无需 FFmpeg；`format=opus` 需要自行提供启用 libopus 的 FFmpeg，可设置 `ffmpeg_path`。工具版本和二进制 SHA-256 随转换结果记录，不静默下载安装系统工具。
- 同一 run_dir 一次只允许一个操作，冲突返回 RUNTIME_BUSY；不同运行目录可以并行，每次内部网络并发默认 2。SQLite 连接属于当前调用，结束后关闭。

## 安装

在本序号目录执行：

```powershell
python -m venv .venv
.venv\Scripts\python.exe -m pip install -r requirements.lock
.venv\Scripts\python.exe -m pip install --no-deps --no-build-isolation .
```

Linux/macOS 将 `.venv\Scripts\python.exe` 替换为 `.venv/bin/python`。原上游依赖声明保留在 requirements.txt；部署使用精确锁定的 requirements.lock。没有升级其他平台依赖。上游完整源码快照仅供追溯，运行入口使用 src 下的适配实现。

## 调用顺序

1. `discover` 返回节目/书目列表并保存其 ID 和 RSS 来源。
2. `collect` 解析未处理来源，返回单集/章节及音频 URL，增量入库。只接受本项目发现的 collection_ids，不提供任意 RSS URL 入口。
3. `list_records` 分页读取已保存记录，`stats` 查看状态。
4. 需要文件时显式调用 `download`；默认只下载 1 条 pending 记录。

```powershell
$OutputEncoding = [System.Text.UTF8Encoding]::new()
Get-Content -Raw -Encoding UTF8 examples/discover.json | .venv\Scripts\python.exe adapter.py
Get-Content -Raw -Encoding UTF8 examples/collect.json | .venv\Scripts\python.exe main.py
Get-Content -Raw -Encoding UTF8 examples/list.json | .venv\Scripts\python.exe adapter.py
# 以下命令才会下载文件
Get-Content -Raw -Encoding UTF8 examples/download.json | .venv\Scripts\python.exe adapter.py
```

示例 run_dir 为当前目录下 `runtime/220`；业务部署改为独立数据盘路径。不要把运行目录、凭据或大音频文件打包进交付代码。

```python
from audiosource_220 import invoke

response = invoke({
    "operation": "discover",
    "params": {"run_dir": "./runtime/220", **{'keyword': 'BBC Minute', 'country': 'us', 'limit': 3}}
})
print(response["status"])
print(response["result"]["items"])
```

异步应用使用 `await invoke_async(request)`，不要在已有事件循环中调用同步 invoke。STDIN 接收一个 UTF-8 JSON，STDOUT 只输出一个 JSON；日志属于 STDERR。成功/无数据退出码为 0，其余为 1，partial 仍可能有有效数据。

## 输入与默认限制

| 本平台 discover 参数 | 说明 |
| --- | --- |
| `keyword` | search 模式必填，1–200 字符 |
| `country` | 默认 us，两位小写地区代码 |
| `genre_id` | charts 模式必填分类 ID，如 1318 |
| `mode` | search（默认）或 charts |

完整参数及类型说明见 manifest.yaml；未知参数拒绝执行。

| 公共/工作流参数 | 默认与边界 |
| --- | --- |
| run_dir | 必填；调用方拥有的运行目录 |
| request_timeout | 单次请求 30 秒，允许 1–120 |
| total_timeout | 单次操作 180 秒，download 为 600 秒；允许 1–3600 |
| concurrency | 2，允许 1–16 |
| discover.limit | 10，允许 1–200；不默认遍历全目录 |
| collect.feed_limit / episodes_per_feed | 5 / 10；分别最多 50 / 200 |
| collect.collection_ids | 可选 discover 返回的 ID 列表，数量不超过 feed_limit |
| collect.refresh | false；true 表示重扫已知源以发现新增单集、补缺失日期 |
| list_records.limit / offset | 20 / 0；limit 最多 1000 |
| download.limit / record_ids | 默认 1，可显式给出记录 ID，最多 100 |
| download.retry_failed | false；true 重试 failed；显式 record_ids 优先 |
| download.max_file_bytes | 100 MiB，允许 1 byte–2 GiB；限制单文件，不是整个运行目录 |
| download.format | original；可选 opus（24kHz、单声道、32kbps） |
| download.conversion_timeout | 120 秒，最多 600；同时受总体截止时间控制 |

读取 RSS 最多 20 MiB，元数据 JSON 最多 8 MiB。没有隐藏的自动 HTTP 重试；网络错误、429、认证失败均明确返回。业务方可稍后重调失败的 discover/collect，下载使用 retry_failed 或指定 record_ids。默认小规模示例不保证全部历史结果。

## 返回字段与状态

外层为 schema_version、project_id、source_id、operation、observed_at、status、result、error；source_id 是本数据源表序号。
result 包含 items、errors、warnings、stats、pagination。discover items 包含稳定 id、上游 upstream_id、标题、作者、feed_url、语言、分类及 raw；collect/list_records items 包含稳定 id、collection_id、upstream_item_id（GUID）、title、speaker、author、published_at、duration（秒）、file_size（来源声明，0 表示未知）、file_format、url 和下载状态。
download items 包含 local_path、bytes、sha256、duplicate_of、conversion。conversion 失败时原文件保留，整体返回 partial。

- success：本次限定范围的操作完成，不等于整个平台完整覆盖。
- no_data：请求成功但本次没有记录；新源模式也可能是已有源均已处理。
- partial：已取得部分数据，同时有失败项或触发总体截止时间。
- unknown：总体超时且没有可返回的结果；可检查运行目录中的进度。
- error：参数、网络、凭据、解析、运行目录或依赖失败；看 error.code 与 result.errors。

结构片段示例（仅说明格式，**不是真实采集记录**）：
```json
{"status":"success","result":{"items":[{"id":"example_only","title":"示例单集","url":"https://example.org/audio.mp3"}]},"error":null}
```
失败结构片段：
```json
{"status":"error","error":{"code":"REQUEST_TIMEOUT","message":"HTTP request timed out"}}
```

## 增量、恢复与文件生命周期

SQLite 保存已发现来源、解析状态、稳定 GUID/URL 与下载状态。重复采集不会重复插入；没有时间戳的旧记录可补回日期。RSS 网络或解析失败不会被当作正常空结果标记完成；下一次可继续重试。
默认 collect 只取尚未成功解析的源。周期性更新由业务方定时调用 `collect` 并设置 refresh=true；不自动启动后台进程。需要精确轮询时指定 collection_ids。每个来源解析完立即提交，整体超时仍保留已提交记录。
运行结束或中断后释放 OS 锁；下次取得锁时将遗留 downloading 恢复为 pending。下载临时文件为 `.part`，只有校验传输长度后才改为正式文件。服务端忽略 Range 返回 200 时重新写入；206 必须匹配起点和总长度；416 必须证明本地大小等于远端总长度，不能直接当成功。
完整文件记录 SHA-256；相同内容标注 duplicate_of，不删除已有原文件。转码创建独立 `.converted.opus` 文件并保留原音频。源 URL 失效需要重新 collect 后核对；不支持付费音频解锁、DRM、私人内容或自动音频转写。

## 目录与验收

```text
220/
  main.py / adapter.py
  manifest.yaml
  pyproject.toml / requirements.txt / requirements.lock
  src/audiosource_220/          SDK、来源采集、存储与下载
  upstream/                    固定提交的原始源码与许可证（不直接执行）
  examples/                    JSON 与 Python 调用示例
  tests/                       回归测试
  scripts/verify.py             离线验证入口
  acceptance/                  真实与离线验收记录
  README.md / LICENSE / CHANGES.md
```

```powershell
.venv\Scripts\python.exe scripts/verify.py
.venv\Scripts\python.exe examples/call.py --run-dir ./runtime/220 --operation stats
```

实际验收以 acceptance/verification.json、acceptance/live.json 为准，分项区分成功、失败和未验收。缺少 Podcast Index 凭据或 FFmpeg 时只记录对应待验收能力，不把离线测试冒充实时结果。

## 2026-09-18 实际验证

独立复制项目到隔离环境后，安装、导入、Python 示例、JSON CLI 与本项目 30 项回归测试均通过（Windows / Python 3.13.3）。离线测试与真实调用分开记录。

关键词搜索返回 2 个节目，美国区分类榜单返回 3 项，已取得真实单集记录。随后通过 Apple 搜索发现公版播客，采集 3 个单集并完整下载 1 个 MP3（970,419 字节），SHA-256 校验通过。详见 [下载记录](acceptance/live-public-podcast-download.json) 与 [文件校验](acceptance/audio-integrity.json)。

BBC 与 All-In 的音频地址在当前环境返回 HTTP 403，失败记录已保留；元数据可用不代表所有 CDN 音频都能下载。

当前未配置 FFmpeg，可选 Opus 转码未进行真实验收；原格式下载不依赖 FFmpeg。完整部署条件、配置方法与复测命令均在本目录 README 中。真实调用汇总见 [live.json](acceptance/live.json)，安装与回归结果见 [verification.json](acceptance/verification.json)。

## 上游版本

[AudioSpider](https://github.com/yinhao0214/AudioSpider/tree/cbc055436b71fa3f3882bedc95b65bad4dec2553)，MIT，固定提交 `cbc055436b71fa3f3882bedc95b65bad4dec2553`。完整文件哈希见 upstream/provenance.json。详细适配差异见 CHANGES.md。
