# mx-base

共享平台设施的货架：将来的镜像仓库、对象存储、GitOps 控制器都归这里。
目前架上放着一套**随时可启用但尚未启用**的 Jenkins。

## 一句话：现在不要部署它

[MXT ADR-0006](../mx-test-framework/specs/adr/0006-mxt-absorbs-builds-jenkins-deferred.md)
的结论是 **Jenkins 对当前范围没有不可取代之处**——唯一真正难复制的是多阶段流水线
DSL，而当前的流水线只有三步（构建 → 发布给 Release Center → 通知）。
「构建」这个动作由 MXT 的 `kind: build` 作业吸收，跑在它本来就需要的那台
Windows 执行机上。

镜像、JCasC、清单都已就绪，所以这是一个**成本为零的期权**，不是待办事项。

### 什么时候启用

满足任意一条就 `manage.sh deploy`：

1. 需要**多阶段 + 扇出扇入**的流水线（跨阶段，不是 `--shard` 那种单次执行内的并行）
2. 需要**人工审批门**
3. **超过 3 个人**各自配置构建，需要独立的权限与审计面
4. 需要**多平台并行出包**并汇总

在那之前，日常工作全部在 MXT 后台完成。

## 部署（满足上述条件后）

```bash
bash scripts/manage.sh deploy
```

镜像 → 配置 → Jenkins → 等就绪。`.env.internal` **没有必填项**：
admin 密码首次自动生成，之后从 Secret 读回（重复 deploy 不会把密码转掉）。

```bash
bash scripts/manage.sh password    # 打印 admin 密码
bash scripts/manage.sh agent-cmd   # 打印接入构建 agent 的命令
bash scripts/manage.sh status
bash scripts/manage.sh down        # 停服务；MXT 完全不受影响
```

界面在 `http://<服务器内网 IP>:30880`。

## 为什么它不吃硬盘

| 做法 | 效果 |
| --- | --- |
| kubernetes-plugin，每次构建起临时 agent pod | **workspace 随 pod 消失**，`JENKINS_HOME` 不随构建次数膨胀 |
| 插件在镜像里预装（`jenkins/plugins.txt` 钉死版本） | 启动不联网拉插件，重启后行为一致 |
| 配置写成 `jenkins/casc.yaml` | controller 是**可重建的无状态组件**，不需要备份；重装约 20 分钟 |
| `logRotator` 限制构建历史 | 唯一会增长的东西被封顶 |

稳态约 20GB。对比 GitLab CE（完整 forge，100–200GB 起）不在一个量级。

## 两种 agent，别搞混

这是最容易混淆的一点：

```
构建 agent  ──→  Jenkins        跑 quasar build，出 .exe / .dmg
测试执行机  ──→  mx-test-framework   跑 e2e 用例，出报告
```

**同一台物理机可以两个都是，但那是两个进程、两套凭据、两个队列。**

| | 构建 agent | 测试执行机 |
| --- | --- | --- |
| 连谁 | Jenkins（`java -jar agent.jar`） | MXT（`mxt-runner watch`） |
| 谁派活 | Jenkins 队列 | MXT 调度器 |
| 在哪配任务 | Jenkins（运维） | **MXT 后台（所有人）** |
| 什么时候需要 | 出 Windows/macOS 安装包 | 跑 Electron 测试 |

Linux 构建不需要静态 agent —— k8s 里起临时 pod 就够了。
**只有 Windows / macOS 构建需要常驻 agent**，因为 k8s 起不了 Windows 容器。
那是 mx-base 里唯一需要人维护的部分。

## 构建完之后怎么交给 MXT

Jenkins **不触发测试**。它构建、上传制品、然后告诉 MXT「有新包了」：

```bash
curl -X POST "$MXT_URL/api/v1/apps/luopan/packages" \
  -H "authorization: Bearer $MXT_TOKEN" -H "content-type: application/json" \
  -d "{\"url\":\"$ARTIFACT_URL\",\"sha256\":\"$SHA\",\"filename\":\"$NAME\",\"version\":\"$VER\",\"gitSha\":\"$GIT_SHA\"}"
```

MXT 按自己的排期决定什么时候用它跑测试。这个方向不能反过来——
Jenkins 一旦触发测试，mx-base 就进了 MXT 的关键路径，
[ADR-0001](docs/adr/0001-shared-platform-services.md) 的硬约束立刻失效。

`sha256` 是必填且强校验的：执行机会把这个文件下载到别人自己的电脑上并运行它。

## 目录

| 路径 | 内容 |
| --- | --- |
| `jenkins/` | Dockerfile、钉死版本的 `plugins.txt`、`casc.yaml`（controller 的全部配置） |
| `deploy/k8s/internal/` | namespace、RBAC、PVC、Deployment、Service（含 NodePort 30880） |
| `scripts/manage.sh` | 生命周期 |
| `docs/adr/` | 架构决策 |

## 尚未上机验证

Jenkins 的镜像构建、JCasC 加载、kubernetes-plugin 起 agent pod
这三条都**没有在真实集群上跑过**。首次 `deploy` 要重点看：

1. `jenkins-plugin-cli` 能否拉到插件（内网需要配代理或镜像源）
2. JCasC 是否被接受（`manage.sh logs` 里会打印解析错误）
3. 起一个 `agent { label 'node' }` 的流水线，确认 agent pod 能创建并连回来
