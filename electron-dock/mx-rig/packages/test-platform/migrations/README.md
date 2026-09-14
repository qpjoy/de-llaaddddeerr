# 迁移

一个文件一次变更，按编号顺序执行，由 `@qpjoy/mx-common` 的迁移器跑
（`node server/migrate.mjs`，或 compose 里的 `migrate` 服务）。

## 一条铁规则：已经跑过的迁移不能再改

迁移器给每个文件算校验和存进 `schema_migrations`。**改动一个已应用的文件——哪怕只改
一个注释——都会让它拒绝往下走**，报 `Applied migration changed on disk`。

这不是洁癖。它挡住的是这样一类事故：有人改了 `003` 的建表语句，新环境建出来的库和老
环境不一样，而两边的迁移记录都显示"已应用"。校验和是唯一能发现这件事的东西。

实际踩过两次：

1. **注释也算。** `specs/` 改名成 `docs/` 时，一次 `sed` 顺手改了六个已应用文件里的
   路径注释。文件内容变了，校验和就变了，所有已部署的库当场无法迁移。
   **已应用的迁移里那些指向 `specs/…` 的注释因此保持原样**——它们是冻结的，
   而不是被漏掉的。
2. **换行符也算。** 库如果是在容器里（LF）迁移的，在 Windows 主机上（CRLF）再跑
   `node server/migrate.mjs` 会把每个文件都算成"改过"。同一个库要么一直在容器里迁移，
   要么一直在主机上，别换着来。

要改一个已应用迁移的效果，**加一个新文件**。

## 已经不同步了怎么办

先弄清楚差在哪：库里的实际 schema 和文件说的是不是一回事。

```sql
select filename, applied_at from schema_migrations order by filename;
```

- **只是注释或换行符不同**（schema 一致）→ 更新那一行的 `checksum` 即可。
- **schema 真的不一样**（曾经有人改过已应用的文件）→ 先写 SQL 把库补齐到文件描述的
  样子，再更新校验和。**不要只更新校验和**：那等于把不一致签字确认了。
- **库里没有值得留的数据** → 直接重建最省事。

## 本地起一个干净的库

```bash
docker compose -f deploy/compose/docker-compose.yml up -d postgres
docker compose -f deploy/compose/docker-compose.yml run --rm migrate
```

Windows 上如果 55432 被 Hyper-V 的保留端口段占了（症状是
`bind: An attempt was made to access a socket in a way forbidden by its access
permissions`，看着像防火墙其实不是），换一个端口：`MXT_PG_PORT=55500`。
保留段用 `netsh interface ipv4 show excludedportrange protocol=tcp` 看。
