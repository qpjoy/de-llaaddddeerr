# Local Ops Guide for manage.sh

这份文档给“不熟 K8s 的运维”使用。先在本机把 Docker Compose 跑熟，再进入 K8s
dry-run，最后才做 K8s apply。

所有命令都在仓库根目录执行：

```bash
cd /Users/qpjoy/workspace/qpjoy/de/de-llaaddddeerr/electron-dock/mx-launcher
```

## 0. 先看总指南

```bash
bash scripts/manage.sh ops guide
```

这个命令只打印建议路径，不会启动服务。

## 1. 本机环境检查

```bash
bash scripts/manage.sh ops doctor
```

重点看：

- `node` 和 `pnpm` 是否存在。
- `docker` 是否存在。没有 Docker 就不能跑 Compose shadow。
- `kubectl` 是否存在。没有 kubectl 也可以先跑 Compose shadow。
- `server package`、`shadow compose`、`k8s internal-shadow manifests` 是否 OK。

如果 Docker/K8s 检查不通过，先打开 Docker Desktop。要跑 K8s，还需要在 Docker
Desktop 里启用 Kubernetes。

## 2. 不碰 K8s：先跑 Compose shadow

Compose shadow 是最容易理解的路径：它会启动两个容器：

- `mx-internal-postgres-shadow`: PostgreSQL。
- `mx-launcher-server-shadow`: Internal API。

看计划：

```bash
bash scripts/manage.sh ops local-shadow plan
```

一键构建、启动、smoke、看状态：

```bash
bash scripts/manage.sh ops local-shadow cycle
```

成功时应看到 HTTP smoke：

```text
OK healthz
OK app-center apps
OK platform kernel smoke
```

查看状态：

```bash
bash scripts/manage.sh ops local-shadow status
```

查看日志：

```bash
bash scripts/manage.sh ops local-shadow logs
```

停止容器：

```bash
bash scripts/manage.sh ops local-shadow down
```

注意：`down` 会停掉容器，但保留 PostgreSQL Docker volume。这是为了模拟服务重启后
数据仍然存在。

## 3. K8s 先 dry-run，不创建资源

当 Compose shadow 跑熟后，再看 K8s 路径。

看 K8s 部署计划和概念解释：

```bash
bash scripts/manage.sh ops k8s-shadow plan
```

做 dry-run：

```bash
bash scripts/manage.sh ops k8s-shadow dry-run
```

dry-run 会让 kubectl 解析这些对象，但不会创建资源：

- Namespace
- ConfigMap
- Secret
- PostgreSQL Service + StatefulSet
- Migration Job
- Internal API Service + Deployment

如果 dry-run 报 `connect: operation not permitted`，通常是当前执行环境访问不了
Docker Desktop Kubernetes API；在本机终端直接执行通常可以。

## 4. 真正部署到本机 K8s

确认 Docker Desktop Kubernetes 已启用后执行：

```bash
bash scripts/manage.sh ops k8s-shadow apply
```

这个命令会按顺序执行：

1. 创建 namespace。
2. 创建 ConfigMap。
3. 从本地环境变量生成 Secret。
4. 启动 PostgreSQL StatefulSet。
5. 等 PostgreSQL ready。
6. 跑 TypeORM migration Job。
7. 等 migration Job complete。
8. 启动 Internal API Deployment。
9. 等 Internal API rollout 完成。

可选设置数据库密码：

```bash
PG_USER=mx_internal PG_PASSWORD=your-password PG_DB=mx_internal_shadow \
  bash scripts/manage.sh ops k8s-shadow apply
```

不设置时使用 shadow 默认值，只适合本机测试。

## 5. 查看 K8s 状态、日志和 smoke

查看资源：

```bash
bash scripts/manage.sh ops k8s-shadow status
```

查看 API 日志：

```bash
bash scripts/manage.sh ops k8s-shadow logs
```

跑 smoke：

```bash
bash scripts/manage.sh ops k8s-shadow smoke
```

这个命令会临时执行 `kubectl port-forward`，把本机 `127.0.0.1:18090` 转发到 K8s 里的
`mx-launcher-internal` Service，然后跑同一套 HTTP smoke。

## 6. 停止 K8s shadow

```bash
bash scripts/manage.sh ops k8s-shadow down
```

它会删除：

- Internal API Deployment + Service。
- Migration Job。
- PostgreSQL StatefulSet + Service。
- ConfigMap。
- 由脚本生成的 Secret。

它会保留：

- Namespace。
- PostgreSQL PVC。

保留 PVC 是为了安全。删除数据盘应该做成单独 purge 动作，并要求二次确认。

## 7. 常见问题

### Docker Compose smoke 失败

先看：

```bash
bash scripts/manage.sh ops local-shadow logs
bash scripts/manage.sh ops local-shadow status
```

常见原因：

- Docker Desktop 没启动。
- `18090` 端口被别的进程占用。
- 镜像还没 build 完。

### K8s apply 失败

先看：

```bash
bash scripts/manage.sh ops k8s-shadow status
bash scripts/manage.sh ops k8s-shadow logs
```

常见原因：

- Docker Desktop Kubernetes 没启用。
- 集群拉不到 `qpjoy/mx-launcher-server:shadow` 镜像。
- PostgreSQL PVC 创建失败。
- Migration Job 没完成。

### 本地镜像和 K8s 镜像

Docker Desktop 本地 K8s 通常能使用本机镜像。远程 Internal 集群不能直接使用本机镜像，
必须先 push 到 registry，再把 manifest 里的 image 改成远程 registry 地址。
