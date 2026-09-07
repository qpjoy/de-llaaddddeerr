# 11 · 执行环境

回答一个具体问题：**部署在 Internal 的 RedHat 服务器上，能自动跑 e2e 吗？**

## Web e2e：能，全自动

**结论：RHEL 上跑无头浏览器 e2e 没有障碍，前提是用容器。**

平台把每次执行拉起成一个 k8s Job，镜像用官方的浏览器镜像：

| 引擎 | 镜像 | 内容 |
| --- | --- | --- |
| Cypress | `cypress/included:<version>` | Cypress + Chrome/Electron + 全部系统依赖 |
| Playwright | `mcr.microsoft.com/playwright:v<version>-noble` | Chromium/Firefox/WebKit + 全部系统依赖 |

关键点：**容器不使用宿主的系统库**。这两个镜像基于 Debian/Ubuntu，自带 `nss`、`atk`、
`libdrm`、`libxkbcommon`、`mesa-libgbm` 等浏览器需要的一整套 so。宿主是 RHEL 还是别的
发行版，对容器内的浏览器没有影响。也不需要 X server——现代 Chromium 的 headless 模式
不依赖 X。

反过来说，**不要在 RHEL 裸机上直接装 Playwright/Cypress**：

- `playwright install-deps` 只支持 Debian/Ubuntu，RHEL 上不可用
- 手动 `dnf install` 那十几个库,版本对不上就是浏览器启动即崩,排查成本很高
- Cypress 同样需要 GTK/X 相关的一堆库

容器把这些问题整体绕开了,而且服务已经部署在 k8s 上,拉一个 Job 是既有能力。

### 具体形态

```yaml
# 服务端 runner = 一次性 Job
apiVersion: batch/v1
kind: Job
spec:
  template:
    spec:
      restartPolicy: Never
      containers:
        - name: runner
          image: cypress/included:15.0.0     # 或 playwright:v1.5x-noble
          command: ["/bin/bash", "-c", "..."]  # clone → install → 执行 → 上传
          env: [ MXT_RUN_ID, MXT_BASE_URL, ... ]
          volumeMounts:
            - name: artifacts
              mountPath: /data/artifacts
            - name: workspace
              mountPath: /work
          resources:
            requests: { cpu: "1", memory: 2Gi, ephemeral-storage: 2Gi }
            limits: { cpu: "2", memory: 8Gi, ephemeral-storage: 14Gi }
      volumes:
        - name: artifacts
          emptyDir: { sizeLimit: 2Gi }
        - name: workspace
          emptyDir: { sizeLimit: 10Gi }
```

产物只在这个 Pod 的有限 emptyDir 暂存，随后使用本 Run 的 token 调上传 API；Job
不挂平台持久化 PVC。持久化目录只有 server 能写，服务端统一执行单文件、单 Run、
全局字节上限和宿主磁盘保留水位。

### 资源

默认 Job request 为 1 CPU / 2Gi，limit 为 2 CPU / 8Gi，同时限制 14Gi
ephemeral-storage。并发数由平台队列的全局 cap 控制，namespace ResourceQuota 再做
第二道硬边界；超载时任务保持“排队中”，不是无限创建 Pod。

## 桌面 e2e：不能在服务器上跑

这里的限制不是无头，是**被测对象**：compass electron 的交付物是 Windows 的 `.exe`
和 macOS 的 `.dmg`。RHEL 上没有这些产物可以运行。

所以走你说的方案：**到谁的机器上跑**。

### 本地 runner

```
1. 平台「执行机」页面点「把这台电脑变成执行机」→ 拿到一条命令（含 15 分钟的一次性接入码）
2. 粘到这台机器的终端            → 脚本下载单文件 CLI、注册、起 watch
                                  不在这台机器上输密码，也不需要管理员权限
3. 常驻等待，认领能力匹配的任务  → 或 mxt-runner once 只取一个
4. 本地执行 → 产物上传服务器    → 平台上和服务端跑的任务一视同仁地展示
5. 不想要了 → mxt-runner uninstall（--purge 连缓存一起删）
```

手工路径仍然在：`mxt-runner login` + `register`，适合脚本化和常开的机器
（那种机器用 `--kind server`）。自助接入的细节见
[25 §6](25-live-runs-and-runner-onboarding.md)。

登录复用 mx-launcher 已开放的 User Center 接口
（`/internal/v1/user-center/token/introspect` 校验，`/internal/v1/sdk/oauth/token` 换取），
不新建账号体系。平台侧再做自己的授权：这个用户能看哪些应用、能跑哪些任务
（见 [ADR-0005](adr/0005-federated-identity-and-runner-tokens.md)）。

runner 注册时上报自己的能力：

```json
{ "os": "windows", "arch": "x64", "engines": ["playwright"],
  "surfaces": ["electron", "web"], "label": "老王的开发机" }
```

平台按能力派活。Linux 容器池不会被派到 Electron 任务，反之亦然。

### 定时任务遇上本地 runner

这是唯一需要想清楚的地方——服务器随时在,个人电脑不一定开机。

| 任务类型 | 定时执行 |
| --- | --- |
| Web（服务端 runner） | 到点直接跑,无需人管 |
| 桌面（本地 runner） | 到点后进入 `pending-runner`,**排队等机器上线** |

排队状态的规则：

- 任务到点 → 建 run,状态 `pending-runner`,UI 上显示"等待执行机"
- 任何一台满足能力的 local runner 上线并 `watch` → 认领,开始执行
- 超过 `claimWindowMinutes`（默认 12 小时)无人认领 → `expired`
- **`expired` 不算失败**,不产生失败告警,只在列表里标灰

这样即使没有常驻机器，定时任务也是可用的：设成每天凌晨跑,谁第一个开机谁跑。
如果要真正的无人值守，指定一台常驻开机的 Windows 机器跑 `mxt-runner watch --always`
即可,不需要额外部署。

## 产物存储

独立 PVC，与平台自身的数据库、以及任何线上业务数据完全分开：

```
PVC: mx-test-framework-artifacts   （独立 StorageClass / hostPath）
  /runs/<runId>/
    report/index.html
    videos/**
    screenshots/**
    summary.json
```

- 数据库里只存**路径索引**，不存字节
- 默认保留 30 天，由 `manage.sh clean` 或平台的清理任务按天删目录
- 删目录后 run 记录仍在，报告显示"产物已过期",不会 404

没有对象存储、没有 sha256 校验链、没有分级保留策略——这些是平台做大之后的事,
现在不需要。见 [10-deployment.md](10-deployment.md)。
