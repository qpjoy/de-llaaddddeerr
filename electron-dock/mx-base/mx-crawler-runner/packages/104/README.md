# Kick（104）

独立数据获取项目。统一入口为 [adapter.py](adapter.py)，能力与参数见 [manifest.yaml](manifest.yaml)。原始入口、采集逻辑、依赖和锁文件保留；完整原说明见 [README.legacy.md](README.legacy.md)。

## 目录结构与入口

以下为本项目实际保留的主要文件；复制整个独立项目目录即可交付。

```text
104/
├── src/  # 本项目采集代码
├── adapter.py  # 统一 JSON 调用入口
├── manifest.yaml  # 项目、能力、输入和返回声明
├── main.py  # 原生命令行入口，参数见 --help
├── pyproject.toml  # Python 项目及构建声明
├── requirements.lock.txt  # 原锁定依赖
├── upstream.lock.json  # 原上游版本与来源记录
├── README.md  # 安装、配置及调用说明
├── README.legacy.md  # 保留的原说明
├── examples/  # 调用示例和 JSON 输入样例
├── tests/  # 原回归及适配协议测试
├── scripts/  # 本项目安装、检查脚本
├── upstream/  # 原上游源码，完整保留
├── validation/  # 原验证记录
└── ADAPTER_VERIFICATION.json  # 独立安装和适配检查记录
```

- **业务统一调用：**执行 `adapter.py` 或 `from adapter import invoke`，使用统一 JSON 协议。
- **原生调用：**安装依赖后执行 `python main.py --help`，继续使用原项目参数和功能；不要将原生 CLI 参数传给 adapter。
- **源码和依赖：**原文件保留；`src/` 是本项目实现，依赖目录随本项目复制，不能只复制 adapter.py。
- **输出文件：**`.venv/`、构建缓存和临时运行数据由本机生成，不作为交付源码。安装步骤见“安装”；环境、端口、凭据、目录权限和上线检查见本 README 的“部署条件”。

本项目脚本：

| 文件 | 用途 |
| --- | --- |
| `scripts/install.ps1` | 安装本项目依赖和代码；具体凭据与外部工具按上文配置 |
| `scripts/test.ps1` | 执行本项目测试；具体测试范围由原脚本确定 |

## 安装

在本项目目录执行，使用 Python 3.11+；现有锁文件主要在 Windows / Python 3.13 验证。依赖解析失败时保留版本并记录问题，不自动升级或更换库。

```powershell
python -m venv .venv
.venv\Scripts\python -m pip install -r requirements.lock.txt
.venv\Scripts\python -m pip install --no-deps .
.venv\Scripts\python -m pip install --no-deps "upstream/yt-dlp__yt-dlp"
```

可单独复制本目录安装，不需要父工程或其他平台。

## 部署条件

本节是本平台实际部署所需的条件。按上方命令在本目录创建独立环境并安装原锁定依赖后，再完成以下配置。

| 部署项 | 本平台要求 |
| --- | --- |
| 操作系统与 Python | 已验收环境为 Windows + Python 3.13.3；项目声明 Python 3.11+。其他系统/版本需按原锁文件复测，不能直接套用 Windows 二进制或系统专用依赖。 |
| 额外依赖及工具 | 保留原 yt-dlp 固定源码；当前只获取元数据，不需要 FFmpeg、Node.js 或浏览器。 |
| 运行网络与端口 | 访问 Kick 页面、提取器接口及涉及的 CDN，出站 HTTPS 443。 |
| 凭据与权限 | 已验收公开剪辑，无 API Key 要求；直播或需要会话的目标不在已验收范围。 |
| 文件与目录权限 | params.work_dir（默认 data）需可创建目录。 |
| 输入、并发及超时 | 指定剪辑 URL；总超时默认 110 秒，不包含历史聊天或持续直播监控。 |
| 服务与进程 | 本项目不启动 HTTP 服务、不需要入站监听端口。平台调度每次启动一个 adapter.py 进程；当前同步 invoke 不应在同一解释器内并发调用。 |
| 容量 | 现有记录为功能验收，没有容量压测结论；按上述批量、并发上限及实际响应大小安排 CPU、内存和磁盘。 |

### 部署配置步骤

1. 按本目录锁文件和原上游源码安装，不另装本入口没有使用的浏览器或转码组件。
2. params.target 使用本平台真实公开 URL；先确认部署网络能访问该目标。
3. 指定可写 params.work_dir；当前入口未提供的账号、Cookie 参数不要擅自添加到 JSON 请求。

### 部署后检查与验收

安装及配置完成后，在本平台目录运行以下离线检查：

```powershell
.venv\Scripts\python -m pip check
.venv\Scripts\python main.py --help
.venv\Scripts\python -m unittest discover -s tests -p test_adapter.py -v
```

以上检查不代表已经取得真实数据。需要验证实际采集时，先将 examples/adapter-request.json 中的占位目标替换为本平台真实目标，再调用 adapter.py；有凭据的项目按本节配置，查询可能消耗额度。

- 调用方写完一个 JSON 请求后关闭 stdin，从 stdout 解析一个完整 JSON 结果，stderr 收集日志。
- 检查外层 status 以及 result 内的原始状态、数据、告警和错误；退出码正常或安装成功不能替代有效数据验收。

### 本平台常见部署问题

剪辑不存在、入口受限或提取器失败需检查实际目标；频道离线不等于全平台不可用。

历史能力边界和实时验收情况仍见下方“凭据与当前限制”、README.legacy.md 和原验证记录；本次补充部署文档不改变该状态。

## 调用

```powershell
Get-Content -Raw -Encoding UTF8 examples/adapter-request.json | .venv\Scripts\python adapter.py
```

Windows PowerShell 5.1 输入含中文时，先设置 `$OutputEncoding = [System.Text.UTF8Encoding]::new()`。示例是输入格式示范，占位 URL/应用 ID 需替换；运行示例会真实查询并可能消耗额度。

```python
from adapter import invoke

request = {'operation': 'collect',
 'params': {'target': 'https://kick.com/replace-channel/clips/replace-id'}}
response = invoke(request)
print(response["status"])
print(response["result"])
```

| operation | 必填 params |
| --- | --- |
| `collect` | `target` |

参数名、类型、默认值见 manifest 对应操作，业务限制沿用原 SDK。适配器使用显式操作白名单，拒绝未知参数；不会将任意函数名当作可执行操作。运行数据路径相对于调用时的工作目录，由业务方配置。

## 返回与日志

统一返回 `schema_version`、`project_id`、`source_id`、`operation`、`observed_at`、`status`、`result`、`error`。`observed_at` 是适配器本次观察时间；原始采集观察时间保留在 `result`。`result` 完整保留原始 JSON，包括原有来源、告警、分页游标与业务错误。外层 `error` 为 `{"code":"..."}` 或 null。

状态为 `success/no_data/partial/unknown/error/stopped`；原 `failed` 映射为外层 `error`，原始状态不改动。批量每项状态相同则继承，否则为 `partial`，需逐项检查 result。监控正常停止不表示取得真实事件。原 SDK 的事件读取返回非空 items 时为 success，空页为 no_data。

命令行每次只处理一个 JSON 请求（最多 1 MiB）；正常、无数据、正常停止退出码为 0，其余为 1。stdout 仅输出一个 JSON 文档；打印、控制台日志和原生子进程继承的 stdout 转到 stderr，原有日志文件继续保留。解析失败、未知操作、参数错误、缺依赖和执行异常均返回结构化错误。

失败格式示例：`{"schema_version":"1.0","project_id":"104","source_id":"104","operation":null,"observed_at":"2026-09-15T00:00:00+00:00","status":"error","result":null,"error":{"code":"UNKNOWN_OPERATION"}}`。

`invoke()` 是同步函数；日志重定向作用于当前进程，不可在同一解释器中并发调用。统一调度时每次请求使用独立进程。超时、并发、重试保持原参数及原默认值；不会增加隐式重试。



## 凭据与当前限制

当前采集入口不要求 API Key；平台访问条件见原说明。 不在代码、示例或文档中写真实凭据，不将凭据文件随项目交付。

保持原说明中的能力边界，历史成功不能保证任意目标当前可用。

## 验证及文件

```powershell
.venv\Scripts\python -m unittest discover -s tests -p test_adapter.py -v
```

以上为离线适配测试，不消耗查询额度。整理检查结果见 [ADAPTER_VERIFICATION.json](ADAPTER_VERIFICATION.json)；本次不把适配测试当作实时取数验收。

`src/` 保存采集实现，`adapter.py` 提供统一入口，`manifest.yaml` 声明协议，`examples/adapter-request.json` 提供输入示例；原始代码、依赖、工具、原生文档和历史验收记录继续保留。原源码副本后续应以 src 中的实现维护，旧入口作为兼容保留，本次两者采集逻辑一致。
