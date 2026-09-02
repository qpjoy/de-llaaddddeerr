# ADR-0001：mx-base 承载共享平台设施，且不成为任何人的运行时依赖

状态：已接受（2026-09-01）

## 背景

需要一个 CI 来构建产物（首先是罗盘的 Electron 安装包，服务器上跑不了 Windows 构建）。
候选归属有三个：放进 `mx-common`、放进 `mx-test-framework`、新建一个同级项目。

## 决策

**新建 `electron-dock/mx-base`**，承载共享的平台设施：Jenkins，以及将来的镜像仓库、
对象存储、GitOps 控制器。

并附一条硬约束：

> **mx-base 不可用时，mx-test-framework 必须仍能部署、仍能派任务、仍能出报告。**

## 理由

**放 `mx-common` 是类别错误。** mx-common 是一个 npm 包，靠 `file:` 链接复用**代码**；
Jenkins 是**部署出来的服务**。把服务塞进库里，两边的版本语义都会坏掉——库的使用者
`npm install` 时会拿到一堆和它无关的 YAML，而服务的升级会变成一次库发版。

**放 `mx-test-framework` 是循环依赖。** Jenkins 要构建 launcher、insight-hub，
以及 MXT 自己。装在 MXT 里意味着 `manage.sh down` 能把所有项目的 CI 一起关掉，
而 MXT 又是 Jenkins 的构建对象之一。这种环在第一次故障时才会显形，那时最难拆。

**只有一个 Jenkins 时，这个边界依然成立。** 边界画对了，东西会自己长进来：
镜像仓库、MinIO、Argo 都是同一类"谁都要用、谁都不该拥有"的设施。

## 那条硬约束为什么重要

它是 [MXT ADR-0001](../../mx-test-framework/specs/adr/0001-standalone-platform.md)
"平台是增益，不是前置依赖"的同一条推理再走一层：

- MXT 挂了，被测仓库的 `pnpm e2e:local` 仍要能独立跑通
- mx-base 挂了，MXT 仍要能独立跑通

具体到实现，这条约束翻译成一条可检查的规则：

**Jenkins 只负责"构建产物"和"外部触发"，不负责"跑测试"和"定时"。**

跑测试和定时都在 MXT 里（它自带调度器和 k8s 派发器）。Jenkins 构建完把产物地址和
sha256 告诉 MXT，就退出这次交互。Jenkins 停机期间，MXT 的定时任务照跑，
只是拿不到新的安装包——用上一个已知good的版本继续测，这是可接受的降级。

反过来如果让 Jenkins 做定时和派发，它就进入了 MXT 的关键路径，
这条约束立刻失效。

## 后果

- 多一套部署。用 `manage.sh deploy` 一条命令摊薄，与 MXT 和 insight-hub 同范式。
- Jenkins 的配置写成 git 里的 JCasC yaml，controller 变成**可重建的无状态组件**，
  不需要备份。重装约 20 分钟。
- 构建用 kubernetes-plugin 起临时 agent pod，workspace 随 pod 消失，
  `JENKINS_HOME` 不随构建次数膨胀。
- **Windows / macOS 构建需要静态 agent**（k8s 里起不了 Windows 容器）。
  那是唯一的常驻 agent，也是唯一需要人维护的部分。

## 被否决的方案

- **放 mx-common**：类别错误，见上。
- **放 mx-test-framework**：循环依赖，且 `down` 的爆炸半径不可接受。
- **装 GitLab 顺便拿 CI**：代码已经在 GitHub 上，为了 CI 引入一整套 forge
  （仓库 + registry + artifacts + Postgres + Redis + Gitaly，稳态 100–200GB）
  是全场最差的性价比。
- **让 Jenkins 做测试调度**：会让 mx-base 进入 MXT 的关键路径，
  直接违反本 ADR 的硬约束。
