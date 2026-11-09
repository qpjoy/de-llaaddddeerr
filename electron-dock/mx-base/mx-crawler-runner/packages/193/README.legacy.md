# Google Play — 数据源表序号 193

本目录是独立 Python 项目。入口为 [main.py](main.py)，业务方调用 [mingxi_google_play.collect](src/mingxi_google_play/client.py) 获得 JSON 对象后自行封装 HTTP 接口。

底层使用 `facundoolano/google-play-scraper` 的 Node.js 实现；本目录包含所需上游源码、许可证、依赖锁和调用层，不依赖父工程或其他平台。Python 调用仍需 Node.js，不是纯 Python 爬虫。项目不下载 APK、图片或视频，返回相关公开字段或链接。

**本次已实测通过 9 类功能：详情、搜索、评论、榜单、开发者应用、搜索建议、相似应用、权限和数据安全声明。categories 分类目录未取得有效数据，保留为诊断入口；完整历史版本不在支持范围。** 详见 [验收记录](VERIFICATION.md)。

## 安装

需要 Python 3.11+、Node.js 22+（包含 npm）。本次使用 Windows、Python 3.13.3、Node 22.16.0；其他环境未实机验收。Node/npm 需在 PATH 中。

进入本目录，执行：

```powershell
.\scripts\setup.ps1
.\.venv\Scripts\python.exe main.py --help
```

安装脚本先在 `.venv` 安装 Python 包，再按锁文件安装本目录的 Node 后端到 `.runtime/<源码指纹>/`。重复安装相同版本会复用后端。首次安装需要访问 Python/npm 包仓库，无需 Google 账号或 API Key。

使用已有 Python 环境，或 Linux/macOS，可执行：

```bash
python -m pip install -r requirements.lock.txt .
python -m mingxi_google_play.runtime --runtime-dir .runtime
python main.py --help
```

运行时将 `.runtime` 保存在业务方可写目录；修改代码后需重装 Python 包并重新运行 runtime 安装命令。新指纹生成独立后端目录，不覆盖旧版本。依赖锁为 [package-lock.json](src/mingxi_google_play/node/package-lock.json)；Python 运行期只用标准库。

## 最小 Python 调用

```python
from mingxi_google_play import collect

result = collect("app", app_id="com.google.android.apps.translate")
if result["status"] == "success":
    print(result["data"]["items"][0])
else:
    print(result["status"], result["error"], result["warnings"])
```

搜索及评论：

```python
from mingxi_google_play import collect

apps = collect("search", term="Google Translate", num=3, country="us", lang="en")
reviews = collect("reviews", app_id="com.google.android.apps.translate", max_pages=1)
token = reviews["data"]["next_page_token"]
# 有 token 时可按同一应用、国家、语言、排序继续，不能跨应用复用。
if reviews["status"] == "success" and token:
    next_page = collect("reviews", app_id="com.google.android.apps.translate", next_page_token=token)
```

从任意业务工作目录调用时，请传入 `runtime_dir` 的绝对路径，以及可写的 `work_dir`。每次调用创建独立 run-UUID 目录，支持在同一 Python 进程连续调用。

## CLI

```powershell
.\.venv\Scripts\python.exe main.py app --app-id com.google.android.apps.translate --output data/app.json
.\.venv\Scripts\python.exe main.py search --term "Google Translate" --num 3 --output data/search.json
.\.venv\Scripts\python.exe main.py reviews --app-id com.google.android.apps.translate --max-pages 2 --output data/reviews.json
```

也支持 `python -m mingxi_google_play` 和安装后的 `mingxi-google-play` 命令。省略 `--output` 时 stdout 仅输出 JSON；运行日志另存文件。退出码：success 为 0，其他结果为 1，参数错误为 2。

## 功能与参数

| operation | 必填参数 | 范围 |
|---|---|---|
| app | app_id | 应用详情、开发者、评分、描述、图标和截图链接等 |
| search | term | 关键词搜索，num 默认 20，范围 1–100 |
| reviews | app_id | 评论正文、评分、时间、回复等；完整页面，每页至多 150 条 |
| list | 无 | 当前榜单/分类列表，collection 默认 TOP_FREE，可选 TOP_PAID、GROSSING；category 为上游分类常量；num 默认 20 |
| developer | developer_id | 开发者名或 ID 对应应用列表；num 默认 20 |
| suggest | term | 搜索词建议，条数由上游决定 |
| similar | app_id | 相似应用列表；默认最多 20 条 |
| permissions | app_id | 公开权限说明 |
| datasafety | app_id | 商店的数据安全声明，不代表独立审计结论 |
| categories | 无 | 页面可解析的分类；不会将上游合成的 APPLICATION 当作取数成功 |

这些是实现入口，实际验收范围及失败项见 [VERIFICATION.md](VERIFICATION.md)。应用详情版本 `VARY` 表示因设备而异；此项目没有完整历史版本归档，也不提供七麦/点点的下载量、收入估算或历史趋势。

| 通用参数 | 默认 | 含义 |
|---|---|---|
| lang / country | en / us | 语言与商店地区；datasafety/categories 上游入口不保证按 country 切换，不能当作地区完整数据 |
| max_pages | 1 | 仅 reviews 可设 1–5；整页读取，至多 750 条，不接受 num 截断评论页 |
| next_page_token | None | reviews 续页标记，必须与原应用、语言、国家、排序一致 |
| sort | newest | reviews 支持 newest、rating、helpfulness |
| timeout | 90 | 单次调用的子进程总超时，秒，范围 0.1–600 |
| request_timeout | 15 | 单 HTTP 请求超时，秒，范围 0.1–600 |
| max_requests | 20 | 请求预算，1–100；包括重定向，达到上限后明确报错 |
| work_dir | data | 运行结果和日志目录；不写入安装包目录 |
| runtime_dir | .runtime | 安装过的 Node 后端所在目录 |
| proxy | None | 默认读取环境/系统代理并尊重 NO_PROXY；空字符串表示直连 |
| node_path | None | 默认查找 PATH 中的 node；可指定可执行文件绝对路径 |

每次调用的 HTTP 连接并发限制为 1，配置限速为每秒 1 个请求，同次调用复用连接池。无自动重试；业务方发起多任务时需自行限制总并发和重试次数。响应完成后检查 16 MiB 大小上限；这不是传输中流式截断。

## 网络与凭据

Google Play 在本机直接连接会超时；通过本机已有 HTTPS 代理已取得数据。业务方应配置可访问 Google Play 的网络。SDK 自动读取 `HTTPS_PROXY`/`HTTP_PROXY` 和系统代理；可用 `proxy=""` 或 CLI `--direct` 明确直连。代理地址不要写入代码或提交到仓库。

TLS 使用系统 CA 根证书补充 Node 默认信任，始终开启证书及域名校验。代理通过子进程 stdin 传递，不放在命令行或结果中；结果仅记录 proxy_used。不会读取其他平台的 API Key。

## 返回与错误

| 字段 | 含义 |
|---|---|
| source_row_id / platform / operation | 193、google_play、调用功能 |
| query | 本次应用包名、搜索词、开发者、语言、地区等查询上下文，不包含代理凭据 |
| observed_at | 本次采集结束时间，UTC |
| status | success / partial / unknown / error |
| data.items | 上游字段对象列表；app/datasafety 也包装为列表 |
| data.next_page_token / has_more | 评论续页标记及是否还有后续页 |
| source_urls | 实际请求来源地址 |
| stats | 请求数、已完成页数、被拒绝的不完整记录数 |
| warnings / error | 能力或数量限制、失败原因 |
| execution | 独立运行目录、代理是否启用、返回码、是否总超时 |

评论成功仅表示请求的页面完成，不表示收齐所有评论。失败时已完成的评论页返回 partial，并保留续页标记；网络错误或空结果不能解释为应用已经下架。

合成结构示例（非验收数据）：

```json
{"source_row_id":193,"platform":"google_play","operation":"app","status":"success","data":{"items":[{"appId":"com.example.app","title":"示例应用","developer":"示例开发者"}],"next_page_token":null,"has_more":false},"warnings":[],"error":null}
```

```json
{"source_row_id":193,"platform":"google_play","operation":"reviews","status":"error","data":{"items":[],"next_page_token":null},"error":{"code":"REQUEST_TIMEOUT","message":"Request timed out"}}
```

输入不合法抛 ValueError，文件不可写抛 OSError；安装缺失返回 SETUP_REQUIRED。请求失败返回 SOURCE_ERROR/REQUEST_TIMEOUT/REQUEST_LIMIT；总超时返回 TIMEOUT。调用方应检查 status 和 error，不以进程启动成功或 HTTP 200 判定取数成功。

## 测试、文件与来源

```powershell
.\.venv\Scripts\python.exe -m unittest discover -s tests -v
.\.venv\Scripts\python.exe scripts/smoke.py
```

smoke.py 默认真实查询 app/search/reviews，`--all` 检查全部 10 类入口。结果写入 data/verification/；不会自动修改 Excel。

每次运行产生 result.json、checkpoint.json、process.log 和系统公开根证书文件；业务方自行设置运行数据保留周期。`.venv`、`.runtime`、data、缓存和构建产物不纳入交付。交付本目录的代码、README、依赖文件、必要上游源码及 verification 即可。

上游：[facundoolano/google-play-scraper](https://github.com/facundoolano/google-play-scraper)，固定提交 `1547a3a51bc56390ea0ecae7d8a6eca6d343003d`，版本 10.1.3，MIT 许可。作者说明不再主动维护，主要审核社区 PR；页面变化可能导致失效。文件哈希见 [upstream.lock.json](upstream.lock.json)，修改说明见 [UPSTREAM.md](UPSTREAM.md)。
