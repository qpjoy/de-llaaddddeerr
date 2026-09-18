# knock-ocr

自建 OCR 服务的调研与落地。当前阶段：**P0 Demo —— 把 PaddleOCR-VL-1.6 全量跑起来，验证服务器可行性。**

模型：`PaddleOCR-VL-1.6-0.9B` —— OmniDocBench v1.6 **96.3%**，当前文档解析榜首。

## 一条命令

```bash
bash scripts/manage.sh deploy
```

跑完打印访问地址。浏览器打开就能拖图识别，同一个能力也暴露为 HTTP API。

需要改配置时写在命令前面，不用改文件、不用写 .env：

```bash
GPU_ID=1 PORT=9000 bash scripts/manage.sh deploy
```

## 常用命令

```bash
bash scripts/manage.sh status          # 状态
bash scripts/manage.sh test            # 端到端识别一次（不传文件会自动造一张样张）
bash scripts/manage.sh test my.pdf     # 用自己的文件
bash scripts/manage.sh bench -c 8 -n 40 # 并发压测，看 QPS / P50 / P95
bash scripts/manage.sh logs vllm       # 看模型加载进度
bash scripts/manage.sh down            # 停止
bash scripts/manage.sh clean           # 删掉本 demo 的容器/网络/自建镜像
```

## API

```bash
curl -F 'file=@page.png' http://<server>:8710/api/ocr
```

| 接口 | 说明 |
|---|---|
| `POST /api/ocr` | 上传图片/PDF → `{markdown, result, pages, elapsed_ms}` |
| `GET /api/info` | 模型、设备、后端状态、实时指标 |
| `GET /api/metrics` | 计数与 P50/P95/P99 |
| `GET /healthz` | 就绪探针 |
| `GET /api/docs` | 自动生成的 OpenAPI 文档 |

## 文档

- [DEMO 说明](docs/DEMO.md) —— 架构、隔离策略、排障
- [OCR 选型调研报告](docs/OCR选型调研报告.md) —— 开源横评、API 对比、成本测算
- [4 卡 5090 部署方案](docs/4卡5090部署方案.md) —— 生产形态与 Blackwell 踩坑清单
