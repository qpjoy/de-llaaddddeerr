# 2026-10-13 Night-All 标准搜索 429：证据与只读排查

本次提供的现场材料显示，三个 `/api/v1/data/search` 请求在北京时间 **2026-10-13 16:01:40** 附近返回 `night_all_http_429` / `RATE_LIMITED`，耗时约 10–19 ms。对应 UTC 为 **2026-10-13 08:01:40Z**。这种快速、跨平台的同类失败与 Night-All 共享入口限流一致，但当前没有宿主历史日志与运行配置，尚不能仅凭耗时确认具体限流层，也不能据此判断供应商余额或平台配额耗尽。

| 平台 | Hub 请求 UUID |
| --- | --- |
| Reddit | `9e20649f-ca22-455e-a9ff-16fe625ab9ad` |
| Twitter | `f9ed20e4-ecc9-4fb0-bcfc-2770817fdfda` |
| YouTube | `ac4b66e1-b757-40b6-a593-9340b8bd7c37` |

## 已确认的源码事实与待确认项

Night-All 本地源码 `routes/v1/data.js` 的 `/search` 路由先执行 `rateLimit({ scope: 'data-search', limit: parseInt(NIGHTALL_DATA_SEARCH_RATE_LIMIT, 10) || 30 })`，随后才执行参数校验及 `dataApiRequests.track()`。`lib/infra/middleware/rate-limit.js` 的桶按来源 IP 加 scope 建立，默认窗口 60 秒，桶位于进程内；三个平台不会分别获得独立的 `data-search` 桶。同一来源 IP 的其他标准搜索也可能共享这个额度；多实例各自维护桶，不能把单进程的默认值解释为全站的精确总限额。

因此，如果确实在这个中间件被拒绝，请求不会进入该路由的业务跟踪和采购函数。Night-All `data_api_requests` 没有对应行与此路径相容。历史 Hub 标准转发路径也存在未保存 connector call 的证据缺口；**缺少任一侧账本记录，不能单独证明未调用 Night-All 或未调用供应商**。通用 `RATE_LIMITED` 字符串也不足以区分入口、代理和供应商限流，需要有明确的 `night_all_ingress` 元数据或关联日志。

`specs/NIGHT_ALL_DATA_SEARCH_API_V1.md` 声明每来源地址每分钟 30 次的内部基础保护，客户套餐与精确额度另由 Hub 负责。本次保留该 guard、默认阈值、来源 IP 桶及窗口，不通过移除限流、自动加大阈值、拆分来源身份或自动重试来掩盖问题。`NIGHTALL_DATA_SEARCH_RATE_LIMIT` 可以覆盖默认值，但故障时实际覆盖值、代理如何确定 `req.ip`、当时承载的进程及请求总量都需要宿主证据。

本次 Night-All 目标是宿主 **13141**，不是 **18141**。当前 Hub 源码的新 Twitter 标准搜索已走 Hub 直连；YouTube、Reddit 标准内容搜索仍依赖 Night-All。这是当前源码路由，不能用于改写 10 月 13 日的历史执行路径，也不代表现场已经部署当前版本。

## 第一步：在 Admin Pod 只读取 Hub 现存证据

脚本：[diagnose-night-all-search-429.mjs](../../server/ops/diagnose-night-all-search-429.mjs)。它可通过 stdin 传入旧镜像，无需先部署脚本或更改数据库。下面使用仓库已有的 Admin Deployment/容器名称，运行前核对 kube context 和目标环境；本次只提供命令，未执行线上命令。

在 Hub 项目根目录执行：

```bash
kubectl -n mx-insight-hub exec -i deployment/mx-insight-hub-admin -c admin -- \
  node --input-type=module - \
  < server/ops/diagnose-night-all-search-429.mjs
```

默认只查询表中三个 UUID。单独检查一条时：

```bash
kubectl -n mx-insight-hub exec -i deployment/mx-insight-hub-admin -c admin -- \
  node --input-type=module - --request-id 9e20649f-ca22-455e-a9ff-16fe625ab9ad \
  < server/ops/diagnose-night-all-search-429.mjs
```

`--request-id` 可重复，最多 10 个有效 UUID；不接受 SQL、任意过滤条件或任意命令。脚本只加载 `pg` 与 Node 内置 URL 工具，不加载 Hub app、adapter 或配置初始化，不发送任何 HTTP，包括 health 请求。

数据库连接及事务强制只读，使用 repeatable-read、3 秒语句超时、1 秒锁超时及 10 秒空闲事务超时，最终 `ROLLBACK`。仅查询 `usage_requests`、`serving.connector_calls`，以及 `external_platform.provider_calls` 中目标 UUID 是否存在；每个调用证据区最多输出 20 行并标记截断。脚本不读取请求/响应正文、原始归档、搜索词、查询参数或凭据，不打印连接串、hostname、URL 路径和用户信息。Night-All 配置仅展示当前 Admin 环境中的目标端口；它不是历史 Public Pod 配置证据。

输出解读：

- `usage` 是实际保存的请求状态、错误码、HTTP 状态、时间与延迟；保留其历史值，即使旧版本曾将上游 429 映射为 502。
- `connectorCalls` 是已经保存的 Night-All 调用证据。上游 request/trace ID 只输出受限的 UUID、32 位十六进制或 `req_...` 格式；为空也可能表示格式被隐藏，不证明上游没有该标识。
- `rateLimitEvidence` 仅投影已有错误码匹配及限流层、scope、计数、重置时间、重试间隔等白名单字段。旧数据缺失元数据不做补造；只有保存的 `layer=night_all_ingress` 且 `dispatched=false` 才保留这一显式声明。
- `hubProviderDispatchPresence.recorded` 只表示 Hub 自己是否保存关联 provider call。`false` 不代表 Night-All 内部未采购，更不能据此判断费用。
- `state=unsupported_schema` 表示旧库缺表或缺列；`read_unavailable` 表示权限、超时或其他读取失败，`rows=null`。这些状态与成功读取后的空数组不同。脚本不会自动迁移或修改库。
- 成功读取但 UUID 无记录时先核对数据库/环境和保留期限；没有 connector 行时保留证据缺口，不写成“未调用”。

## 第二步：在 13141 对应宿主检查原始日志

先识别监听进程，不假设它由 systemd、Docker、PM2 中哪一个管理：

```bash
sudo ss -ltnp '( sport = :13141 )'
```

由操作人员根据进程归属确认真实服务名、容器或日志文件。不要输出整段 `/proc/.../environ`、argv、`.env` 或 `config.json`；它们可能含密钥。需要核对当前进程的两个设置时，可将 `NIGHT_ALL_PID` 设为已确认的 PID，再仅输出 `PORT` 与 `NIGHTALL_DATA_SEARCH_RATE_LIMIT` 的整数值：

```bash
sudo python3 - "${NIGHT_ALL_PID:?set the confirmed listener PID}" <<'PY'
from pathlib import Path
import json
import sys

pid = sys.argv[1]
if not pid.isdecimal() or int(pid) <= 1:
    raise SystemExit('invalid_pid')
selected = {'PORT': None, 'NIGHTALL_DATA_SEARCH_RATE_LIMIT': None}
try:
    for entry in (Path('/proc') / pid / 'environ').read_bytes().split(b'\0'):
        name, separator, value = entry.partition(b'=')
        key = name.decode('ascii', errors='ignore')
        if separator and key in selected:
            selected[key] = int(value) if value.isdigit() and len(value) <= 9 else 'non_integer_hidden'
except OSError:
    raise SystemExit('process_environment_unavailable')
print(json.dumps(selected))
PY
```

该输出只说明当前进程启动环境；没有值也不能排除运行时配置载入，当前 PID 更不能证明 10 月 13 日使用同一配置。13141 的监听信息比仅查看 `PORT` 更能确认当前服务端口。

确认真实 systemd 单元后，使用 UTC 时间查询。先保留故障前至少 60 秒的窗口，用于检查共享入口压力，重点定位 08:01:40–42；这里的变量必须由操作人员填写，未预设 Night-All 服务名：

```bash
sudo journalctl --utc -u "${NIGHT_ALL_UNIT:?set the confirmed unit name}" \
  --since '2026-10-13 08:00:40 UTC' --until '2026-10-13 08:01:42 UTC' \
  --no-pager -o short-iso-precise
```

若确认为 Docker 容器，则只对已确认的容器读取同一窗口：

```bash
docker logs --timestamps --since '2026-10-13T08:00:40Z' --until '2026-10-13T08:01:42Z' \
  "${NIGHT_ALL_CONTAINER:?set the confirmed container ID}"
```

若为 PM2 或文件日志，应从已确认的进程配置定位实际日志文件，按同一 UTC 窗口或其北京时间等价时间过滤。不要猜路径，不重启进程，不重放搜索。若日志保留不足或进程已替换，标明缺失；可在已确认时钟偏移后适度扩大时间窗口。

重点核对：`POST /api/v1/data/search`、HTTP 429、`RATE_LIMITED`、实际限流层与可用的上游 request/trace ID。Hub UUID 未必就是 Night-All 日志的 request ID，不能只按这三个 Hub UUID 搜索就认定不存在。分享时保留时间、状态、关联 ID 与白名单限流字段，隐藏搜索内容、凭据及整段错误正文。不要用新的付费搜索、换幂等键或重试旧请求来验证日志结论。

## 当前修复与部署边界

本轮 Hub 修改标准 Night-All 转发的证据与错误处理：开始/结束 connector call，保存受限失败证据，保留真实上游 429 而不是统一包装为 502，并传播可验证的 `Retry-After`。没有这些新元数据的历史记录仍保持缺失，已保存的交付、收费与精确幂等重放不重写；`Retry-After` 只是等待提示，不是自动重试或换幂等键的许可。

这次修复解决错误分类、等待提示和证据丢失，不提高入口容量。若历史证据确认正常业务流量确实超过配置额度，应在核对资源与供应商约束后调整 `NIGHTALL_DATA_SEARCH_RATE_LIMIT`，或者由调用方按等待提示控制新请求节奏；不能把“仍会正确返回 429”当作此补丁未生效，也不能把上线此补丁当作容量不足已经解决。

Night-All 修改入口限流响应的元数据与 headers，使新响应可以明确表述入口层、IP 桶、窗口、重置时间及该入口尚未派发的事实；不改变默认 30/60 秒限制和拒绝条件。Hub 侧的 `upstreamLayer` 仅在收到明确入口证据时提供，不能将所有上游 429 都归类为入口限流。

这些是两个项目的独立部署：Hub 要重建并部署包含转发修复的服务版本；Night-All 要按其真实运行方式部署包含响应元数据的版本。只更新 Hub 不会给旧 Night-All 增加缺失 headers，也不会提高其入口容量；只更新 Night-All 不会补齐旧 Hub 的 connector 证据或改变旧错误映射。具体镜像/提交、迁移要求及 rollout 由各项目正常发布流程核对，本次诊断脚本无需迁移。不执行跨项目自动部署，不把本地测试当作线上验证。

本次不改 MX-H2I 登录、用户联网、Launcher SSO、路由、代理或网络配置；不修改供应商价格、账户额度、权限或历史账本。诊断仅读取现有证据，离线测试使用合成数据库响应，没有执行线上命令、Night-All HTTP 或供应商采集。
