# 自建 OCR 服务选型调研报告

> 调研日期：2026-09-08
> 目标：内部服务器自建、中文准确率优先、支持高并发、配合爬虫批量处理

---

## 一、结论先行

**推荐"双引擎 + 云端兜底"三层架构：**

| 层 | 引擎 | 定位 | 硬件 |
|---|---|---|---|
| 快通道（80~90% 流量） | **PP-OCRv6_medium**（34.5M） | 爬虫抓来的截图/商品图/海报/短文本，纯文字提取 | CPU 即可，GPU 更快 |
| 精修通道（10~20% 流量） | **PaddleOCR-VL-1.6**（0.9B VLM）+ vLLM | PDF/合同/发票/表格/公式/竖排/古籍，输出 Markdown+JSON | 单张 24G 显存卡足够（模型本体 ~2GB） |
| 兜底通道（<1%） | **qwen-vl-ocr** 或 **豆包视觉** API | 难例、极端版面、快速上线期过渡 | 只要 API Key |

**核心判断：**

1. **不需要自己训练**。PaddleOCR 全系是开箱即用的预训练模型，中文是它的母语场景，Apache-2.0，可商用。之前试的 JS 版 OCR（Tesseract.js）中文表现差是模型本质问题，不是训练量问题 —— **放弃它**。
2. **专用 OCR 小模型 > 通用大模型**。0.9B 的 PaddleOCR-VL 在 OmniDocBench v1.6 上拿到 96.3%，超过 Gemini-2.5 Pro、Qwen2.5-VL-72B。通用大模型做 OCR 有幻觉、漏字、不给坐标、贵且慢。
3. **大模型 API 确实"只要 key"**，但只适合做兜底，不适合做主力（见第四章）。

---

## 二、开源自建方案横评

### 2.1 OmniDocBench v1.6 榜单（文档解析综合分）

| 排名 | 模型 | 分数 | 参数量 | 语言 | 许可证 |
|---|---|---|---|---|---|
| 1 | **PaddleOCR-VL-1.6** | **96.34%** | 0.9B | 109 种 | Apache-2.0 |
| 2 | MinerU2.5-Pro | 95.75% | 1.2B | 109 种 | 需逐版本确认（历史 AGPL） |
| 3 | GLM-OCR | 95.22% | 0.9B | 8 种 | — |
| 4 | dots.ocr | — | 1.7B~3B | 100+ | MIT |
| 5 | DeepSeek-OCR / OCR-2 | — | ~3B MoE | ~100 | MIT |
| 6 | GOT-OCR 2.0 | — | 580M | 20+ | Apache-2.0 |
| 7 | Granite-Docling | — | 258M | 主要英文 | Apache-2.0 |

### 2.2 资源与吞吐（L40S 参考数据）

| 模型 | FP16 显存 | INT8 显存 | 批大小 | 吞吐（页/分钟） |
|---|---|---|---|---|
| PaddleOCR-VL-1.6 | ~2 GB | ~1 GB | 32+ | ~45 |
| dots.ocr | ~3.5 GB | ~2 GB | 24+ | ~35 |
| DeepSeek-OCR | ~8 GB | ~5 GB | 16 | ~35 |
| GOT-OCR 2.0 | ~3 GB | ~2 GB | 32+ | ~65 |

> PaddleOCR-VL 比 MinerU2.5 快 14.2%，比 dots.ocr 快 253%。
> PaddleOCR 另有 HPD-Parsing 轻量解析模型，峰值 4752 tokens/s。

### 2.3 PP-OCRv6（2026-06-11 发布）—— 高并发主力

三档模型，**一个模型覆盖 50 种语言**（中/英/日 + 46 种拉丁语系），无需切模型：

| 档位 | 参数量 | 适用场景 |
|---|---|---|
| Tiny | 1.5M | 浏览器/端侧/IoT，浏览器内单图最低 **97ms** |
| Small | 7.7M | 移动端/桌面端 |
| Medium | 34.5M | **服务端主力**，Intel Xeon CPU 端到端 **1.40s/图**，为 PP-OCRv5_Server 的 **5.2 倍速**（OpenVINO） |

- 精度：Medium 检测 86.2%、识别 83.2%，比 PP-OCRv5 同档 **检测 +4.9%、识别 +5.1%**
- 鲁棒性：多尺寸预测方差仅 5.19%（比 v5 降低 35%），边缘尺寸扰动一致性 +20.5%
- 新增工业场景：PCB、数码管、CAD 图纸、点阵字符、轮胎印字

### 2.4 各方案适配性判断

| 方案 | 中文 | 高并发 | 表格/版面 | 部署复杂度 | 建议 |
|---|---|---|---|---|---|
| **PP-OCRv6** | ★★★★★ | ★★★★★ | ✗（只出文本行） | 低（pip） | **主力快通道** |
| **PaddleOCR-VL-1.6** | ★★★★★ | ★★★★（vLLM 连续批处理） | ★★★★★ | 中（需 vLLM） | **精修通道** |
| **RapidOCR**（ONNXRuntime） | ★★★★☆ | ★★★★★ | ✗ | **极低**（50~80MB，无 Paddle 依赖） | 无 GPU / 容器化备选 |
| PP-StructureV3 | ★★★★★ | ★★★ | ★★★★★ | 中 | PDF→Markdown/JSON 流水线 |
| MinerU2.5 | ★★★★★ | ★★★ | ★★★★★（复杂合并单元格更强） | 中 | **许可证需法务确认** |
| DeepSeek-OCR | ★★★★ | ★★★ | ★★★★ | 中 | MoE 批量场景省 30~40% 成本 |
| Tesseract / Tesseract.js | ★★ | ★★★ | ✗ | 低 | **中文不推荐** |
| EasyOCR | ★★★ | ★★★ | ✗ | 低 | 全面弱于 PP-OCRv6 |

**RapidOCR 说明**：把 PaddleOCR 训好的模型转成 ONNX 跑，去掉 PaddlePaddle 框架依赖，镜像只有 50~80MB，冷启动快，纯 CPU 0.5~1s/页，同时支持 ONNXRuntime / OpenVINO / MNN / TensorRT 多后端。代价是没有 PP-StructureV3 的表格结构识别。**如果内部服务器暂时没有 GPU、且只做纯文本提取，RapidOCR 是最省事的选择。**

---

## 三、许可证与合规

| 模型 | 许可证 | 商用 |
|---|---|---|
| PaddleOCR 全系（PP-OCRv6 / PaddleOCR-VL / PP-StructureV3 / PP-ChatOCRv4） | Apache-2.0 | ✅ 自由商用 |
| dots.ocr / DeepSeek-OCR | MIT | ✅ |
| GOT-OCR 2.0 / Granite-Docling | Apache-2.0 | ✅ |
| MinerU | 需逐版本确认 | ⚠️ 法务确认后使用 |

---

## 四、大模型 API 方案（"只要 key"）

### 4.1 支持情况

| 服务 | 模型 | 能否做 OCR | 关键限制 |
|---|---|---|---|
| **阿里云百炼** | `qwen-vl-ocr` | ✅ **专用 OCR 模型** | 国内 API 里中文最优选项，支持表格解析、公式、信息抽取 |
| **火山引擎** | 豆包视觉理解 | ✅ 通用视觉 | 最便宜 |
| **DeepSeek** | `deepseek-v4-flash-vision-exp`（2026-08-21 起支持图片） | ⚠️ 可读图但**不是确定性 OCR 引擎** | **图片被压到约 800×800**，A4 扫描件密集文字直接不可用 |
| **OpenAI GPT-5.x** | 视觉输入 | ⚠️ 能做但不专业 | 幻觉率高，贵，不返回文字坐标 |
| **Google Gemini 3.x** | 原生多模态 | ✅ 长文档最强，具备像素级定位与文档反渲染 | 数据出境合规问题 |
| **百度智能云 OCR** | 通用文字识别高精度版 | ✅ 传统 OCR API | 字库 2w+，按次计费，接入最简单 |

> 关于 DeepSeek 的重要澄清：DeepSeek **主线对话 API 的视觉能力不等于 OCR 服务**。真正能打的是它开源的 **DeepSeek-OCR / DeepSeek-OCR-2（3B）权重**，但那需要你自己用 vLLM 部署 —— 属于"自建"而非"给 key 就能用"。

### 4.2 价格对比（2026-09）

| 服务 | 单价 | 1000 张 A4 估算* |
|---|---|---|
| 豆包视觉理解 | 0.003 元/千 tokens | ~6 元 |
| qwen-vl-ocr | 0.006 元/千 tokens（输入输出同价） | ~12 元 |
| 百度 OCR 高精度版 | 0.019 元/次（10 万次包 2300 元 → 0.023 元/次） | 19~23 元 |
| **自建 PaddleOCR-VL（L40S）** | — | **~0.7 元**（按 10K 页 $7.27 折算） |
| AWS Textract | — | ~107 元（$15 / 10K 页） |

\* 按单页约 1000 输入 tokens + 1000 输出 tokens 粗估，实际随版面密度浮动。

**结论：自建的边际成本比最便宜的 API 还低约一个数量级。** 日均超过约 1 万页后，自建的经济性碾压 API；反过来说，日均几百页以内，直接买 API 更划算。

### 4.3 API 的正确用法

不是"要不要用 API"，而是**用在哪**：

- ✅ **第 1 周快速验证**：先用 `qwen-vl-ocr` 跑通业务链路，自建环境并行搭建
- ✅ **难例兜底**：自建引擎置信度低于阈值 → 转发 API → 结果入库作为后续微调语料
- ✅ **交叉校验**：抽样 1~5% 流量双跑，监控自建引擎质量漂移
- ❌ **不要**当主力：成本、延迟、限流、数据出境四重风险

---

## 五、推荐架构（内部服务器 / 高并发 / 爬虫）

```
                    ┌──────────────┐
   爬虫集群 ───────► │  抓取产出     │  图片 URL / PDF 落 MinIO(S3)
 (Scrapy/Playwright) └──────┬───────┘
                            │ 只投递「对象引用」，不传 base64
                            ▼
                    ┌───────────────┐
                    │  Redis Stream │  ocr:tasks（按优先级分队列）
                    │  / RabbitMQ   │
                    └──────┬────────┘
              ┌────────────┴────────────┐
              ▼                         ▼
   ┌─────────────────────┐   ┌──────────────────────┐
   │ Fast Worker × N     │   │ VL Worker × M        │
   │ PP-OCRv6_medium     │   │ PaddleOCR-VL-1.6     │
   │ (CPU/GPU, 无状态)    │   │ vLLM 连续批处理       │
   └──────────┬──────────┘   └──────────┬───────────┘
              │  低置信度 / 检出表格版面   │
              └────────────►─────────────┘
                            │  仍低置信 且 高价值
                            ▼
                    ┌───────────────┐
                    │  云 API 兜底   │  qwen-vl-ocr
                    └──────┬────────┘
                           ▼
   ┌──────────────────────────────────────────┐
   │ 结果层：PostgreSQL(结构化) + ES(全文检索)  │
   │ 缓存：Redis，key = sha256(图片字节)        │
   └──────────────────────────────────────────┘
                           ▲
                   ┌───────┴────────┐
                   │  FastAPI 网关   │ 同步 /ocr、异步 /ocr/async + /result/{id}
                   └────────────────┘
```

### 高并发关键点

1. **网关与推理解耦**：FastAPI 只做鉴权、限流、入队、查结果，绝不在 HTTP 线程里跑推理。
2. **内容寻址缓存**：`sha256(图片字节)` 做 key。爬虫场景重复图极多，命中率通常 30~60%，是性价比最高的一项优化。
3. **Fast Worker 横向扩**：PP-OCRv6 无状态，CPU 容器直接按队列长度做 K8s HPA。Medium 档 Xeon 上 1.40s/图，单核约 0.7 QPS，40 核机器约 25 QPS。
4. **VL Worker 用 vLLM**：
   - `--enable-chunked-prefill`：长文档吞吐与响应速度显著提升
   - Flash Attention backend：加速并降显存
   - KV cache 约 5.5 GiB 时可支撑约 20 并发度（约 3200 万 token 容量）
   - 重复模板（发票、表单、同站页面）改用 **SGLang + RadixAttention 前缀缓存，吞吐再 +20~40%**
5. **路由策略**（直接决定整体成本）：
   ```
   图片短边 < 1000 且无表格版面   → Fast
   PDF / 检出表格、公式、多栏      → VL
   Fast 平均置信度 < 0.75         → 升级到 VL
   VL 仍低置信 且 业务标记高价值   → 云 API
   ```
6. **背压**：队列长度超阈值时网关直接返回 429 + `Retry-After`，别让爬虫把 OCR 打爆。
7. **爬虫侧配合**：先做感知哈希去重、尺寸过滤（小于 100×100 直接丢弃）、格式归一（统一转 JPEG/PNG），通常能砍掉 20~40% 无效请求。

### 部署命令参考

```bash
# 快通道
pip install paddleocr
paddleocr ocr -i image.png --lang ch
```

```bash
# 精修通道（PaddleX 前置服务 :8000，内部调 vLLM 后端）
paddlex --install serving
paddlex --serve --pipeline PaddleOCR-VL.yaml
```

---

## 六、硬件建议

| 规模 | 配置 | 预估能力 |
|---|---|---|
| Demo / 验证 | 1 台 16 核 CPU，无 GPU，跑 RapidOCR 或 PP-OCRv6 | ~10 QPS 纯文本 |
| 生产起步 | 1× L40S / A10 / 4090(24G) + 32 核 CPU | Fast 20~25 QPS + VL ~45 页/分钟 |
| 规模化 | 2~4× L40S，vLLM 多实例 + K8s | 近线性扩展，10K 页成本约 ¥50 |

> PaddleOCR-VL 本体只要约 2GB 显存，一张 24G 卡可以跑多实例，或同时承载 Fast + VL 两条通道。

---

## 七、评测方案（"全方位评估"落地）

自建 OCR 最大的坑是**没有自己的评测集**，只信公开榜单。建议：

1. **构造内部评测集**（200~500 张，人工标注 ground truth），按业务分层：
   - 印刷体中文长文（新闻、公告）
   - 中英混排 / 代码 / 数字金额
   - 表格（含合并单元格、无线表）
   - 截图类（UI、聊天记录、带水印图）
   - 低质图（模糊、倾斜、反光、低分辨率）
   - 手写体、竖排、印章
2. **指标**：
   - 字符准确率 CAR = 1 − CER（编辑距离 / 总字符数）
   - 字段级准确率（业务关心的金额、日期、编号）
   - 表格 TEDS
   - P50 / P95 延迟、单页成本
3. **对比矩阵**：PP-OCRv6 / PaddleOCR-VL / RapidOCR / qwen-vl-ocr / 豆包 / 百度高精度，同一批图跑一遍出表。
4. **回归**：评测集进 CI，模型或参数变更必须跑一次，防止升级掉点。

---

## 八、落地路线图

| 阶段 | 周期 | 产出 |
|---|---|---|
| P0 Demo | 3~5 天 | Docker Compose 起 FastAPI + PP-OCRv6 + Redis 缓存，`/ocr` 单图接口 + 简易 Web 上传页 |
| P1 评测 | 1 周 | 内部评测集 + 自动化 benchmark 脚本，出对比表，定路由阈值 |
| P2 精修通道 | 1 周 | 接入 PaddleOCR-VL + vLLM，实现 Fast→VL 升级路由，PDF→Markdown |
| P3 生产化 | 1~2 周 | 队列化 + K8s + Prometheus 监控（QPS / 延迟 / 置信度分布 / 队列深度）+ 云 API 兜底 |
| P4 优化 | 持续 | 难例回流、领域微调（PP-OCRv6 支持自定义字典与微调）、SGLang 前缀缓存 |

---

## 九、参考来源

- [PaddleOCR 官方文档](http://www.paddleocr.ai/latest/en/index.html) ／ [GitHub](https://github.com/PaddlePaddle/PaddleOCR)
- [PP-OCRv6 算法文档](https://github.com/PaddlePaddle/PaddleOCR/blob/main/docs/version3.x/algorithm/PP-OCRv6/PP-OCRv6.md)
- [PaddleOCR-VL on Hugging Face](https://huggingface.co/PaddlePaddle/PaddleOCR-VL)
- [Best Open-Source OCR Models in 2026, Ranked by Benchmark — Roboflow](https://blog.roboflow.com/best-open-source-ocr-models/)
- [Best Open-Source OCR and Document VLMs to Self-Host on GPU Cloud in 2026 — Spheron](https://www.spheron.network/blog/best-open-source-ocr-vlm-self-host-gpu-cloud-2026/)
- [PaddleOCR 3.0 Technical Report (arXiv)](https://arxiv.org/pdf/2507.05595)
- [RapidOCR GitHub](https://github.com/rapidai/rapidocr)
- [DeepSeek-OCR GitHub](https://github.com/deepseek-ai/DeepSeek-OCR)
- [qwen-vl-ocr 使用文档 — 阿里云百炼](https://help.aliyun.com/zh/model-studio/qwen-vl-ocr) ／ [模型价格](https://help.aliyun.com/zh/model-studio/model-pricing)
- [火山方舟模型价格](https://docs.volcengine.com/docs/82379/1544106?lang=zh)
- [百度智能云 OCR 价格](https://cloud.baidu.com/product-price/ocr.html)
- [vLLM 部署 PaddleOCR-VL 教程](https://docs.vllm.ai/projects/ascend/zh-cn/v0.13.0/tutorials/PaddleOCR-VL.html)
- [PaddleOCR-VL 部署备忘录](https://blog.useforall.com/posts/paddleocr-vl-deployment-memo/)
- [DeepSeek V4 Flash Vision — 图像输入与限制](https://omniakey.com/blog/deepseek-v4-flash-vision-exp)

---

## 十、128 核 CPU 服务器专项方案

若部署目标为 128 核大内存 CPU 服务器（无 GPU），本报告第一章的双引擎方案需调整为单引擎：**PaddleOCR-VL 通道必须砍掉**（自回归 VLM 在纯 CPU 上不可行），改由 PP-StructureV3 补位版面/表格。

详见 [128核CPU服务器专项方案.md](128%E6%A0%B8CPU%E6%9C%8D%E5%8A%A1%E5%99%A8%E4%B8%93%E9%A1%B9%E6%96%B9%E6%A1%88.md)。

> 最终部署方案（4× RTX 5090 + 128 核）见 [4卡5090部署方案.md](4%E5%8D%A15090%E9%83%A8%E7%BD%B2%E6%96%B9%E6%A1%88.md)。
