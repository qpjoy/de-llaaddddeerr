# ADR-0005：复用 Launcher 联邦身份，Runner 使用 run 作用域短期 token

状态：已接受（2026-08-12）

## 背景

MXT 有三类调用方，威胁模型完全不同：

- **人**（Admin UI）：需要组织身份、权限、审计。
- **系统**（CI、release-center、launcher server 转发）：需要长期服务凭据。
- **Runner**：在真实 worker 上执行**第三方应用仓库的代码**，是三者中唯一不可信的。

## 决策

**人**：复用 MX Launcher 的用户身份，通过 introspection 校验其不透明 token
（`mx-v1-...`），与 `mx-insight-hub` 的做法一致（见其 ADR-0004）。
MXT 不持有人的口令、不建用户表、不与 Launcher 共库。
MXT 侧只维护本地授权记录：某 principal 对某 app 有 `viewer` / `operator` / `admin`。

**系统**：服务 admin token，作用域按 app + 操作类型限定。

**Runner**：两级 token。

| token | 生命周期 | 能做什么 |
| --- | --- | --- |
| runner token | 长期，注册时签发 | 只能 `claim`、`register`、心跳 |
| run token | 单个 run，随 run 终结立即失效 | 只能读写 `:runId` 自己的 step / 产物 / complete |

runner token **不能**读写任何 run 的数据；run token **不能** claim 新 run。

**被测应用的凭据**（测试账号密码）存平台密钥库，只在 claim 响应里出现一次，
注入进程环境，不落盘、不进日志、不进产物、不进 summary。

## 理由

**为什么 runner 要单独设计。** runner 执行的是被测应用仓库里的代码。
即使那是自家仓库，也可能被 Agent 生成的代码、被误提交的调试语句、被依赖链
影响。假设 runner 上的进程可以读到它进程内的一切，那么：

- 给 runner 一个能访问全部 run 的 token → 一次污染泄露全部测试历史与产物
- 给 runner 长期有效的 token → 泄露后无法自愈

run 作用域 + 自动过期把爆炸半径压到"这一次执行"。

**为什么不给 runner 直接写库的权限。** 同上，且 runner 提交的数据必须经过平台的
归一与二次脱敏（[05](../05-tracks-and-artifacts.md)）。直连数据库会绕过这道处理。

**为什么复用 Launcher 身份而不自建。** 自建意味着又一套口令、又一套 MFA、
又一份用户表。Launcher 已经是组织身份权威，测试平台没有理由成为第二个。
这也让人员离职时的权限回收只需要在一处操作。

**为什么不用 gateway header 当身份。** 与 insight-hub ADR-0004 同理：
网关准入不等于授权。MXT 必须自己校验 token 并检查本地授权记录，
否则一个宽泛的 Launcher 角色就能绕过 MXT 的 app 级权限。

## 后果

- MXT 依赖 Launcher 的 introspection 接口。**但只依赖于人的登录**：
  Launcher 不可用时，服务 token 与 runner token 仍能工作，已排队的 run 继续执行。
  这是必须保持的降级路径。
- introspection 每次请求一次网络调用，用短 TTL 缓存（30s）压成本。
  缓存 key 是 token 的 hash，不是 token 本身。
- run token 的失效需要在 run 终结时立即生效，不能等自然过期——否则 runner
  崩溃重启后还能继续写已完成的 run。
- Launcher 若将来改为签名 JWT/JWKS，需要新的契约，不在本 ADR 范围。

## 被否决的方案

- **MXT 自建用户体系**：重复实现身份，分裂组织登录，增加离职回收的遗漏面。
- **Runner 用统一长期 token**：泄露即全量泄露，且无法自愈。
- **Runner 直连数据库**：绕过归一与二次脱敏，且授予的权限远超需要。
- **平台存 session/token 而非账号凭据**：会话会过期，导致"测试因为登录态过期而红"
  这种与产品无关的噪声——compass 现在的 `.auth-session.json` 就是这个问题。
