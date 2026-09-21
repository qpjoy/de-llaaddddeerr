# mx-static：NAS 迁移与静态文件服务

本项目统一维护两类工作：服务器 SSD/NAS 存储排查与迁移工具，以及 mx-static 媒体采集、读取和归档服务。

| 工作 | 入口 |
| --- | --- |
| 当前 Delta 媒体迁移、目录规划、只读检查 | [nas_docs](nas_docs/README.md) |
| 按实例预复制、停写、校验、切换与回滚 | [Delta 迁移记录](nas_docs/migrations/2026-09-22-delta-raw-media.md) |
| 静态文件服务部署、API、缓存、归档 | [服务文档](docs/README.md) |
| 通用 NFS、fstab/systemd 与存储迁移背景 | [通用方案](docs/storage-migration.md) |

迁移工具可直接在 Linux 宿主机运行，不需要先部署 mx-static，也不需要 Node.js。应用服务保留 Docker 部署；媒体迁移不自动把其他项目的数据导入 mx-static 对象库。

在服务器的本项目目录运行：

```bash
sudo bash scripts/nas-audit.sh layout
sudo bash scripts/nas-audit.sh deployment
sudo bash scripts/nas-audit.sh media
```

三个命令均只读，不挂载、不复制、不删除、不重启服务。第一条会读取少量 NAS 目录元数据，第三条会扫描两个指定 SSD 卷的文件元数据。详细前提、输出说明和边界见 [nas_docs/README.md](nas_docs/README.md)。本轮先检查，原 Docker volumes 和旧媒体完整保留。

诊断输出保存到 `reports/`，现场配置可保存到 `nas_docs/local/`，两者均已加入 `.gitignore`。代码和迁移文档通过 Git 分发，不需要压缩包。

2026-09-22 三份现场报告已回传：[结论与下一步](nas_docs/evidence/2026-09-22-live-findings.md)。临时文件占两个 raw_media 目录约 67.35%，不自动删除。新增的 `sudo bash scripts/nas-probe.sh permissions --write-test` 是独立显式写探测，只创建并清理自己的约 4 KiB 测试对象，详见 [探测说明](nas_docs/README.md#下一步独立权限写探测)。
