# 46 · 喜马拉雅

通过上游 baseInfo 接口按声音 ID 发现专辑、采集公开非付费声音信息和音频 URL，可选有界邻近 ID 探测。基于 AudioSpider 固定提交直接请求来源，不调用 Apify。可单独复制本目录安装运行，业务方可以调用 Python SDK 或 JSON 入口封装接口。

## 能力与限制

不支持关键词搜索、完整专辑遍历、全平台扫描或付费音频。相邻声音 ID 不等于同一专辑；只有 albumId 相符才收录。isPaid=true、isPublic=false 或草稿会拒绝。isFree=false 不能单独判断付费，以上游 isPaid/公开状态与公开音频字段为准。数值 ID 种子必须先真实查询，失败不算发现成功。

默认只取得元数据和 URL；`download` 才会下载文件。只处理公开可访问的音频，使用和再分发需遵守来源授权。无需账号、Cookie 或 API Key；不实现付费访问、验证码绕过、音频转写、Docker 或 HTTP 服务。

## 部署条件与配置

- Python 3.11+；支持 Windows/Linux/macOS，实际验证环境见 acceptance/verification.json。无需 Node.js、浏览器或数据库服务。
- 安装需要 Python 包源；运行需要访问 mobile.ximalaya.com、www.ximalaya.com、*.xmcdn.com，以及合法 HTTP(S) 重定向目标。网络与来源限制会明确返回错误。
- 尊重环境变量 `HTTP_PROXY`、`HTTPS_PROXY`、`NO_PROXY`；没有配置则直连。代理凭据不写入代码或结果。只允许公共 HTTP(S) 80/443 地址，拒绝带凭据 URL 和私网地址；直连检查 DNS，显式代理负责远端解析，部署代理应限制内网目标。
- 每次必须指定可读写的 `run_dir`；存放 SQLite、进程锁、音频、下载元信息及 `.part` 临时文件，不得放到已安装包目录。不同平台使用不同 run_dir。同一 run_dir 同时只允许一个操作，冲突返回 RUNTIME_BUSY；进程退出自动释放锁。
- 下载原格式不需要 FFmpeg。仅 `format=opus` 需要部署方提供启用 libopus 的 FFmpeg，通过 `ffmpeg_path` 或 PATH 配置。转换输出 24kHz、单声道、32kbps Opus，保留原文件，记录工具版本和二进制 SHA-256，不自动下载安装系统工具。

## 安装

在本序号目录执行：

```powershell
python -m venv .venv
.venv\Scripts\python.exe -m pip install -r requirements.lock
.venv\Scripts\python.exe -m pip install --no-deps --no-build-isolation .
```

Linux/macOS 将 `.venv\Scripts\python.exe` 换成 `.venv/bin/python`。requirements.txt 原样保留上游依赖声明，部署使用精确锁 requirements.lock；未升级其他平台的依赖。upstream 是完整溯源快照，不直接运行其中会写包内目录的原始 main/config。

## 最小调用示例

```python
from audiosource_46 import invoke

result = invoke({
    "operation": "discover",
    "params": {"run_dir": "./runtime/46", "track_ids": ["3558286"], "limit": 1}
})
print(result["status"])
print(result["result"]["items"])
```

异步项目使用 `await invoke_async(request)`；已有事件循环不要调用同步 invoke。

```powershell
$OutputEncoding = [System.Text.UTF8Encoding]::new()
Get-Content -Raw -Encoding UTF8 examples/discover.json | .venv\Scripts\python.exe main.py
Get-Content -Raw -Encoding UTF8 examples/collect.json | .venv\Scripts\python.exe adapter.py
Get-Content -Raw -Encoding UTF8 examples/list.json | .venv\Scripts\python.exe main.py
# 以下操作才下载文件
Get-Content -Raw -Encoding UTF8 examples/download.json | .venv\Scripts\python.exe main.py
```

先 discover，后 collect，再 list_records/stats 或 download。示例中的 run_dir 可改成独立数据盘路径。STDIN 接收一个 UTF-8 JSON（最多 1 MiB），STDOUT 只输出一个 JSON，日志属于 STDERR。success/no_data 退出码为 0，其余为 1。collect 支持 `probe_range`（默认 0，0–5）与 `max_track_requests`（默认 10，1–50，按 collection 限制）。先处理种子，再按 ±1、±2 等展开，去重、核对专辑，取得 episodes_per_feed 条有效音频或耗尽请求预算即停止。`examples/neighbors.json` 演示 3 次请求的相邻探测。discover 再次发现同一专辑会用本次种子列表更新其采集范围。

## 输入参数

请求结构是 `{"operation":"discover","params":{...}}`，未知参数拒绝；完整结构见 manifest.yaml。

| discover 参数 | 说明 |
| --- | --- |
| track_ids | 声音 ID 字符串列表；默认 ["3558286"]；必须为不带前导零的正整数字符串，最长 15 位 |
| limit | 默认 10，1–20；同专辑种子合并成一个 collection；输入数量不得超过 limit |

| 公共与工作流参数 | 默认和限制 |
| --- | --- |
| run_dir | 必填，调用方提供的数据目录 |
| request_timeout | 单请求 30 秒，允许 1–120 秒 |
| total_timeout | 操作 180 秒；download 600 秒；允许 1–3600 秒 |
| concurrency | 2，允许 1–4；采集集合/下载文件并发上限 |
| request_interval | 同一发现/集合中连续种子及邻近请求间隔 2 秒，允许 0.5–30 秒；不是跨进程全局限速 |
| collect.collection_ids | 可选，discover 返回的稳定 ID 列表，最多 feed_limit 条 |
| collect.feed_limit | 5，允许 1–50；名称沿用统一契约，含义是采集集合数量，不是 RSS |
| collect.episodes_per_feed | 10，允许 1–50；页面可见单集或种子样本上限 |
| collect.refresh | false，仅处理未成功集合；true 刷新已知集合 |
| list_records.limit / offset | 20 / 0；limit 最多 1000，offset 最多 10000000 |
| list_records.record_ids / status | 可选稳定记录 ID 或 pending/downloading/done/failed |
| download.limit / record_ids | 默认 1 条 pending，可显式指定记录；最多 100 条 |
| download.retry_failed | false；true 且未传 record_ids 时选 failed 队列 |
| download.max_file_bytes | 每文件 100 MiB，范围 1 byte–2 GiB |
| download.format | original（默认）或 opus |
| download.ffmpeg_path / conversion_timeout | 可选工具路径；转换 120 秒，最多 600 秒，同时受总体截止时间约束 |

HTML 最多 20 MiB、元数据 JSON 最多 8 MiB。没有隐藏的 HTTP 自动重试；业务方可稍后重调失败的 discover/collect，使用 refresh 或指定 collection_ids 刷新。下载通过 retry_failed 或 record_ids 重试；同一文件保留部分数据，服务端支持时 Range 续传，并核对范围和响应长度。

## 返回字段及状态

外层包含 schema_version、project_id、source_id（原表序号）、operation、observed_at（UTC ISO8601）、status、result、error。result 包含 items、errors、warnings、stats、pagination，collect 另有 new_records。

- discover items：稳定 id、upstream_id、title、author、collection_url、feed_url、language、observed_at、raw。feed_url 沿用统一结构，在本项目中为来源页面 URL，不是 RSS。
- collect/list_records items：稳定 id、collection_id、upstream_item_id、title、author、speaker、published_at、duration（秒）、file_size、file_format、url、page_url、来源和发现时间；列表附带 status、local_path、sha256、last_error、downloaded_at。统计数据缺失返回 null，不伪造为零；file_size=0 表示未知。
- 喜马拉雅额外保留 original_audio_url、upstream_declared_size；公开 xmcdn HTTP 地址以同资源 HTTPS 请求。上游标称字节数可能不准确，实际下载大小见 bytes。
- download items：local_path、bytes、sha256、duplicate_of、conversion。转换失败保留原文件，返回 partial。warnings 说明页面或种子取样范围，errors 逐项包含 code 和 message。

状态区分 success（本次限定范围完成）、no_data（有效空结果或已有来源均已处理）、partial（有数据也有失败）、unknown（总体超时且无可返回结果）、error（参数/网络/解析等失败）。成功不代表全平台、全历史或所有音频均可下载。

格式示例，仅为结构说明，不是真实采集记录：

```json
{"status":"success","result":{"items":[{"title":"示例单集","url":"https://example.org/audio.mp3"}],"errors":[],"warnings":[]},"error":null}
```

```json
{"status":"error","result":{"items":[],"errors":[],"warnings":[]},"error":{"code":"INVALID_INPUT","message":"run_dir is required"}}
```

## 增量状态、文件与恢复

SQLite 按稳定记录 ID/音频 URL 去重，补齐缺失日期。失败集合记录错误，不标记采集完成；部分成功也保留有效记录。refresh=true 或显式 collection_ids 用于重新获取已知来源；每个集合完成立即提交，整体超时保留已提交数据。由业务方负责定时调用，没有隐藏后台进程。

下载状态为 pending/downloading/done/failed；进程恢复并取得独占锁后，把遗留 downloading 置回 pending。文件完整校验后才把 `.part` 改为正式文件，计算 SHA-256；相同内容只标记 duplicate_of，不删除原文件。Range 被忽略返回 200 时重新写入；206 核对起点/总长度，416 必须证明本地大小等于远端总大小。源 URL 改变时不混用原部分下载。元信息保存在音频旁的 JSON 文件；音频 URL 可能失效，应先刷新采集。

## 目录与复测

```text
46/
  main.py / adapter.py
  manifest.yaml
  pyproject.toml / requirements.txt / requirements.lock
  README.md / LICENSE / CHANGES.md
  src/audiosource_46/        独立 SDK、采集、状态与下载
  upstream/                    固定版本原始文件和 provenance.json
  examples/                    Python 和 JSON 示例
  tests/                       离线回归测试
  scripts/verify.py             离线复测入口
  acceptance/                  安装、离线和真实验收记录
```

```powershell
.venv\Scripts\python.exe scripts/verify.py
.venv\Scripts\python.exe examples/call.py --run-dir ./runtime/46 --operation stats
```

实际安装/测试结果见 acceptance/verification.json；真实请求及限制见 acceptance/live.json。测试使用合成响应，不代替真实取数；缺少 FFmpeg 时仅标记转码待验收。

## 2026-09-18 实际验证

本目录独立复制到隔离环境后，锁定依赖安装、项目安装、导入、Python 示例、模块 CLI 和命令行入口全部通过。Windows / Python 3.13.3 下，本项目 31 项离线回归测试通过。

实测种子发现和声音详情成功；3 次请求取得同专辑 3 条声音；完整下载 1027710 字节 MP3，SHA-256 校验通过。真实调用均返回 success，记录保存在 [live.json](acceptance/live.json)、[下载结果](acceptance/live-download.json) 与 [文件校验](acceptance/audio-integrity.json)。离线结果见 [verification.json](acceptance/verification.json)。

邻近探测默认关闭，不是完整专辑遍历；无关键词搜索、评论正文、主播主页、主体追踪或付费音频能力。当前没有 FFmpeg，可选 Opus 转码尚未真实验收；无需 FFmpeg 的原格式下载已经通过。

## 上游版本

[AudioSpider 固定版本](https://github.com/yinhao0214/AudioSpider/tree/cbc055436b71fa3f3882bedc95b65bad4dec2553)，MIT；提交 `cbc055436b71fa3f3882bedc95b65bad4dec2553`。保留完整原始文件与哈希，详见 upstream/provenance.json；适配差异见 CHANGES.md。
