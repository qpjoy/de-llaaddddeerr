# MX-H2I 飞书登录、身份与独立 lease 池

> 状态：MX-H2I V2 当前实现说明与生产配置 runbook。
>
> 适用范围：飞书中国版企业自建应用、MX-H2I Electron、Internal User Center、
> Launcher Network。本文不改变 HDO V1，也不把飞书 OAuth 配置放到 Domestic。

## 1. 当前实现结论

MX-H2I 的飞书登录使用 OAuth 2.0 authorization code flow，并采用以下固定边界：

- Electron 主进程先在
  `http://127.0.0.1:17891/oauth/feishu/callback` 启动一次性 loopback listener。
- Electron 为每次登录生成新的密码学随机 `state` 和 `code_verifier`，
  `code_challenge_method` 固定为 `S256`。Internal 还返回单次 `exchangeHandle`，把
  redirect URI 与 S256 challenge 绑定到五分钟有效的服务端事务。
- Internal 根据 App ID、固定 redirect URI、state 和 code challenge 构造飞书 HTTPS
  授权 URL；Electron 只通过系统默认浏览器打开该 URL，不在 Electron `BrowserWindow`
  中承载飞书登录页。
- 飞书把一次性 authorization code 回调给 Electron loopback listener。Electron
  先验证请求方法、固定 path 和 state，再把 code、原 redirect URI 与 PKCE verifier
  以及 `exchangeHandle` 交给 Internal。Internal 只保存 handle 摘要，并在共享 store 中
  持久化事务；token exchange 时先原子删除再校验，因此跨 Pod 也只能消费一次。
- Internal 持有 App Secret，调用飞书 v2 token endpoint，再以飞书
  `user_access_token` 调用 `user_info`；飞书 App Secret、`user_access_token` 和
  `refresh_token` 都不会返回 Electron。
- Internal 只向 Electron 返回 MX User Center token。该 token 带
  `auth_provider=feishu`，Launcher Network 据此选择飞书 lease 池；客户端不能靠请求参数
  把普通员工或匿名 token 提升为飞书身份。
- 登录只用于建立 MX-H2I 身份，不申请 `offline_access`，不保存或刷新飞书
  refresh token。
- 飞书身份以 `tenant_key + open_id` 为稳定外部主键。默认不根据邮箱、手机号或显示名称
  与现有员工账号合并。

这里的 S256 同时用于 MX-H2I 与 Internal 的本地单次交换绑定，以及飞书 authorization
server 的 PKCE 校验。飞书 2026-03-04 的公开文档已声明 authorize 支持
`code_challenge` / `S256`，token exchange 支持 43–128 字符的 `code_verifier`。真实租户
正、负向联调仍是生产上线门禁，详见
[3.7](#37-pkce-上游契约与上线门禁)。

当前没有把 `mx-h2i://` 自定义协议直接配置成飞书 redirect URI。固定 loopback 是实际
回调入口；这避免依赖飞书是否接受 private-use scheme，也避免 Windows、macOS、Linux
三套 deep-link 冷启动行为成为登录前置条件。

## 2. 端到端流程

1. 首次访客 enrollment 会发送客户端生成的 secret lease capability；生产公开 bootstrap
   必须先提供有效 HTTPS，才能建立第一个访客 WireGuard。已有访客连接经 route 与 Internal
   API 探测确认为 ready 后，后续飞书登录可走该 overlay。
2. Electron 绑定 `127.0.0.1:17891`，生成单次 state 和 PKCE verifier。
3. Electron 请求 Internal：

   ```text
   POST /internal/v1/sdk/oauth/feishu/authorize
   ```

4. Internal 只在飞书配置完整、redirect URI 命中服务端 allowlist、tenant allowlist
   非空时返回授权 URL 与不透明 `exchangeHandle`；服务端把 handle 摘要、redirect URI、
   S256 challenge 和过期时间持久化到共享 store。
   Electron 还会在发送任何飞书 code、PKCE verifier 或 MX bearer 前执行传输门禁：只允许
   HTTPS、IP literal loopback，或当前已经通过 WireGuard route + Internal API 探测的
   overlay origin；不会降级到公网明文 HTTP。
5. Electron 校验返回值为 HTTPS URL，再以 `shell.openExternal()` 打开系统浏览器。
6. 用户在飞书同意或拒绝授权。
7. 飞书重定向到固定 loopback：

   ```text
   http://127.0.0.1:17891/oauth/feishu/callback?code=...&state=...
   ```

   拒绝授权时返回：

   ```text
   http://127.0.0.1:17891/oauth/feishu/callback?error=access_denied&state=...
   ```

8. Electron 对 state 做常量时间比较。只有精确匹配的单次回调可以进入 token exchange；
   listener 在收到有效 code、用户取消、五分钟超时或应用退出后关闭。
9. Electron 请求 Internal：

   ```text
   POST /internal/v1/sdk/oauth/feishu/token
   ```

   请求同时携带 code、原 redirect URI、verifier 与 `exchangeHandle`。
10. Internal 原子消费 `exchangeHandle`，校验绑定的 redirect URI 和 S256 verifier 后调用：

    ```text
    POST https://open.feishu.cn/open-apis/authen/v2/oauth/token
    GET  https://open.feishu.cn/open-apis/authen/v1/user_info
    ```

11. Internal 必须先检查 `tenant_key` allowlist，再查找或自动创建
    `tenant_key + open_id` 对应的 Internal user，最后签发 MX token。
12. Launcher Network introspect MX token。只有 `auth_provider=feishu` 才会分配
    `10.89.50.1 - 10.89.99.254`。
13. 浏览器等待、code exchange 以及认证失败、取消或超时都不会主动断开现有访客连接。
    飞书身份验证成功后进入现有的员工网络切换阶段；该阶段会用员工 peer 替换访客 peer，
    若数据面失败则显示失败/降级状态，不能继续把旧访客通道描述成 ready。

飞书 authorization code 的官方有效期为五分钟且只能使用一次。MX-H2I 的本地等待窗口和
Internal exchange transaction 也是五分钟；transaction 无论成功还是校验失败都已被消费。
不能重试同一个 code 或 handle，必须重新发起完整流程。

## 3. 安全边界

### 3.1 Electron 可以持有什么

Electron 主进程只可短时持有：

- 单次 state；
- 单次 PKCE verifier；
- 飞书回调的一次性 code；
- Internal 签发的 MX token。

renderer 只暴露“开始飞书登录”和“取消飞书登录”动作，不获得 App Secret、飞书 token、
PKCE verifier 或回调 code。诊断日志必须继续对 `state`、`code`、`code_verifier`、
authorization header、token、password、secret 和 cookie 做脱敏。

MX-H2I 使用 Electron `safeStorage` 加密持久化 Internal MX token、lease capability 和
WireGuard private key；runtime、H2O runtime 与备份 JSON 均采用临时文件原子替换，并把
临时文件和最终文件权限设为 `0600`。`0600` 只是额外文件权限，不是明文降级方案：

- `safeStorage` 不可用时，不把 MX token、任何 lease capability 或 WireGuard private key
  写入磁盘，也不在下次启动复用它们；
- 已存密文无法解密时，加载流程丢弃 token、capability 与 private key；
- 两种情况都会重置 `installId`、`deviceId`、`ownershipInstanceId` 和 WireGuard key
  身份，下一次连接必须重新登录/重新 enrollment 并生成新身份；
- Linux 只有 `safeStorage` 选择了真实加密后端时才视为可用；`basic_text` 后端按不可用
  处理并走上述 fail-closed 身份轮换；
- 服务端旧 lease/peer 不会因本地身份重置自动消失，运维必须把它们作为 orphan
  盘点并清理。

生产终端必须确保操作系统密钥存储可用。不能为了保持“自动重连”而把上述 secret 回退为
`0600` 明文，宿主机账号或 root 被攻破时仍必须按 bearer/private-key 泄露处置。

### 3.2 Internal 必须持有什么

Internal 是下列飞书配置的唯一运行时 source of truth：

- `MX_FEISHU_APP_ID`；
- `MX_FEISHU_APP_SECRET`；
- `MX_FEISHU_ALLOWED_TENANT_KEYS`；
- redirect URI allowlist。

App ID 是会出现在浏览器授权 URL 中的公开客户端标识，但仍不应在 Electron 内单独硬编码。
App Secret 不能进入 Electron 构建产物、renderer、release metadata、ConfigMap、命令输出
或 Git。飞书 token exchange 和 `user_info` 的响应也只由 Internal 处理；飞书 access token
只用于服务端读取一次 `user_info`，随后丢弃。

### 3.3 固定 loopback 约束

当前生产 redirect URI 必须逐字符保持为：

```text
http://127.0.0.1:17891/oauth/feishu/callback
```

约束如下：

- 只监听 `127.0.0.1`，不能监听 `0.0.0.0`。
- 使用 IP literal，不使用 `localhost`，避免错误解析到非 loopback interface。
- 只接受 `GET` 和固定 path。
- 不支持端口占用时自动切换随机端口；随机端口不在飞书与 Internal 的 redirect allowlist。
- 不给 redirect URI 添加尾部 `/`、query 或 fragment。
- 每次授权只接受当前 in-memory flow 的 state；旧浏览器标签页回调必须失败。
- listener 不常驻，结束或超时后必须关闭。

Electron 支持 `MX_H2I_FEISHU_CALLBACK_PORT` 作为开发诊断覆盖，但正式环境保持默认
`17891`。任何端口变化都必须同时修改飞书后台和 Internal
`MX_FEISHU_REDIRECT_URIS`，否则应 fail closed。

### 3.4 敏感认证传输

即使上游确认支持，PKCE 也只能防止“只截获 authorization code”的攻击，不能保护同时在
明文链路中出现的 code 和 verifier，也不能保护 Internal 返回的七天 MX bearer。因此飞书
authorize、token exchange 和随后绑定 lease 的 bearer 请求必须满足以下任一条件：

- `https://`，并通过正常证书校验；
- `http://127.0.0.1:*` 或 `http://[::1]:*` 的本机开发服务；
- 与当前已验证 WireGuard route 的 Internal overlay origin 完全一致。

`http://h2i.mxinfo-inc.cn:18090` 只可作为迁移期的非敏感诊断入口，不能承载飞书
code/verifier、账号密码、MX bearer 或 lease capability。首次访客 enrollment 已经包含
客户端生成的 `x-mx-new-lease-capability`，在还没有 overlay 可用时只能通过有效 HTTPS
发送；因此“先用公网明文 HTTP 连访客，再走访客 WireGuard 登录飞书”不是生产可用的
bootstrap 方案。loopback HTTP 仅限本机开发。

生产应先为公开 bootstrap 提供并校验证书有效的 HTTPS：首次访客 enrollment 经 HTTPS
完成，访客 WireGuard ready 后，后续敏感请求可以继续走 HTTPS 或已验证的 Internal
overlay。不能通过关闭客户端门禁、去掉 capability 或在 HTTP 中发送 bearer 来绕过该要求。

当前客户端已经对访客、密码员工和飞书三种 enrollment 强制执行这项门禁；密码认证也在
发送账号密码前执行。默认值和精确匹配旧默认
`h2i.mxinfo-inc.cn` 的持久化公网 bootstrap 配置会迁移为
`https://h2i.minsight-ai.com`；不会泛化改写其它 `mxinfo-inc.cn` 内网域名。其它显式配置
的公网 HTTP 不会被静默信任：它会 fail closed，直到运维改成有效 HTTPS。必须先完成公网
TLS 切换，再向终端发布这版客户端。

### 3.5 租户与账号边界

生产环境 `MX_FEISHU_ALLOWED_TENANT_KEYS` 不得为空，也不支持 `*`。为空时飞书能力应报告
未就绪，authorize/token 均拒绝，不允许“先接受任意租户再观察日志”。

用户主键是：

```text
feishu:<tenant_key>:<open_id>
```

其中：

- `open_id` 只在当前飞书应用内稳定；
- `union_id` 用于同一开发主体的多个飞书应用间关联，不是当前单应用主键；
- `user_id` 用于同一租户跨应用关联，但需要额外敏感字段权限，当前登录不依赖它；
- email、mobile、name 都不是唯一且不可变的身份字段。

即使飞书返回的 email 与现有密码员工账号相同，默认也创建或命中独立的飞书外部身份，不
自动合并、不接管原账号 lease。以后若需要账号合并，必须设计显式、双向确认、可审计的
link/unlink 流程。

### 3.6 Internal 运维凭据

User Center 管理、SDK users/roles/service-accounts 管理、Launcher Network 资产盘点与
产品/站点配置以及 `/internal/v1/user-center/tokens/issue` 使用独立 Internal 运维凭据：

- Internal 进程只从 `MX_INTERNAL_OPS_TOKEN` 读取期望值；
- 运维 HTTP 请求通过 `x-mx-ops-token` header 提交；
- 变量未配置时受保护接口 fail closed，错误凭据也不会退化为只依赖网络隔离；
- SDK `client_credentials` 当前把同一个值作为 `client_secret` 校验，它不是任意字符串，
  也不是每个 service account 已经独立轮换的 secret；
- Admin UI 的 `Internal Ops Token` 密码框只保存在当前页面内存中，不写入
  `localStorage`、MX-H2I runtime 或构建产物；刷新/重启后必须重新输入。

该 token 是高权限 bootstrap 凭据，不属于飞书 OAuth token，也不能交给普通 MX-H2I 用户、
写入 renderer 配置、截图、日志、命令输出或 Git。即使 Internal 只在内网提供服务，也要
同时保留网络隔离和这层凭据校验。

### 3.7 PKCE 上游契约与上线门禁

Internal 的 `exchangeHandle + S256` 提供的是可确认的本地安全属性：

- handle 本身是随机不透明值，store 只记录其摘要；
- transaction 绑定 redirect URI 与 S256 challenge，五分钟过期；
- PostgreSQL 下通过 `DELETE ... RETURNING` 原子消费，多个 Pod 不能重复兑换；本地 memory
  store 只用于单进程开发/测试；
- verifier 或 redirect URI 不匹配也会消耗 transaction，防止猜测与重放。

这能阻止没有当前 handle/verifier 的请求借用 Internal exchange API。飞书当前
[浏览器网页接入指南](https://open.feishu.cn/document/sso/web-application-end-user-consent/guide)
已经明确声明 authorize 请求支持 `code_challenge` 与 `code_challenge_method=S256`，
token exchange 支持长度 43–128 的 `code_verifier`。因此当前 loopback callback +
S256 流程符合飞书公开的上游 PKCE 契约，不需要因为旧版文档缺少字段说明而改成 HTTPS
后端 callback；App Secret 仍只保存在 Internal。

生产启用飞书登录前，必须在与生产配置一致的真实飞书租户、应用和 v2 endpoint 完成两项
证据测试：

1. 新建一次授权，使用正确 verifier，确认从授权到 Internal 签发 MX token 全链路成功。
2. 再新建一次独立授权，在隔离的 staging 验证工具中把错误 verifier 实际提交到飞书
   v2 token endpoint，并从上游响应/受控服务端观测确认是飞书拒绝。当前 Internal 会先做
   本地 S256 校验，因此“请求被 Internal 在调用飞书前拒绝”不能作为第二项证据。

验证工具必须运行在服务端受控环境，不记录 App Secret、code 或 token；每次测试使用新的
code。若正确 verifier 失败，或错误 verifier 仍能在上游换票，应视为应用配置、endpoint、
参数编码或飞书租户行为与已发布契约不一致并阻止生产发布。不能删除 verifier、关闭本地
S256 校验，或把 callback 形态变化当成绕过手段；先保留当前固定 loopback callback，核对
authorize/token 参数和应用版本，并向飞书侧确认实际请求证据。

## 4. 三类 MX-H2I lease 池

### 4.1 地址范围与旧池迁移

三类身份共用 MX-H2I 的 `10.89.0.0/16` 产品地址空间，但可分配范围互不重叠：

| 登录来源 | lease profile | 地址范围 | 稳定键 |
| --- | --- | --- | --- |
| 员工账号密码 | `employee` | `10.89.0.1 - 10.89.49.254` | Internal user ID |
| 飞书登录 | `feishu` | `10.89.50.1 - 10.89.99.254` | `tenant_key + open_id` 对应的 Internal user ID |
| 访客 | `anonymous` | `10.89.100.1 - 10.89.254.254` | MX-H2I installation ID |

每个 `/24` 跳过 `.0` 与 `.255`。密码员工池与飞书池各有 12,700 个可用地址。

必须保持以下行为：

- 同一身份续租同一固定 IP。
- 三池分别加锁，分配时对全部 active lease IP 去重；Internal 同时拒绝重叠或倒序的三段
  地址配置，并要求每段完整落在对应的合法 IPv4 CIDR 内。
- 匿名请求不能申请 `feishu` profile。
- 员工与飞书 user lease 都必须携带 active MX user token；只有访客 lease 保持匿名。
- 普通密码员工 token 不能申请 `feishu` profile。
- 飞书 token 即使伪造请求 `employee`，服务端仍以 token introspection 得到的 provider
  选择 `feishu`。
- 从访客发起员工或飞书认证时，等待、拒绝、取消、超时及切换前的控制面失败都保留访客
  runtime。认证成功并开始系统网络切换后会替换本机 peer；commit 后服务端释放被替换的
  访客或员工 lease，abort 后释放新 lease，避免旧 capability 长期存活。

从旧的两池模型升级时，原密码员工可能仍持有 `10.89.50.1 - 10.89.99.254` 内的 active
lease。新服务会拒绝用这种旧 lease 生成 snapshot；员工重新 enrollment 后会得到
`10.89.0.1 - 10.89.49.254` 内的新地址。但数据库记录迁移并不能证明旧客户端已经停止，
也不能自动证明 Domestic/Internal WireGuard 上的旧 peer 已移除：旧 peer 与首批飞书
lease 可能发生同 IP 冲突，单纯按来源 IP 段授权还可能把旧员工误判为飞书身份。

因此不能采用“发布后逐步重连，同时立即开放飞书池”的滚动方式。正式启用飞书登录前必须：

1. 暂停飞书池新分配，并盘点数据库及 Domestic/Internal 实际 WireGuard peer 中所有
   `10.89.50.1 - 10.89.99.254` 地址。
2. 强制旧密码员工升级到携带 MX bearer 的新版客户端并重新连接，确认获得
   `10.89.0.1 - 10.89.49.254`。
3. 对仍在线或残留的旧 peer 执行受控断开/对账清理；不能只改数据库记录。
4. 同时确认数据库 active lease 和真实 WireGuard peer 均不再占用 `.50 - .99` 后，才
   开启飞书可用范围并允许飞书 lease。
5. 迁移窗口内的策略必须绑定已验证的 `auth_provider`/lease profile，不能只凭来源 IP
   判断“飞书用户”。

数据库侧可用受控终端做一次只读盘点；该结果仍需与真实 WireGuard peer 对账：

```bash
curl -fsS "$BASE/internal/v1/launcher-network/leases" \
  -H "x-mx-ops-token: $MX_INTERNAL_OPS_TOKEN" \
  | jq '.leases[] | select(.productId == "mx-h2i" and
      (.leaseIp | test("^10\\.89\\.(5[0-9]|[6-9][0-9])\\.")))'
```

新版 MX-H2I 的密码登录也会把刚取得的 MX token 绑定到 enrollment/snapshot 请求。服务端
默认拒绝旧客户端“只有 userId、没有 Bearer”的员工 lease；如确需分阶段升级，可短时把
`MX_LAUNCHER_NETWORK_LEGACY_UNAUTHENTICATED_USER_LEASES=1`，但该兼容模式无法证明
userId 的请求者身份，必须在旧客户端升级完成后立即恢复为 `0`。

### 4.2 两阶段 peer handover

从访客切到密码员工/飞书身份，或在两种员工身份间切换时，不能先删旧 peer 再假定新数据面
一定成功。MX-H2I 对 Domestic relay 与 Internal direct peer 使用相同的
`prepare -> commit/abort` 合同；旧、新 lease 都必须以各自 capability 授权：

1. 客户端先持久化 `networkHandover`，记录 transition、old/new lease 与当前阶段。
2. `prepare` 暂时把旧、新两个 `/32` 同时写入相关 WireGuard peer 的 AllowedIPs；handover
   记录会持久化当前拓扑实际需要的 peer。默认 relay-only 只等待 Domestic；启用
   H2I direct/hybrid 时才同时等待 Internal direct，不能让不存在的 direct peer 永久卡住。
3. 客户端切换 WireGuard、PAC 与 split DNS，并探测新 route/数据面。
4. 新数据面 ready 后执行 `commit`，只保留新 lease `/32`；预检、授权、本地 apply 或探测
   失败时执行 `abort`，只保留旧 lease `/32` 并恢复旧连接。两端 peer 同步成功后还必须
   release 被淘汰的 lease，并从本机加密 keyring 删除其 capability；release 接口支持用
   原 capability 幂等重试，避免“服务端已释放但响应丢失”把恢复永久卡住。

服务端给同一 product/install/device/public key 的每次 enrollment 分配单调递增
generation。无 handover 参数的 peer sync 只允许当前最高 generation；因此即使旧 lease
尚未清理，旧 capability 也不能把同一 peer 切回旧 IP。同一个 WireGuard public key 在
整个环境的 standalone 产品间也只能由一个产品占用，避免 MX-H2I 与 Luopan 等产品在共享
Domestic peer 上互相覆盖 AllowedIPs。连接成功后客户端还会尝试 release 本机 keyring 中
同 public key 的其它旧 lease，清理手动断开后跨 profile 重连留下的记录。

`preparing`、`prepared`、`commit-pending`、`abort-pending` 会跨重启保留；old/new lease
capability 单独经 `safeStorage` 加密持久化，不暴露给 renderer。启动恢复读取真实
WireGuard interface address：只有新地址存在才 commit，只有旧地址存在才 abort；两者都
存在或都不存在时保持 pending 并要求人工对账，绝不靠缓存的 ready 状态猜测。

服务端同时持久化 handover deadline，默认五分钟；默认每 30 秒扫描过期 transition。
过期后按当前拓扑所需 peer 把 AllowedIPs 恢复为旧 `/32`，两侧确认后把 transition 标为
`aborted` 并释放新 lease。若远端同步失败则保持 `abort-pending` 重试，不能误报完成。
`MX_LAUNCHER_NETWORK_HANDOVER_TTL_MS` 和
`MX_LAUNCHER_NETWORK_HANDOVER_RECONCILE_MS` 可调整，但不能用超长 TTL 替代告警与周期
审计。任何敏感授权仍必须验证 MX 身份/provider/lease 状态，不能只凭来源地址分段授权。

若 `safeStorage` 不可用/密文解密失败导致 capability 缺失，或远端暂时不可达导致同步失败，
自动恢复将无法完成。此时由运维执行受控清理：

1. 从诊断中记录 transition ID、old/new lease ID 与最后阶段，不复制 capability。
2. 同时检查 Launcher Network lease、Domestic relay peer 和 Internal direct peer，确认
   两个 `/32` 的真实 AllowedIPs；不能只看数据库，也不能在不确定当前可用路径时盲删两者。
3. 探测客户端当前使用的 route：新路径可用则按 commit 目标只留新 `/32`，否则按 abort
   目标只留旧 `/32`。优先使用仍有效的 lease capability；缺失时仅由运维凭据授权的管理
   流程或受控 WireGuard 配置对账处理。
4. 确认 Domestic/Internal 与数据库最终只剩所选地址，客户端重新连接和健康探测通过后，
   才清理 pending 记录。残留双 `/32` 必须视为未完成事故，不作为可长期运行状态。

### 4.3 离职、禁用与撤销

当前没有接入飞书离职/用户禁用事件，也没有周期性向飞书复验员工状态。飞书侧离职、移出
应用可用范围或禁用账号不会自动同步到 Internal：已签发的 MX token 最长七天才自然过期，
lease/capability 的有效期为 180 天，WireGuard peer 也不会因飞书状态变化自动撤销，甚至
可能在 TTL 后继续残留到下一次对账/清理。TTL 是过期上限，不是离职撤销机制。

在 Internal 把用户设为 `disabled` 后，后续 token introspection 会因 principal 非 active
而失败，user lease capability 也不能再执行 peer sync/diagnostics（幂等 release 仍允许，
便于安全清理）。但现有 token 记录不等同于已执行独立 revoke，已经安装的数据面 peer
也不会自动删除。发现离职/禁用时必须当天完成：

1. 在 Internal User Center 把 `feishu:<tenant_key>:<open_id>` 对应用户设为
   `disabled`，阻止后续控制面使用与重新签发。
2. 按现有受控 token 撤销/会话失效流程处置该用户全部 MX session；当前没有独立批量 revoke
   接口时，不能把“等待七天”写成完成，应记录该缺口并依赖 disabled introspection gate。
3. 用 `x-mx-ops-token` 授权释放该用户所有 active launcher lease，并同时从 Domestic relay
   与 Internal direct WireGuard peer 移除相应 `/32`；只 release 数据库 lease 不足以证明
   数据面已经断开。
4. 复查 `.50 - .99` 中没有该用户的 active lease、AllowedIPs 或 pending handover，并留存
   审计记录。

后续应接入飞书员工离职/账号禁用/应用可用范围变化事件，并增加周期性状态复验；事件或复验
命中后统一执行 `disable user -> revoke token -> release lease -> remove both peers`，而不是
让四个生命周期各自等待 TTL。

## 5. 飞书开放平台配置

### 5.1 创建应用

1. 登录[飞书开放平台开发者后台](https://open.feishu.cn/)。
2. 在需要使用 MX-H2I 的企业内创建“企业自建应用”。
3. 在“凭证与基础信息”取得 App ID 和 App Secret。
4. App Secret 只交付给 Internal 运维人员，通过 Secret 管理；不要发到聊天、截图或写进
   Electron 配置。

企业自建应用只能给同一企业内人员使用。如果将来需要其他租户的用户登录，应重新评估
商店应用模式，不能通过放宽本地 tenant allowlist 绕过飞书应用类型限制。参见
[应用类型与能力](https://open.feishu.cn/document/platform-overveiw/overview)。

### 5.2 配置重定向 URL

进入应用：

```text
开发配置 -> 安全设置 -> 重定向 URL
```

添加且只使用当前回调：

```text
http://127.0.0.1:17891/oauth/feishu/callback
```

检查 scheme、IP、端口、path 和尾部斜杠。飞书授权请求、Internal allowlist、token exchange
和 Electron listener 四处必须完全一致。飞书的 redirect URI 规则见
[配置重定向 URL](https://open.feishu.cn/document/develop-web-apps/configure-redirect-urls)。

### 5.3 权限最小化

当前登录只需要飞书返回基本身份，并调用 `authen/v1/user_info`：

- 不申请 `offline_access`；
- 不开启 refresh token 能力；
- 不申请邮箱、手机号、员工编号或 `user_id` 字段权限；
- 不申请通讯录、日历、云文档等业务权限；
- 不把 MX token 的 `auth.read`、`network.*` 等 scope 当成飞书 scope。它们是 Internal
  自己的权限。

飞书 `user_info` 接口本身标注为无必需 API scope；敏感字段只有在显式申请相应字段权限后
才返回。参见[获取用户信息](https://open.feishu.cn/document/uAjLw4CM/ukTMukTMukTM/reference/authen-v1/user_info/get)。

若以后确实需要长期代表用户调用飞书 API，必须另行评审 `offline_access`、refresh token
轮转和撤销策略；不能复用当前登录实现静默扩大权限。飞书刷新流程见
[刷新 user_access_token](https://open.feishu.cn/document/uAjLw4CM/ukTMukTMukTM/authentication-management/access-token/refresh-user-access-token)。

### 5.4 可用范围与发布

1. 在版本配置中把应用可用范围设置为允许登录 MX-H2I 的员工或部门。
2. 创建版本并提交发布；企业要求管理员审批时，等待管理员通过。
3. redirect、权限、应用能力或可用范围变化后重新发布，使正式版本生效。
4. 先在测试企业与测试人员完成登录，再同步正式版本。

用户不在应用可用范围内时，飞书 token endpoint 会返回 `20010`。只修改 Internal
allowlist 不能替代飞书后台的应用可用范围。

### 5.5 获取 tenant key

`tenant_key` 是飞书企业的稳定标识，不是应用凭证，因此不会和 App ID、App Secret 一起
显示在“凭证与基础信息”页面。`tenant-keys`（复数）是 MX-H2I Secret 中的 allowlist key；
单企业自建应用通常只写一个飞书 `tenant_key`。

优先在受控测试环境完成一次 OAuth，再从
[`authen/v1/user_info`](https://open.feishu.cn/document/uAjLw4CM/ukTMukTMukTM/reference/authen-v1/authen/user_info)
响应的 `data.tenant_key` 取得；该接口本身不要求额外 API scope。若必须在首次 OAuth 前
取得，可先为应用开通并发布“获取企业信息”权限，再用自建应用 `tenant_access_token` 调用
[`tenant/v2/tenant/query`](https://open.feishu.cn/document/server-docs/tenant-v2/query)，读取
`data.tenant.tenant_key`。第二种方式会增加应用权限，不是当前登录流程的默认要求。

不要把 App ID、`open_id`、企业名称或企业编号当作 tenant key，不要从 Electron 输入或
用户声明中接受 tenant key，也不要配置通配符。飞书对 tenant key 的定义见
[通用参数](https://open.feishu.cn/document/server-docs/api-call-guide/terminology?lang=zh-CN)。

### 5.6 上线协同顺序

飞书管理员与 Internal 运维按下面顺序协同，避免出现“代码已发布但应用未发布”或“Secret
已配但用户不在可用范围”的半完成状态：

| 负责人 | 操作 | 交付/校验 |
| --- | --- | --- |
| 飞书企业管理员 | 创建企业自建应用 | 把 App ID 与 App Secret 通过 Secret Manager 交给 Internal 运维，不通过聊天传递 |
| 飞书应用管理员 | 在安全设置添加 redirect URL | 精确为 `http://127.0.0.1:17891/oauth/feishu/callback` |
| 飞书应用管理员 | 检查权限 | 当前只做身份登录与 `user_info`，不申请 `offline_access`、通讯录、邮箱、手机号等额外权限 |
| 飞书企业管理员 | 设置应用可用范围 | 先只包含测试人员/部门；确认后再扩大，不把 Internal tenant allowlist 当成替代品 |
| 飞书应用管理员 | 创建版本、提交并发布 | 管理员审批完成，正式版本状态已生效 |
| Internal 运维 | 准备 tenant key、`mx-feishu-oauth` 和 `mx-internal-ops` | tenant allowlist 精确非空；两个 Secret 分离 |
| 平台运维 | 为公开 bootstrap 提供有效 HTTPS | 首次 guest/employee enrollment 的 lease capability 不经过公网明文 HTTP |
| 网络运维 | 完成旧 `.50 - .99` 员工 lease/peer 清理 | 数据库与实际 WireGuard peer 均无旧占用 |
| Internal 运维 | deploy/rollout 并检查 safe config | 只确认 configured 状态，不输出任何 Secret |
| 安全/飞书联调 | 执行真实租户 PKCE 兼容测试 | 正确 verifier 成功；错误 verifier 确认由飞书上游拒绝，而非只被 Internal 本地拦截 |
| 测试用户 | 经 HTTPS 建立访客 WireGuard，再执行首个飞书登录 | provider 为 `feishu`，地址落在 `.50 - .99`，同账号重登地址稳定 |

可信 HTTPS bootstrap 也允许用户直接发起飞书登录而跳过“先连访客”，但生产首次 guest
enrollment 本身仍必须使用 HTTPS；默认公网明文 HTTP 既不能传飞书凭据，也不能传初始 lease
capability。扩大飞书可用范围应在上述技术和网络验收全部完成之后进行。

## 6. Internal 环境变量

| 变量 | 必填 | 生产值/默认值 | 说明 |
| --- | --- | --- | --- |
| `MX_FEISHU_APP_ID` | 是 | Secret | 飞书 App ID |
| `MX_FEISHU_APP_SECRET` | 是 | Secret | 只存在 Internal |
| `MX_FEISHU_ALLOWED_TENANT_KEYS` | 是 | Secret，无默认值 | 逗号、分号或换行分隔的精确 tenant key；生产空值 fail closed |
| `MX_FEISHU_REDIRECT_URIS` | 是 | `http://127.0.0.1:17891/oauth/feishu/callback` | Internal redirect allowlist |
| `MX_FEISHU_AUTO_PROVISION_ENABLED` | 否 | `1` | 默认开启；首次飞书登录创建独立 Internal user，关闭时只允许已绑定身份 |
| `MX_FEISHU_AUTHORIZE_URL` | 否 | `https://accounts.feishu.cn/open-apis/authen/v1/authorize` | 正常生产不要覆盖 |
| `MX_FEISHU_TOKEN_URL` | 否 | `https://open.feishu.cn/open-apis/authen/v2/oauth/token` | 正常生产不要覆盖 |
| `MX_FEISHU_USER_INFO_URL` | 否 | `https://open.feishu.cn/open-apis/authen/v1/user_info` | 正常生产不要覆盖 |
| `MX_INTERNAL_OPS_TOKEN` | 是 | Secret，至少 32 字符 | Internal 管理 API、Admin UI 与 SDK `client_credentials` 的 bootstrap 运维凭据 |
| `MX_LAUNCHER_NETWORK_LEGACY_UNAUTHENTICATED_USER_LEASES` | 否 | `0` | 仅供旧密码客户端短期迁移；生产默认关闭 |
| `MX_LAUNCHER_NETWORK_HANDOVER_TTL_MS` | 否 | `300000` | 两阶段 peer handover 的服务端 deadline；过期后自动走 abort 对账 |
| `MX_LAUNCHER_NETWORK_HANDOVER_RECONCILE_MS` | 否 | `30000` | 服务端扫描过期/`abort-pending` handover 的周期 |
| `MX_HTTP_TRUST_PROXY_HOPS` | K8s 是 | `1` | 仅信任紧邻 Internal API 的一跳 Caddy，用真实客户端 IP 做飞书 authorize/exchange 分桶；代理拓扑改变时重新核对，不能盲目增大 |

非 Kubernetes 开发环境可在受保护且不提交 Git 的 runtime env 中设置：

```dotenv
MX_FEISHU_APP_ID=<FEISHU_APP_ID>
MX_FEISHU_APP_SECRET=<FEISHU_APP_SECRET>
MX_FEISHU_ALLOWED_TENANT_KEYS=<TENANT_KEY_1>[,<TENANT_KEY_2>]
MX_FEISHU_REDIRECT_URIS=http://127.0.0.1:17891/oauth/feishu/callback
MX_FEISHU_AUTO_PROVISION_ENABLED=1
MX_INTERNAL_OPS_TOKEN=<RANDOM_SECRET_WITH_AT_LEAST_32_CHARACTERS>
# 只有请求确实经过一跳受控反向代理时才设置：
MX_HTTP_TRUST_PROXY_HOPS=1
```

不要把真实 `.env` 内容复制到 issue、日志或本文。

## 7. Kubernetes 配置

Internal Deployment 从 `mx-internal-shadow/mx-feishu-oauth` 读取：

| Secret key | 注入变量 |
| --- | --- |
| `app-id` | `MX_FEISHU_APP_ID` |
| `app-secret` | `MX_FEISHU_APP_SECRET` |
| `tenant-keys` | `MX_FEISHU_ALLOWED_TENANT_KEYS` |

Internal Deployment 还从独立 Secret `mx-internal-shadow/mx-internal-ops` 的 `token` key
读取 `MX_INTERNAL_OPS_TOKEN`。飞书 App Secret 与平台运维 token 不得合并为同一个 Secret
或同一个值。

以下相对路径命令均从 `electron-dock/mx-launcher` 目录执行。

### 7.1 创建或轮换 Secret

先确保 namespace 存在：

```bash
kubectl apply -f deploy/k8s/internal-shadow/00-namespace.yaml
```

使用占位符执行以下命令；不要把真实值写进文档或 Git：

```bash
kubectl -n mx-internal-shadow create secret generic mx-feishu-oauth \
  --from-literal=app-id='<FEISHU_APP_ID>' \
  --from-literal=app-secret='<FEISHU_APP_SECRET>' \
  --from-literal=tenant-keys='<TENANT_KEY_1>[,<TENANT_KEY_2>]' \
  --dry-run=client -o yaml \
  | kubectl apply -f -
```

真实生产环境优先由现有 Secret Manager/受控终端注入，避免真实值进入 shell history。
Secret 更新后必须重启 Deployment，因为 `valueFrom.secretKeyRef` 只在 Pod 创建时读取。

只检查 key 名，不输出内容：

```bash
kubectl -n mx-internal-shadow get secret mx-feishu-oauth -o json \
  | jq -r '.data | keys[]'
```

期望：

```text
app-id
app-secret
tenant-keys
```

### 7.2 Internal ops Secret 与 Admin UI

`manage.sh` 的 K8s apply/deploy 会在创建 Deployment 前创建或复用
`mx-internal-ops`，顺序如下：

1. 若调用环境显式提供 `MX_INTERNAL_OPS_TOKEN`，使用该值；
2. 否则复用集群中现有 `mx-internal-ops/token`；
3. 两者都不存在时，生成 32 随机字节的 base64url token。

显式值少于 32 字符时部署会停止。无需自定义时不要在 shell history 中手写 token；让脚本
生成并复用即可。需要轮换时，从 Secret Manager/受控环境注入新值后重新 deploy，并确保
Deployment rollout 完成。`k8s down` 会删除该 Secret；下一次无显式值的 deploy 会生成新
token，现有 Admin UI 页面和 service account 集成必须重新取值。

只检查 Secret 是否存在和 key 名：

```bash
kubectl -n mx-internal-shadow get secret mx-internal-ops \
  -o go-template='{{range $key, $_ := .data}}{{$key}}{{"\n"}}{{end}}'
```

需要操作 Admin UI 时，授权运维人员可在受控终端读取一次值，再粘贴到侧栏
`Internal Ops Token` 密码框：

```bash
kubectl -n mx-internal-shadow get secret mx-internal-ops \
  -o go-template='{{index .data "token" | base64decode}}{{"\n"}}'
```

第二条命令会把高权限 token 输出到终端；不要在录屏、共享终端、CI 日志或聊天中执行。
Admin UI 不会持久化该输入，刷新/重启后应重新读取，不能为了方便把值写进浏览器存储。

### 7.3 设置非 Secret 配置

基础 manifest 不包含 tenant allowlist；Secret 不存在或缺少 `tenant-keys` 时保持 fail
closed。这样 `internal-production deploy` 重放 ConfigMap 时不会清空已经持久化在 Secret
中的正式租户配置。固定 redirect URI 与自动建号开关由仓库 ConfigMap 管理，正式环境不
需要部署后的临时 patch。

Secret 或 ConfigMap 变化后重启并等待：

```bash
kubectl -n mx-internal-shadow rollout restart deployment/mx-launcher-internal
kubectl -n mx-internal-shadow rollout status deployment/mx-launcher-internal --timeout=180s
```

如需修改 callback port 或自动建号策略，应提交受管的 production overlay/manifest
变更，而不是部署后手工 patch；飞书后台、Electron 和 Internal redirect allowlist 仍须
同步。

### 7.4 先完成 Domestic 公网 HTTPS

Internal K8s gateway 的 `18090` 是 Internal/WireGuard/LAN 控制面，继续使用私网 HTTP；
不要给它绑定公网证书，也不要把它直接暴露到 Internet。公网 TLS 应由 Domestic 的
official/Compass nginx 443 入口终止，再通过共享 Docker network 反向代理到 Domestic
edge：

```text
https://h2i.minsight-ai.com:443
  -> official/Compass nginx 443 owner
  -> http://mx-domestic-edge:8088
  -> Internal over Domestic WireGuard
```

Domestic site-slot 新产物默认只把诊断/上游 listener 绑定到
`127.0.0.1:18090`，不会抢占 443。基础 compose 不强制依赖外部网络；当
`${MX_DOMESTIC_PUBLIC_GATEWAY_NETWORK:-compass-gateway_default}` 已存在时，
`./manage.sh up` 会自动使用 `docker-compose.public-gateway.yml` 把 `domestic-edge`
持久接入该网络。也可显式执行 `./manage.sh up-public-gateway`，网络不存在时会 fail
closed。先在 Domestic 主机检查 443 owner：

```bash
ss -ltnp | grep ':443 '
```

- 在 official/Compass nginx 增加 `h2i.minsight-ai.com` 的有效证书和独立 vhost，并反代
  到 `http://mx-domestic-edge:8088`。不要停止或覆盖其它既有 listener，也不能把整个
  `/internal/*`、`/api/*` 或 `/h2i/*` namespace 泛反代给 Internal。
- `public-tls` profile 只保留给没有 Compass 的 recovery/dev 环境；production Compass
  主机不得启动它。启用 public-gateway 标记后，`manage.sh` 会拒绝该命令，避免两个服务
  竞争 TCP 443。

official/Compass nginx 必须按 method + path 使用以下最小 allowlist；外层 vhost 与
Domestic edge 内层要同时执行，不能只依赖 Internal controller 鉴权：

```text
GET  /healthz
GET  /bootstrap-healthz
GET  /internal-healthz
GET  /internal/v1/sdk/oauth/feishu/config
GET  /internal/v1/launcher-network/products/<safe-product-id>

POST /internal/v1/sdk/oauth/token
POST /internal/v1/sdk/oauth/feishu/authorize
POST /internal/v1/sdk/oauth/feishu/token
POST /internal/v1/launcher-network/enrollments
POST /internal/v1/launcher-network/snapshots
POST /internal/v1/launcher-network/leases/<safe-lease-id>/release
POST /internal/v1/launcher-network/leases/<safe-lease-id>/domestic-peer/sync
POST /internal/v1/launcher-network/leases/<safe-lease-id>/internal-direct-peer/sync
POST /internal/v1/launcher-network/leases/<safe-lease-id>/domestic-relay/diagnostics
```

`safe-product-id` 和 `safe-lease-id` 只接受 `[A-Za-z0-9._-]+`。其它
`/internal/*`、`/api/*`、`/h2i/*` 请求必须拒绝；特别是 Config Center、Admin、DNS、
User Center、Release Center 管理接口和 product 写接口不能通过公网 bootstrap vhost
访问。site-slot 生成的 `Caddyfile` 与 `Caddyfile.public-tls` 已内置这份 allowlist；把
vhost 配到现有 V1 owner 时必须逐项等价迁移，不能只写一条通用 `proxy_pass`。
公网 443 owner 还必须用 TCP socket 的客户端 IP **覆盖** 外部传入的
`X-Forwarded-For`，不能追加或信任用户自带值；Domestic loopback edge 只把该已清洗值
传给 Internal。当前 K8s `MX_HTTP_TRUST_PROXY_HOPS=1` 只信任紧邻 Internal 的这一跳。
如果代理层数或入口实现改变，必须用伪造 XFF 的负向测试重新校准，否则限速可能被绕过或
把全部终端误合并成一个来源。

公网 `/internal/v1/sdk/oauth/token` 只兼容 password grant。Internal 会在执行密码哈希前，
用 PostgreSQL 原子消费 5 分钟固定窗口的来源 IP、canonical user、IP+user 三类哈希 bucket
（限额分别为 60、25、10）；账号不存在、被禁用或密码错误统一返回
`invalid credentials`，超限统一返回 `429`。原始 IP、账号和密码不存入 limiter state。
`client_credentials` 仍复用同一路径，但只允许 Internal 控制面调用；经
`domestic-edge` 的请求会在比较 `MX_INTERNAL_OPS_TOKEN` 前拒绝，避免把平台 bootstrap
运维凭据暴露为公网撞库目标。

无论谁拥有 443，都必须以原域名校验证书、SNI 和 Host。Host Resolve/直连 IP 只是把拨号
地址固定到 Domestic IP，客户端仍保留 `h2i.minsight-ai.com` 的 TLS SNI 与 HTTP Host，
不能改成 `https://<IP>` 后跳过证书校验：

```bash
curl --resolve h2i.minsight-ai.com:443:<DOMESTIC_PUBLIC_IP> \
  https://h2i.minsight-ai.com/bootstrap-healthz
```

该命令必须在不使用 `-k` 的情况下通过。Internal runtime apply 也会访问真实
`https://h2i.minsight-ai.com/bootstrap-healthz` 并用系统信任链复检；失败时 apply 保持
failed。下面的 `internal-production deploy` 只部署 Internal，不能替代这一步。

### 7.5 部署

按 Internal production 原有部署入口执行：

```bash
TMPDIR=/data/tmp \
MX_K8S_OS_HOSTNAME=mx-internal-server \
MX_K8S_APISERVER_ADVERTISE_ADDRESS=192.168.1.2 \
MX_SHADOW_BUILDKIT_KEEP_STORAGE=2GB \
MX_SHADOW_BUILDKIT_PRUNE_UNTIL=24h \
bash scripts/manage.sh ops internal-production deploy
```

若 Secret 或 ConfigMap 是在 deploy 之后更新的，再执行上一节的 rollout restart。

### 7.6 不泄露 Secret 的检查

```bash
kubectl -n mx-internal-shadow get deploy mx-launcher-internal
kubectl -n mx-internal-shadow get pods -l app.kubernetes.io/name=mx-launcher-internal
kubectl -n mx-internal-shadow logs deploy/mx-launcher-internal --tail=200
```

不要用会输出 env 值的命令检查 App Secret。可以 port-forward safe config endpoint：

```bash
kubectl -n mx-internal-shadow port-forward svc/mx-launcher-internal 18090:18090
```

另一个终端：

```bash
curl -fsS http://127.0.0.1:18090/internal/v1/sdk/oauth/feishu/config | jq
```

该接口只能报告是否 enabled/configured、redirect URI 等非敏感状态，不能返回 App Secret 或
飞书 token。生产期望为配置就绪、固定 redirect URI 存在、tenant allowlist 非空。

## 8. 验收清单

### 8.1 静态与服务端

- `mx-feishu-oauth` 包含 `app-id`、`app-secret`、`tenant-keys` 三个 key。
- `mx-internal-ops` 存在且只包含预期的 `token` key；受保护 API 缺少/错误
  `x-mx-ops-token` 时被拒绝。
- Internal Pod 已因 Secret/ConfigMap 变化重新创建。
- K8s Caddy 到 Internal API 的代理跳数为一，`MX_HTTP_TRUST_PROXY_HOPS=1`；至少用两个
  客户端确认飞书限流按原始客户端 IP 分桶，而不是把所有请求归到 Caddy Pod。
- safe config endpoint 报告飞书已配置。
- 生产公开 bootstrap 已提供证书校验正常的 HTTPS；首次 guest enrollment 的
  `x-mx-new-lease-capability` 不经过公网明文 HTTP。没有 HTTPS 时不得用“先连访客”绕过。
- redirect URI 精确为固定 loopback，没有尾部 `/`。
- tenant allowlist 只包含预期企业，不为空、不含通配符。
- authorize transaction 写入共享 store、只保存 handle 摘要，过期与原子单次消费已在
  多 Pod/PostgreSQL 环境验证。
- 真实飞书租户已证明正确 verifier 成功、错误 verifier 由飞书 v2 上游拒绝；若没有这项
  证据，发布记录必须标注“飞书 PKCE 生产联调未验收”，不能把文档支持等同于现场成功。
- `MX_LAUNCHER_NETWORK_LEGACY_UNAUTHENTICATED_USER_LEASES=0`，员工地址池不能靠伪造
  userId 获取。
- 未申请 `offline_access`，Internal 不持久化 refresh token。
- 升级自旧两池模型时，数据库和真实 WireGuard peer 的 `.50 - .99` 旧员工占用都已清零，
  且没有仅按来源 IP 段授权飞书能力。
- MX-H2I runtime 文件权限为 `0600`；`safeStorage` 不可用或解密失败时，磁盘与内存恢复
  结果均不复用 MX token、lease capability 或 WireGuard private key，并重置
  installation/device/key 身份，没有 `0600` 明文 fallback。
- crash-after-prepare 测试按真实 WireGuard interface address 覆盖 commit 与 abort；
  地址歧义或缺 capability 时保持 pending/降级，不误报 ready；服务端 deadline reconciler
  另覆盖终端永不重启时的自动 abort 与 `abort-pending` 重试。
- handover commit/abort 后被淘汰 lease 已 release、旧 capability 已移出本地 keyring；
  release 响应丢失后重试仍幂等成功，旧 generation 不能再 single sync 抢回 peer。
- 完成离职演练：Internal user disabled、session 失效处置、lease release，以及
  Domestic/Internal 两侧 peer 清理都可审计；没有把七天/180 天 TTL 当成自动撤销。
- Launcher Network 三池 smoke 通过：

  ```bash
  pnpm --dir electron-dock/mx-launcher/server run smoke:feishu-network
  ```

### 8.2 Electron 正常路径

1. 通过有效 HTTPS bootstrap 首次连接访客模式，确认当前 IP 属于
   `10.89.100.1 - 10.89.254.254`。
2. 点击“飞书登录”。
3. 系统默认浏览器打开 `https://accounts.feishu.cn/` 下的授权页。
4. 完成授权后，浏览器显示 MX-H2I 飞书授权完成页面。
5. MX-H2I 自动进入员工模式，provider 为 `feishu`。
6. 新 IP 属于 `10.89.50.1 - 10.89.99.254`。
7. 浏览器等待与 Internal 身份交换期间访客网络保持；身份验证成功后界面明确进入系统网络
   切换阶段，不承诺已被替换的访客 peer 仍然 ready。
8. 断开并以同一飞书账号重登，得到同一个飞书 IP。
9. 密码员工登录仍得到 `10.89.0.1 - 10.89.49.254`。

### 8.3 失败与边界路径

- 用户在飞书拒绝授权：提示取消，现有访客连接保持。
- 在 MX-H2I 点击取消：loopback listener 关闭，访客连接保持。
- 五分钟内未完成：本地 flow 超时，旧回调不能再使用。
- 修改 callback state：返回校验失败，不请求 Internal token endpoint。
- 重放相同 `exchangeHandle`：Internal 在调用飞书前拒绝；重放已换票的 code：飞书拒绝。
- 用错误 verifier 调 Internal：本地 transaction 被消费并拒绝；另用 fresh code 的受控
  staging 测试确认错误 verifier 也确实被飞书上游拒绝，不能把本地拒绝混作上游证据。
- 使用不在 allowlist 的企业账号：Internal 拒绝，不创建 user、不分配 lease。
- 使用不在飞书应用可用范围的账号：飞书返回无应用使用权限。
- 让其他进程占用 17891：MX-H2I 明确报启动失败，不切随机端口。
- 飞书认证成功但网络 apply 失败：按原有模式切换合同回滚/保留可用连接，不能错误显示 ready。
- 在 `prepare` 后强制退出并再次启动：按新 route 探测结果 commit 或 abort；远端失败时
  保留 `commit-pending`/`abort-pending`。再覆盖“终端不再启动”的运维审计，不能宣称仅靠
  客户端恢复就绝不会留下双 `/32`。
- 模拟 `safeStorage` 不可用和密文损坏：不恢复 token/capability/private key，重置
  installation/device/key 身份，并触发重新登录/enrollment 与 orphan peer 运维清理。
- 同一邮箱分别使用密码和飞书登录：两种身份与 lease 保持独立。
- 日志与诊断包中搜索 `code_verifier`、authorization code、Bearer token 和 App Secret，
  不得出现原值。

检查 loopback 占用：

```bash
lsof -nP -iTCP:17891 -sTCP:LISTEN
```

登录开始前和流程结束后应无常驻 listener；等待授权期间 owner 应为 MX-H2I。

## 9. 故障排查

| 现象 | 常见原因 | 处理 |
| --- | --- | --- |
| safe config 显示未就绪 | App ID/Secret 缺失、tenant allowlist 为空、redirect allowlist 缺失 | 检查 Secret key 名、ConfigMap 与 Pod rollout；不要输出 Secret 值 |
| 首次 guest/密码登录提示 insecure bootstrap | 仍在使用显式公网 HTTP，或旧 Domestic 443 尚未配置 h2i 证书/vhost | 先完成 7.4 的 HTTPS 入口；不要关闭客户端门禁、使用 `-k` 或把 capability/bearer 改回明文 |
| `redirect_uri unmatch` 或 token `20071` | 飞书后台、authorize、token exchange、Electron 四处 URI 不一致 | 精确比较 scheme、`127.0.0.1`、`17891`、path 和尾部斜杠 |
| 本地报 `EADDRINUSE` | 17891 被其他进程占用或上次异常实例未退出 | 用 `lsof` 找 owner，结束冲突进程后重新发起；不改随机端口 |
| state 校验失败 | 旧标签页、并发登录、伪造回调或应用已重启 | 关闭旧页面，从 MX-H2I 重新开始完整登录 |
| Internal 报 transaction missing/mismatch | handle 已用/过期，或 redirect/verifier 不匹配；失败校验也会原子消费 | 不重试旧 handle/code，从 MX-H2I 新建完整授权；检查共享 store 与多 Pod 时钟 |
| 飞书 `20003`、`20004`、`20065` | code 无效、超过五分钟或已使用 | 重新授权；不要重试原 code |
| 飞书 `20002` | App ID 与 App Secret 不匹配 | 轮换/修正 Kubernetes Secret 并 rollout |
| 飞书 `20010` | 用户不在应用使用范围或版本未发布 | 修改飞书后台可用范围，重新发布并等待管理员审批 |
| 正确 verifier 成功，但错误 verifier 也被飞书上游接受 | challenge/verifier、endpoint、应用版本或受控验证工具与当前飞书 PKCE 契约不一致 | 停止生产发布，保留 loopback callback 与 S256；核对上游原始请求/响应并向飞书侧确认，不能删除 verifier 绕过 |
| 飞书授权后 Internal 拒绝 tenant | `tenant_key` 不在精确 allowlist | 核对正式企业 tenant key；禁止临时设通配符 |
| `user_info` 返回 token 无效 | token exchange 失败、错误环境/应用混用或 token 已失效 | 检查 Feishu/飞书域名品牌、App ID、服务端网络与一次性 exchange |
| 授权成功但未拿到飞书池 IP | MX token 未带 `auth_provider=feishu`，或 lease 请求未携带 MX token | 检查 Internal token introspection 和 Launcher Network 日志 |
| 等待飞书授权时访客掉线 | OAuth 阶段错误修改了网络 runtime | 按网络切换 runbook 排查；只有身份验证成功并进入系统网络切换后才应替换访客 peer |
| 重启后提示 handover capability 缺失 | `safeStorage` 不可用/解密失败，或本地 secret 已被清理 | 保持 pending/降级；按 4.2 同时对账 Domestic/Internal 的 old/new `/32`，选择 commit 或 abort 后再重连 |
| 重启后要求重新 enrollment | `safeStorage` 不可用或持久化密文无法解密 | 这是 fail-closed，不启用明文 fallback；重建 installation/device/key，并清理旧 orphan lease/peer |
| Internal 无法访问飞书 | DNS、出口、防火墙或证书链问题 | 从 Internal Pod 检查 `accounts.feishu.cn`、`open.feishu.cn` 的 DNS/HTTPS 出口 |

飞书中国版必须配套使用：

```text
accounts.feishu.cn
open.feishu.cn
```

不要把 Lark 国际版的 `accounts.larksuite.com` / `open.larksuite.com` 与飞书 App ID 混用。

## 10. 官方依据

- [飞书：浏览器网页接入指南](https://open.feishu.cn/document/sso/web-application-end-user-consent/guide)
- [飞书：获取 user_access_token](https://open.feishu.cn/document/uAjLw4CM/ukTMukTMukTM/authentication-management/access-token/get-user-access-token)
- [飞书：获取用户信息](https://open.feishu.cn/document/uAjLw4CM/ukTMukTMukTM/reference/authen-v1/user_info/get)
- [飞书：配置重定向 URL](https://open.feishu.cn/document/develop-web-apps/configure-redirect-urls)
- [飞书：获取访问凭证](https://open.feishu.cn/document/ukTMukTMukTM/uMTNz4yM1MjLzUzM)
- [飞书：用户资源与 open_id、union_id、user_id](https://open.feishu.cn/document/server-docs/contact-v3/user/field-overview)
- [Electron：shell.openExternal](https://www.electronjs.org/docs/latest/api/shell)
- [Electron：安全指南](https://www.electronjs.org/docs/latest/tutorial/security)
- [IETF RFC 8252：OAuth 2.0 for Native Apps](https://www.rfc-editor.org/rfc/rfc8252.html)

飞书当前 v2 token API 仍要求服务端提交 App Secret，因此 App Secret 必须留在 Internal，
不能放进 Electron。公开指南已声明 authorize 的 `code_challenge` / `S256` 与 token 的
43–128 字符 `code_verifier`；当前实现同时保留 Internal 的一次性交换绑定。生产仍须用真实
租户证明正确 verifier 成功、错误 verifier 被上游拒绝，避免把“文档支持”误当成部署现场
已经验收。
