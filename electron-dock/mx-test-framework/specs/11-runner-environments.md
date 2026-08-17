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
              mountPath: /artifacts
      volumes:
        - name: artifacts
          persistentVolumeClaim:
            claimName: mx-test-framework-artifacts
```

产物直接写进独立 PVC,不经过网络上传。这是服务端 runner 比本地 runner 简单的地方。

### 资源

一个 Chromium 实例大约需要 1 CPU / 2GB。Job 的 requests/limits 按此设，
并发数由平台的队列控制而不是靠 k8s 排队,这样超载时任务是"排队中"而不是 Pod Pending。

## 桌面 e2e：不能在服务器上跑

这里的限制不是无头，是**被测对象**：compass electron 的交付物是 Windows 的 `.exe`
和 macOS 的 `.dmg`。RHEL 上没有这些产物可以运行。

所以走你说的方案：**到谁的机器上跑**。

### 本地 runner

```
1. 平台上点「下载执行器」        → 拿到 mxt-runner（单文件 CLI）
2. mxt-runner login             → 浏览器打开 mx-launcher 登录页
                                  用现有 mx-launcher 账号登录并授权
3. mxt-runner watch             → 常驻，认领分配给这台机器的任务
   或 mxt-runner run <taskId>   → 只跑指定的一个任务
4. 本地执行 → 产物上传服务器    → 平台上和服务端跑的任务一视同仁地展示
```

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
