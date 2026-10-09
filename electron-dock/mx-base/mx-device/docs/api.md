# API 与 mx-rig 接入

全部管理接口需要独立管理会话 cookie 或 `Authorization: Bearer <admin token>`。测试自动化使用单独 `testToken`，服务端限制为 `mode=sim`。不要把 admin token 交给测试项目，不要把凭证放 URL 或前端存储。POST 需要 JSON，同源检查拒绝带外站 Origin 的写请求。

| 接口 | 作用 |
| --- | --- |
| POST /api/login | `{token}` 换取 HttpOnly、SameSite=Strict 的 12 小时会话 |
| POST /api/logout | 清除当前浏览器会话 cookie |
| GET /api/session | 当前 `admin` / `test` 角色 |
| GET /api/state?mode=sim | 本中心快照；不调用设备 |
| GET /api/jobs/:id?mode=sim | Job、Attempt、检查点、完整结果与迟到证据 |
| POST /api/devices?mode=real | 登记设备；真实设备默认暂停 |
| POST /api/devices/:id/probe?mode=real | `{revision}`；指定 Worker 异步执行一次只读状态查询 |
| POST /api/devices/:id/control?mode=sim | `{revision,action}`；乐观版本校验 |
| POST /api/devices/:id/observer?mode=real | `{revision,origin,serial,approved:true}`；附加只读画面配置，保存不连接手机 |
| POST /api/devices/:id/capture?mode=real | `{}`；提交或合并一次取帧请求，指定 Worker 执行，返回 202 |
| GET /api/devices/:id/frame?mode=real&captureId=UUID | 只读取最新已保存 PNG；需管理认证，no-store，不连接手机 |
| POST /api/devices/:id/session?mode=sim | `acquire/renew/release/takeover/reset`；见下方边界 |
| POST /api/jobs?mode=sim | 幂等提交搜索 / 详情任务 |
| POST /api/jobs/:id/cancel?mode=sim | 仅取消 queued，不取消在途执行 |
| POST /api/scenarios?mode=sim | `{kind:five|priority|failover,key}`；当前演示无活动任务时创建新场景 |
| GET /health/live | API 进程存活，不检查外部设备 |
| GET /health/ready | 本中心数据库可用，不检查 Hub、手机或 mx-rig |

以上 mode 可按权限使用 sim / real，但场景只能 sim，probe 只能 real。没有任意 URL 转发或命令执行 API。

真实设备登记字段：`name, rack, host, workerId, adapter, origin, accountKey, serial, approved:true`。省略 adapter 兼容旧 `legacy-poc`：入口仅允许 `http://127.0.0.1:18081–18180`，serial 可暂缺，每个 `(workerId, origin)` 唯一。`adapter:mobile-agent` 为只读观察：入口仅允许 `http://127.0.0.1:8787–8797`，serial 必填，每个 `(workerId, origin, serial)` 唯一。同一原设备可通过 observer 增加画面配置；不能为同一真实序列号重复建两个适配器设备。账号标识、非空真实序列号跨真实设备唯一。入口不接受路径、凭证、查询、片段或重定向，由指定 Worker 解释 localhost；没有任意网络代理。

画面请求仅调用既有服务 `GET /api/screen.png?device=<serial>`；10 秒超时、6 MiB 上限、PNG 格式/尺寸校验。相同设备的未完成请求合并，完成后至少 2 秒才允许下一请求；20 秒过期的回执不再写入。`captureId` 不是访问凭证。GET frame 只有最新帧，同一帧被替换后返回 404，客户端刷新本中心记录即可。完整 PNG 不进入快照或事件。

控制会话：`acquire` 要求 `{action,revision,confirmed:true}`，暂停后续领取、等待已有任务结束，返回 `{device,token}`；token 仅返回给申请者，在内存保管。`renew/release` 必须携带 token。60 秒未续期保持暂停、不自动重发任务。快照不含 token 或其哈希。`takeover`（revision + confirmed）和 `reset`（token）**只能 sim**，real 服务端返回 403。真实 acquire 只是 `center-only` 预留，并不检查或撤销旧 Mobile-Agent/PoC/ADB 控制权。Mobile-Agent 观察设备禁止 enable、probe 和采集任务。

任务提交：搜索为 `{key,operation:'search',keyword,pages:1..3,priority:1..9,deviceId?}`；详情为 `{key,operation:'note',input:'完整 HTTPS explore 链接',priority,deviceId?}`，也可用 `sourceJobId` 替代 input 来消费已成功搜索的首条链接。真机必须指定 `deviceId` 且 `confirmed:true`。相同 key 与相同规范化参数返回原任务；参数变更返回冲突。

控制动作：`pause` 停止新领取；`enable` 启用（真实需近期 idle probe 与 `confirmedExclusive:true`）；`recover` 隔离恢复（等待旧租约结束、重新取得 idle、`confirmedStopped:true` 与核验说明，恢复后仍暂停）；`disconnect/reconnect` 仅模拟。

## mx-rig

当前不需要部署 mx-rig，也未修改其目录。可复用 `tests/acceptance.mjs` 作为独立 HTTP 验收入口，不假称已经注册成 Rig 的内置验收包。

为未来 Rig 的专用演示目标配置一个秘密文件（不提交 Git）：

```json
{
  "baseUrl": "http://127.0.0.1:18891",
  "testToken": "由 manage.sh test-token 取得的模拟专用凭证"
}
```

命令：`node tests/acceptance.mjs /protected/device-test.json /artifacts/device-report.json`。脚本先检查角色必须是 test，然后执行三个有写入的模拟场景。Rig 套件应声明 `writesData:true`、仅模拟目标、单次重试上限 1、专属实例，完成后读取报告并保留失败证据；不要并发运行两个整套场景。

此脚本采用独立报告格式，不是已验证的 Rig ingest schema；正式注册需要跟随届时 Rig 契约、用例目录、凭证注入与产物规范，不能直接把此 JSON 当作 Rig 标准报告导入。

## 安全与运维边界

- 无账户体系、细粒度 RBAC 或多租户。管理凭证相当于本中心管理员，不应共享给普通业务用户。
- Cookie 使用签名到期时间，退出只清本浏览器，不撤销已复制的会话；凭证泄漏需在停用本中心后轮换 bootstrap secret 并重启本中心 API。不能宣传为完整会话撤销系统。
- 已保存完整结果可能包含 xsec token，默认管理列表与事件投影不带这些字段，证据详情只向相应模式授权角色提供。对数据库备份与完整证据按敏感数据保护。
- 当前不提供自动清历史。配置独立卷监控与备份，设置合理磁盘水位，后续增加可审计保留策略。
- 执行器心跳过期会显示异常；手机不可达只依据显式 probe 或执行结果，不凭心跳推断手机在线。
