# Luopan 登录保留设备地址，密码认证取消按 IP 限额（2026-10-23）

状态：代码与测试已完成，未提交、未部署。承接 [53](./53-luopan-login-and-domestic-capacity-review-2026-10-22.md)–[55](./55-luopan-client-optimization-with-mx-h2i-2026-10-23.md) 以及罗盘仓库的 `po-frontend/docs/login-startup-reuse-20261023.md`。

## 1. 背景

- Windows 实测首次启动 15.65 秒，其中本机应用隧道配置 12.4 秒；租约、节点同步等服务端步骤合计约 2 秒。
- 罗盘的匿名租约和员工租约分配自不同地址段（员工 `10.91.0.1–10.91.49.254`，匿名从 `10.91.100.1` 开始）。登录后地址必然改变，客户端只能重新配置隧道：Windows 弹 UAC，macOS 要输管理员密码，再花十几秒。
- 退出后不勾选“记住账号”再打开，又会从员工地址切回匿名地址，再重建一次。
- 密码认证按来源 IP 计数（5 分钟 60 次）。办公室和客户单位共用一个出口，所有账号共享这个额度；MX-H2I 也走同一个公网入口。

## 2. 密码认证不再按来源 IP 计数

`modules/sdk-gateway/sdk-gateway.controller.ts`：

| 场景 | 改前 | 改后 |
| --- | --- | --- |
| 用户密码登录 `grant_type=password` | 每 IP 60、每账号 25、每 IP+账号 10（5 分钟） | 去掉每 IP 60；保留每账号 25、每 IP+账号 10 |
| 修改自己的密码 | 同上 | 同上 |
| 服务账号 `client_credentials` | 每 IP 30 | 不变 |
| 飞书 authorize / exchange | 每 IP 每分钟 60 / 30 | 不变（authorize 没有账号可计数，去掉后无任何上限） |
| Admin 控制台 SSO | 每 IP 30、每账号 5 | 不变（只有管理员使用） |

代价：从同一个 IP 轮换大量账号尝试密码（撞库）不再被按 IP 截停，每个账号仍各自受限。`sdk-gateway-rate-limit.test.ts` 原来锁定“同一 IP 轮换账号会被限流”，现改为锁定“同一出口的不同账号互不影响，账号自身仍受限”。

## 3. 罗盘一台设备一个地址

### 规则

同一产品、同一安装、同一设备、同一 WireGuard 公钥上的租约共用一个 overlay 地址。身份变化时（匿名→员工、员工→匿名、换另一个员工），新身份的租约接过这台设备最新那条租约的地址，那条租约在同一次写入中释放。

客户端的隧道配置只由地址、密钥和对端决定。地址不变，配置就不变，所以登录和退出都不需要重新配置隧道，也不弹授权。

### 实现

| 位置 | 改动 |
| --- | --- |
| `store/domain.ts` | `LAUNCHER_DEVICE_ADDRESS_PRODUCT_IDS = {'luopan'}`，内置名单，不加配置项。`launcherNetworkLeaseAddressCarryOver` 判断是否接过地址：来源必须有效、同安装同设备同公钥、比被续租的租约更新、仍符合它自己的地址段，且地址落在新档位的 CIDR 内。`launcherNetworkLeaseMatchesProfile` 按租约的 `addressProfile`（地址实际来自的地址段）核对“段起点 + 序号 = 地址”。`buildLauncherNetworkLease` 接受接过的地址 |
| `types.ts` | 租约新增可选 `addressProfile`（只有地址来自其他档位的地址段时才写）；登记输入新增服务端内部字段 `addressSourceLeaseId`，不读取请求体 |
| `modules/launcher-network/launcher-network.controller.ts` | 只对名单内的产品计算来源：同产品、同安装、同设备、同公钥，且请求出示了其 capability 的有效租约中，代次（generation）最新的一条 |
| `store/postgres.ts`、`store/memory.ts` | 在原有事务内接过地址并释放来源租约，保证同一时刻只有一条有效租约持有该地址；审计元数据增加 `addressFromLeaseId` |

### 保持不变

- **MX-H2I**：不在名单内。guest 与 employee 两条租约先建后拆的交接流程不变，有测试锁定。
- **产品地址段配置**：不改，三个档位不重叠的校验不变；“段起点 + 序号 = 地址”的完整性校验不变，只是按地址实际来自的地址段核对。
- **Domestic、Internal 对端同步**：仍按公钥加 `/32` 地址同步，地址相同时就是原值重写。已释放的租约不能再同步对端（测试覆盖）。
- **匿名准入策略**：匿名关闭或排空（drain）时，接过地址的新匿名租约同样会被拒绝。

### 场景

| 场景 | 改前 | 改后 |
| --- | --- | --- |
| 启动（匿名）后输入密码登录 | 新员工地址，重建隧道并弹授权 | 沿用匿名地址，客户端复用隧道 |
| 记住账号重新打开 | 续租同一员工租约 | 不变 |
| 不记住账号重新打开 | 新匿名地址，重建 | 沿用上次的地址，复用 |
| 同一台电脑换另一个员工登录 | 新地址，重建 | 沿用地址，复用 |
| 升级前留下的“员工租约 + 有效匿名租约”并存 | — | 员工租约续租后搬到设备正在运行的地址，匿名租约释放 |

## 4. 罗盘客户端配合

- `po-frontend/src-electron/luopan-launcher-manager.ts` 的隧道复用键由 `租约ID|地址` 改为 `luopan|地址`。租约 ID 随身份变化，只要它还在复用键里，地址保留了也无法复用。
- 与 MX-H2I 一致，罗盘启动不再申请匿名租约。点击登录时：
  - 未建隧道就经 `https://h2i.minsight-ai.com` 完成 MX 密码认证、用户租约和节点同步；
  - 只做一次隧道应用；
  - 密码、令牌和租约凭据不再走明文 `http://116.62.51.154:18090`。
- 因此罗盘的密码认证从隧道内移到公网入口，第 2 节去掉按 IP 限额是这一步的前提：**必须先部署服务端，再发客户端**。
- 已核对这个 HTTPS 入口：`/bootstrap-healthz` 返回 200；空请求访问 `/internal/v1/sdk/oauth/token` 和 `/internal/v1/launcher-network/enrollments` 都由应用层拒绝（401 和 403），没有产生记录。

## 5. 部署顺序与验证

1. **先部署 Launcher 服务端**（维护窗口，在 Internal 以 root 执行，参数见 [mx-launcher.deploy.md](../mx-launcher.deploy.md) 第 5 节）：

   ```bash
   bash scripts/manage.sh ops internal-production deploy
   ```

   旧版罗盘客户端也会拿到保留的地址，但它的复用键含租约 ID，仍会像以前一样重建，不会更差。

2. **验证服务端**：用一台罗盘客户端启动并登录，在 ops 租约列表里确认：
   - 员工租约的地址等于登录前的匿名地址（`10.91.100.x`），租约记录带 `addressProfile: anonymous`；
   - 匿名租约变为 `released`；
   - 审计 `launcher_network.lease.enrolled` 或 `refreshed` 的元数据有 `addressFromLeaseId`。

3. **再发罗盘新版客户端**。升级后第一次启动会因为复用键格式变化重建一次，之后：
   - 登录日志出现 `windows-reuse-cache-matched` 和 `windows-service-reused`（macOS 为 `darwin-…`），不弹 UAC 或管理员密码；
   - `user-network` 总耗时约 2 秒（租约、节点同步、复用检查和健康检查）。

4. **MX-H2I 回归**：员工密码登录、飞书登录、guest 联网都与改前一致；guest 与 employee 仍是两条租约。

## 6. 回退

- 回退服务端提交并重新部署。已经保留地址的罗盘员工租约，在旧代码下会因地址不在员工段而被当作档位不符，按原有替换流程重新分配，客户端重建一次，不会失联。
- 只回退限流：恢复 `PASSWORD_SOURCE_ATTEMPT_LIMIT` 及两处 `sourceLimit`，并恢复对应测试。

## 7. 验证记录（开发机）

- 新增 `lease-address-carry-over.test.ts` 3 项：
  - 罗盘的完整循环：匿名→登录→记住账号→退出→换人，地址不变、只有一条有效租约、快照带该地址、对端同步通过、已释放租约被拒；
  - 升级前遗留的双租约收敛到同一地址；
  - MX-H2I 仍是两条独立租约。
- `launcher-network/*.test.ts` 与 SDK 认证测试组共 108 项，107 项通过；`oversea-site-archive.test.ts` 的 Postgres 源码断言在未修改的 HEAD 上同样失败，与本次无关。
- `npm run typecheck`（含测试）与 `npm run build` 通过。
