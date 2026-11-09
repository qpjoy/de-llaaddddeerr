# 采集引擎上线手册（阶段 1–6）

用这份手册把 [spider_man 06/07](../architecture/spider_man/07-collect-engines.md) 里阶段 1–6 的改动发布到 Internal，并逐项验收。日常的 Hub 部署和重启仍以 [`mx-insight.deploy.md`](../../mx-insight.deploy.md) 为准，本手册只补充采集引擎相关的步骤。

写于 2026-11-09，对应的代码尚未提交。本手册里的命令都没有在 Internal 上执行过；本机预演的结果见第 9 节。

## 1. 这次上线包含什么，不包含什么

| 部分 | 内容 | 发布方式 |
|---|---|---|
| Hub | schema `collect`（migration 183）；出口绑定 apify、shodan、googleplay、overseas（migration 184–187）；`/api/v1/data/collect/*`；管理台「自建引擎」页 | 正常的 Hub deploy |
| mx-crawler-runner | 单独一个 Deployment，在 `mx-insight-hub` 命名空间、Hub 节点上运行，只监听 `127.0.0.1:18190` | `mx-base/mx-crawler-runner/scripts/deploy.sh` |
| 引擎与验收 | 21 个标准引擎、runner token、探测、启用、逐项联网验收 | `scripts/collect-acceptance.mjs` |

上线不会改变下面这些东西，每一步之后都应该保持原样：

- **MX-H2I**：不改 Launcher、WireGuard、split DNS 和登录路径。runner 不在 Hub 的 kustomization 里，Hub 部署也不会动它。
- **System Proxy**：TikHub 等已有供应商的绑定不变，migration 只新增 `apify`、`shodan`、`googleplay`、`overseas` 四行。
- **原微信自建引擎**：表和代码都不变。
- **对外 Key**：所有采集能力都是 `candidate`，不会自动授给 `managed_full`（LCY-delta 等）Key。新建的引擎默认停用、不计费；不建引擎时，接口对这些能力只返回 `capability_not_routed`。

## 2. 前置条件

1. **代码**：
   - 本地提交整个仓库（Hub、`mx-base/mx-crawler-runner`、`mx-common` 和 `.claude` 以外的改动），服务器拉取。
   - runner 的交付包和上游库（`packages/`、`upstream/`，约 2,000 个文件）必须完整拉到。拉取后在 runner 目录执行 `node scripts/lock-packages.mjs`，应输出 23 行 `ok`，否则不要继续。
2. **身份和工具**：在 Hub 节点上用 root 执行；需要 Node ≥ 22.18、Docker（带 buildx）、ctr、kubectl、openssl、curl。
3. **构建网络**：
   - Hub deploy 照常带 `MX_INSIGHT_BUILD_PROXY=http://127.0.0.1:7788`。它会创建一个只走代理的 buildx builder，runner 的构建会复用同一个 builder（按名称 `mx-insight-buildproxy-<哈希>`）。
   - 所以先部署 Hub，再部署 runner，两次的代理地址要相同。
   - 如果设置过 `MX_INSIGHT_BUILDX_BUILDER`，runner 找不到这个 builder，构建时会明确报错。
4. **磁盘**：
   - runner 镜像约 0.7 GB；构建缓存另需 1–2 GB。
   - 运行记录写在宿主机 `/var/lib/mx-crawler-runner`（根盘），只保留 24 小时。
5. **时间**：
   - Hub deploy 和平时一样，会短暂冻结 Admin 写入。
   - runner 镜像首次构建约 5–10 分钟：要装 18 个包，每个包还要跑一遍离线测试。

## 3. 第一步：发布 Hub（含 migration 183–187）

在服务器 `electron-dock/mx-insight-hub` 目录：

```bash
MX_INSIGHT_BUILD_PROXY=http://127.0.0.1:7788 \
  MX_INSIGHT_SYNC_LAUNCHER=0 MX_SMOKE_DATA=0 \
  bash scripts/manage.sh ops internal-production deploy
```

**迁移在做什么：**

- 183 新建 `collect` schema。
- 184–187 各替换一次 `external_platform_proxy_bindings` 的供应商 CHECK 约束，再插入一行绑定：`tikhub-internal-7788` 存在且启用时绑到它，否则用系统直连。
- 每个迁移都设了 `lock_timeout 5s`。如果碰上长事务，迁移会失败，deploy 停下，不会自动重试；查明原因后重跑同一条命令。

**发布后只读检查：**

```bash
node scripts/collect-acceptance.mjs plan
```

- 应列出 21 个标准引擎，全部是 `missing`。
- 如果报 `collect admin API unavailable`，说明新版 Hub 没有生效。
- 管理台「Agent 中心 → System Proxy」里，apify、shodan、googleplay、overseas 应绑定到 7788 序列；TikHub 的绑定不变。

## 4. 第二步：部署 runner

```bash
cd ../mx-base/mx-crawler-runner
node scripts/lock-packages.mjs            # 23 行 ok
MX_INSIGHT_BUILD_PROXY=http://127.0.0.1:7788 bash scripts/deploy.sh all
```

`all` 依次执行以下几步：

1. **build**：构建镜像，过程中核对 sha256，装依赖，并跑 18 个包的离线测试。任何一步失败都会停下。
2. **import**：导入 containerd，和 Hub 用同一种方式。
3. **token**：创建 Secret `mx-crawler-runner-token`；已经存在时不动，值不打印。
4. **apply**：发布 Deployment，等待 rollout 完成。
5. **health**：检查健康状态。应返回 `"ok":true`，18 个插槽都是 `"available":true`。

**排查：**

| 现象 | 处理 |
|---|---|
| 某个插槽 `integrity_mismatch` | 服务器上的包文件和清单不一致，重新拉取 |
| 某个插槽 `dependencies_not_installed` | 镜像构建有问题，看构建日志 |
| Pod 起不来 | `kubectl -n mx-insight-hub describe pod -l app.kubernetes.io/name=mx-crawler-runner`。runner 必须和 Hub Admin 在同一节点（podAffinity），`/var/lib/mx-crawler-runner` 由 init 容器改属主 |

## 5. 第三步：建引擎、录入凭据、探测

回到 Hub 目录：

```bash
node scripts/collect-acceptance.mjs apply          # 创建缺少的标准引擎，全部停用；已有的不改
node scripts/collect-acceptance.mjs runner-token   # 从 Secret 读出 runner token，存成凭据 collect-runner（不打印）
node scripts/collect-acceptance.mjs probe          # 只读探测
```

**Apify 和 Shodan** 需要在管理台「数据接入与治理 → 自建引擎」里录入凭据，凭据只写不回显：

- `apify.main` 录入 Apify token（D17）；
- `shodan.main` 录入 Shodan key。

录入后再执行一次 `probe`：

| 引擎 | 探测会显示 | 要做的事 |
|---|---|---|
| `apify.main` | 账号和本月用量（Q9） | 在 Apify 页面查清各 Actor 的计费方式（Q10），再决定是否跑付费验收 |
| `shodan.main` | 套餐和剩余额度 | — |

**判断标准：**

- 18 个 `runner.*` 应为 `healthy · package runnable · credential configured`；
- `native.main` 应为 `healthy`，DNS、RDAP 引导表都可达，说明宿主网络能访问公共 DNS、IANA 和 Cert Spotter；
- 末尾一行应是 `runner capacity 24; Hub runner engine slots 18`。如果出现 `TOO MANY`，先调低引擎的执行槽：runner 满载时，多出来的任务会直接失败，而不是排队。

## 6. 第四步：启用并联网验收

```bash
node scripts/collect-acceptance.mjs enable --healthy
node scripts/collect-acceptance.mjs smoke --create-key /root/collect-acceptance.key
```

**`enable --healthy`** 只启用探测健康的引擎。

**`smoke --create-key`** 会：

- 建一个专用租户和调用方 `collect-acceptance`，再建一个 Key，授予全部验收能力。Key 的值写进 0600 权限的文件，不打印。
- 对每个能力和路由各发一次最小的真实公开查询。默认跳过付费的 Apify 和 Shodan。
- 以后重跑时，用 `--key-file /root/collect-acceptance.key` 复用这把 Key；用 `--only collect.audio` 这样的前缀只跑一部分。

**预期结果**（依据本机预演，第 9 节）：

| 结果 | 能力 / 路由 |
|---|---|
| 应当成功 | 小米、vivo、应用宝、百度、联想、Google Play 详情和 8 个操作；Pinterest、Dailymotion、Kick、WordPress；小宇宙；Apple Podcasts；LibriVox；DNS、RDAP、证书透明日志、子域名 |
| 这次重点确认（本机没测成） | 豌豆荚（本机 DNS 问题）、喜马拉雅（本机 IP 被限流 `ret 999`）、Dailymotion（Linux 容器里 CDN 返回 403） |
| 已知会失败，原因在外部 | Medium（交付包调用了 `aclose()`，等交付方修复）、Snapchat（页面改版，yt-dlp 失效）、Substack（接口拒绝 `offset=0`）。这几个引擎可以先停用，或者保持启用但不授权 |

**付费验收**（可选，先确认 Q10）：

```bash
node scripts/collect-acceptance.mjs smoke --include-paid --only collect.intel.shodan,collect.ecommerce.temu,collect.ads.meta,collect.web.similarweb --key-file /root/collect-acceptance.key
```

- Apify 每个能力只跑最小量：Temu 10 条、Meta 广告库 10 条、Similarweb 1 个域名。成本记在任务上，只有管理台能看到。
- 其余 14 个 Apify 能力用同样的方式按前缀逐个验收，输入参考 07 第 10 节。

**收尾**：验收用的 Key 可以留作以后复测，也可以在管理台撤销；租户 `collect-acceptance` 不影响业务。

## 7. 第五步：交给业务

- **授权**：在 Key 管理里，给需要的调用方 Key 单独授予验收通过的能力。不要批量授权，也不会自动授权。
- **计费**：引擎默认不计费。需要收费时，先在套餐管理里发布价格，再在引擎配置里打开计费。
- **调容量**：在引擎页调整执行槽。所有 runner 引擎的执行槽之和要保持在 24 以内；Apify 的执行槽不要超过账号允许的并发运行数。

## 8. 回滚

| 范围 | 做法 | 影响 |
|---|---|---|
| 某个能力 | 在引擎页停用或解除路由 | 该能力返回 `engine_disabled` / `capability_not_routed`，其余不受影响 |
| runner | `kubectl -n mx-insight-hub scale deployment/mx-crawler-runner --replicas=0`，或 `kubectl delete -f deploy/k8s/mx-crawler-runner.yaml` | runner 引擎的任务会失败（不可达），不收费。宿主机记录保留，可以删 `/var/lib/mx-crawler-runner` |
| Hub 代码 | 按平常的方式回到上一版再 deploy | migration 183–187 只做了新增，旧代码会忽略新表和新绑定，不需要回滚 schema |

## 9. 本机预演（2026-11-09）

**测试与构建：**

- `collect-acceptance.mjs` 的自检测试：标准引擎覆盖每条路由，并且只覆盖一次；每个验收输入都能通过 API 校验。
- 在一次性 PostgreSQL 上依次应用了 183–187，原生测试通过。
- Hub 的部署 smoke（`scripts/smoke.mjs`）对本地 Hub 通过。
- runner 镜像在本机 Docker 上构建通过（arm64）；Internal 是 amd64，会在服务器上重新构建。

**对本地 Hub（内存模式）和本地 runner 跑了整套流程：**

1. `plan`：21 个缺失。
2. `apply`：21 个已创建；重复执行时没有改动。
3. `runner-token`：已保存。
4. `enable --healthy`：启用 19 个；Apify、Shodan 因为没有凭据被跳过。
5. `smoke`：免费的用例结果和第 6 节的预期一致，其中 Google Play 9 个操作全部成功。

**预演中发现并修正了一个问题**：runner 的并发上限原来是 8，但标准配置会把 18 个 runner 引擎都启用。一批任务同时进来时，多出来的会被 runner 以 429 拒绝，Hub 把它们记为 `runner_busy` 失败。

- runner 上限改为 24、每个包 4，内存上限改为 4 GiB。
- 现在 `probe` 会核对这条容量规则。

## 10. 仍在外部等待的事项

- Q9、Q10：Apify token 是否有效、各 Actor 的价格；Shodan 的套餐。
- Medium 交付包修复；Snapchat（yt-dlp）、Substack（substack_api）等上游修复。升级上游要重新审核，见 07 第 15 节。
- Podcast Index 的凭据（D44）；音频下载要等 mx-static（D42）。
- Q13：Hub 改成多节点以后，runner 和 7788 怎么部署。
