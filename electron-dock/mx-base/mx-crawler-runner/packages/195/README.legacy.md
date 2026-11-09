# 小米应用商店 — 数据源表序号 195

实现入口：[main.py](main.py)；Python 实现：[client.py](src/mingxi_market_195/client.py)；市场请求和解析：[spider.py](src/mingxi_market_195/spider.py)。

本目录是独立 Python 项目，复制本目录即可安装运行，不依赖父工程或其他平台。基于 `halifox/app_market_crawler` 固定提交整理，**应用详情已取得真实数据**。业务方使用 Python 函数返回值自行封装 HTTP 接口。

## 功能与限制

详情接口提供开发者、评分和评论数量，未采集评论明细、榜单或关键词排名。

本次已观察到的统一字段：`package, app_id, name, version, version_code, developer, rating, privacy_policy_url, updated_at, icon_url, download_url`。原始市场字段仍保存在每条记录的 `raw` 中。下载和图片字段只是链接，本项目不会下载 APK、图片或安装应用。数据有效性要求应用名称、包名或市场 ID，以及版本信息同时存在；HTTP 200 和上游 success=1 不单独代表有效取数。

## 安装

Python 3.11+。本次验证 Windows / Python 3.13；其他系统未实机验收。无需 MongoDB，也无需市场账号或 API Key。

进入本目录后执行：

```powershell
.\scripts\setup.ps1
.\.venv\Scripts\python.exe main.py --help
```

在业务方自己的虚拟环境也可以执行：

```powershell
python -m pip install -r requirements.lock.txt .
```

Linux/macOS 对应命令：

```bash
python3 -m venv .venv
.venv/bin/python -m pip install -r requirements.lock.txt .
```

锁文件固定本次通过的完整依赖；Scrapy 2.13.3 搭配 Twisted 25.5.0，解决原项目安装最新依赖后无法加载 HTTPS 下载器的问题。安装后修改源码需重装，开发时可用 `python -m pip install --no-deps -e .`。

## 最小调用

```python
from mingxi_market_195 import collect

result = collect(['1359'], work_dir="data")
if result["status"] == "success":
    for item in result["data"]["items"]:
        print(item["app"])
else:
    print(result["status"], result["error"], result["warnings"])
```

```powershell
.\.venv\Scripts\python.exe main.py 1359 --output data/result.json
```

同样支持 `python -m mingxi_market_195` 或安装后的 `mingxi-market-195` 命令。Python 不需要解析 CLI 输出；CLI 复用同一个 collect 函数。连续调用会启动各自独立的抓取子进程，避免 Scrapy reactor 无法重启；单次任务内保持 HTTP 连接池复用。

## 参数

| 参数 | 默认值 | 说明 |
|---|---|---|
| `inputs` | 必填 | 1–50 个字符串标识，包名或对应市场的数字 ID；不接受 URL |
| `input_kind` | `id` | 本平台可选：`id`；不同市场 ID 不通用 |
| `history` | False | 本平台支持历史的 input_kind：`无`；不支持时明确抛 ValueError |
| `history_limit` | 3 | 每个输入最多取 1–20 个历史版本详情；不代表全部历史 |
| `concurrency` | 2 | 单次任务 HTTP 并发，范围 1–5 |
| `timeout` | 90 | 整个子进程执行秒数上限，包括启动和请求；超时保留已完成记录 |
| `request_timeout` | 15 | 单次 HTTP 请求超时秒数 |
| `delay` | 0.5 | 同站点请求间隔秒数，至少为 0 |
| `max_requests` | 50 | 单次任务最多请求数，范围 1–200，包括入口和历史请求 |
| `work_dir` | data | 调用方可写目录；每次创建独立 run-UUID 子目录保存记录与日志 |

CLI 参数用短横线：`--input-kind`、`--history-limit`、`--request-timeout`、`--max-requests`、`--work-dir`。`--history` 是布尔开关；`--output` 指定结果 JSON 文件，省略时 stdout 只输出 JSON。

## 返回结果与错误处理

| 字段 | 含义 |
|---|---|
| `source_row_id` / `platform` / `provider` | 原表序号、本市场和上游项目 |
| `observed_at` | 本地采集完成时间，UTC |
| `status` | success / partial / unknown / error |
| `data.items[]` | 每项含 input_value、record_type（detail/history）、source_url、app、raw |
| `data.outcomes[]` | 按输入汇总的有效数据状态；失败原因同时看 errors/native_outcomes |
| `data.native_outcomes[]` | 上游原始标志，仅用于诊断；其 success=1 可能对应空数据 |
| `data.errors/rejected/http` | 解析错误、无效载荷、HTTP 请求结果 |
| `warnings` / `error` | 不完整、未知或失败原因；不要把失败解释成应用已下架 |
| `stats` / `execution` | 请求统计、退出原因、返回码、总超时及本次运行目录 |

`app` 包含本平台可用的 name、package、app_id、version、version_code、developer、rating、privacy_policy_url、download_url、updated_at、icon_url 等。不同平台缺字段时保持 null 或不提供；评分原始尺度、时间戳单位以及日期文本均保留，不做未经验证的换算。精确原生字段见 `raw`。

成功结构示例（合成示例，不是验收证据）：

```json
{
  "source_row_id": 195,
  "platform": "xiaomi",
  "provider": "halifox/app_market_crawler",
  "observed_at": "2026-09-12T00:00:00+00:00",
  "status": "success",
  "data": {"items": [{"input_value": "示例标识", "record_type": "detail", "source_url": "https://example.com/app", "app": {"name": "示例应用", "package": "com.example.app", "version": "1.0"}, "raw": {}}]},
  "warnings": [],
  "error": null
}
```

失败/未知结构示例（合成示例）：

```json
{"source_row_id": 195, "platform": "xiaomi", "status": "unknown", "data": {"items": []}, "warnings": ["Empty/error payloads were rejected instead of reported as success."], "error": {"code": "NO_VALID_RECORDS", "message": "Inspect outcomes, errors and rejected records"}}
```

参数错误抛 ValueError，无法创建运行目录或写文件会抛 OSError；网络、空响应和解析问题返回结果对象。总超时为 error，有已取得记录则为 partial。CLI 只有 success 返回 0，其他结果返回 1，参数错误返回 2。错误结果中没有应用记录不能当作“市场确认不存在”。

## 运行与测试

每次抓取在 `work_dir/run-UUID/` 产生 records.jsonl、summary.json、scrapy.log 和 process.log；业务方按自己的保留策略管理这些运行文件。没有 MongoDB 写入、后台服务或 APK 自动下载。

网络请求默认不自动重试，需重试时由业务方限制次数并退避。并发限制以单次 collect 为单位；多个业务任务应统一控制总并发。TLS 校验使用系统与 certifi 根证书，保持证书/域名校验。代理可通过 HTTPS_PROXY/HTTP_PROXY 设置；日志可能包含目标应用 URL，不应向其插入凭据。

```powershell
python -m unittest discover -s tests -v
python scripts/smoke.py
```

smoke.py 实际查询本目录示例，写入 data/verification/live.json，只有取得有效应用数据才成功退出。[本次真实结果](verification/live.json) 与 [验收说明](VERIFICATION.md) 随代码提供；测试中的合成记录不算真实取数。

## 交付与来源

main.py、src、scripts、examples、tests、README、依赖锁文件及 verification 构成本平台交付。`.venv`、build、缓存和 data 由本地安装/运行产生，不纳入交付。

上游：[halifox/app_market_crawler](https://github.com/halifox/app_market_crawler)，固定提交 `fd1e873299734b60a2bda20a20f454a1f4c43839`。许可证和本地修改见 [LICENSE](LICENSE)、[UPSTREAM.md](UPSTREAM.md)，请随源码保留。
