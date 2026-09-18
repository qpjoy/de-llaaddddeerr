# mx-embedding

独立 GPU 文本向量服务，固定模型 `Qwen/Qwen3-Embedding-0.6B`，提供 Hub 可调用的 OpenAI-compatible `POST /v1/embeddings`。不运行 Chat，不持有 Hub 数据库凭据，不参与 MX-H2I 登录、网络或 Hub readiness。

## 默认配置

| 项目 | 默认 |
| --- | --- |
| GPU | 1，OCR 用 2，显示器保留 3；均可在 `../.env.gpu` 调整 |
| 模型版本 | `97b0c614be4d77ee51c0cef4e5f07c00f9eb65b3` |
| 精度 / 输出 | BF16 / 512 维，截取模型前 512 维后重新 L2 归一化 |
| 输入限制 | 每条 2048 token、每请求最多 16 条、合计最多 8192 token |
| 推理 | 单进程、单次 GPU 推理；每个 micro-batch 最多 4 条 |
| 资源 | 4 CPU / 8 GiB 主存；PyTorch allocator 最多使用所选卡显存的 25% |
| 缓存 | `/srv/mx-embedding/models` → `/models`，停止后保留 |
| 监听 | `127.0.0.1:18210`，Bearer API Key |

25% 是 PyTorch allocator 上限，不是 GPU 硬隔离、不是预分配，也不包含所有驱动/context 开销。默认先分卡运行。输入超长返回 413，**不静默截断**；超并发返回 429 + Retry-After。提高输入长度、批量或资源后需重新验收。当前无跨请求合批，因此两个 Hub Worker 不一定能喂满 GPU。

容器使用已核对存在的 `pytorch/pytorch:2.7.1-cuda12.8-cudnn9-runtime`（Linux amd64），通过 Transformers 原生 Qwen3 与 SDPA 推理，不依赖额外 FlashAttention 编译包。启动时真实执行一次 CUDA forward，成功后才对外就绪；没有 CPU fallback。服务器需提供支持该 GPU/CUDA 组合的驱动与 NVIDIA Container Toolkit。本机测试不能替代 5090 验收。

## 部署和开关

在目标 GPU 主机的 `electron-dock/mx-base` 目录：

```bash
cp .env.gpu.example .env.gpu                 # 仅首次；已有配置不要覆盖
cp mx-embedding/.env.example mx-embedding/.env
bash scripts/manage.sh doctor mx-embedding
bash scripts/manage.sh deploy mx-embedding
bash scripts/manage.sh test mx-embedding     # 显式调用真实模型进行验收
bash scripts/manage.sh stats mx-embedding
bash scripts/manage.sh stop mx-embedding     # 释放运行资源，缓存/Key 保留
bash scripts/manage.sh start mx-embedding    # 使用已保存的容器配置，无构建/拉取
```

deploy 执行前要求输入完整的 `yes`，其他输入或 EOF 取消；重复执行由 Compose 更新同一服务，可能发生短暂中断，不保证自动回滚。首次 deploy 创建 `secrets/api-key`，重复部署不轮换。需要 Docker Compose v2、Python 3、Linux flock、openssl。缓存目录应放在有容量的模型盘；API 容器以 root 加载只读 secret，capabilities 全部移除。不能把 1.2 GB 模型文件视为总磁盘需求：运行镜像、下载/编译缓存另需空间；PG/ES 向量存储仍在 Hub 数据盘。

修改配置后使用 `deploy` 应用；`restart` 只重启保存的配置。GPU 改动后普通 start/restart 会拒绝旧 UUID，要求重新部署。两服务部署操作通过主机 `/var/lock/mx-base-gpu.lock` 串行化，同一主机应由同一运维用户执行；不要直接 `docker compose up` 绕过启动检查。首次拉取可能耗时，日志不代表健康，默认等待最多 30 分钟。

国内下载可以设置可信的 Hugging Face-compatible `MX_EMBEDDING_HF_ENDPOINT`，或将**完整模型快照**预先放到模型缓存目录下，设置 `MX_EMBEDDING_MODEL_PATH=/models/<目录>`。离线快照必须与上面的固定版本一致；服务不验证整个快照的文件摘要，运维需核对来源。不要把普通 Chat 模型放在这个目录。代理仅通过 `MX_EMBEDDING_PROXY` 传给本容器；不会修改宿主机代理。

## Hub 接入

本次只提供可调用服务和配置说明，**不自动改 Hub Provider/默认 Sequence、索引维度、预算、Worker 数或启动历史向量化**。

1. Hub 不在本机网络命名空间时，`127.0.0.1` 指向 Hub 自己。将 `MX_EMBEDDING_BIND` 配为 GPU 服务器上 Hub 可达的受控内网地址，并重新部署。不同服务器使用已有内网链路；不要为接入修改 MX-H2I VPN/DNS。
2. Hub → Agent 中心 → Embedding Provider：协议 OpenAI-compatible；Base URL 为 `http://<GPU服务器内网地址>:18210/v1`；模型为 `Qwen/Qwen3-Embedding-0.6B`；维度 `512`；API Key 使用 `mx-embedding/secrets/api-key` 内容。
3. 做真实连接验证，再配置 Embedding Sequence 并显式设为业务默认。Hub 服务端与 ES 向量索引也必须支持该模型空间和 512 维；不是只改 Provider 下拉框即可。
4. 在数据中心确认就绪、容量和额度后，由操作员显式启动向量化。自建模型仍受 Hub 的本地 token 预算约束，预算不是供应商账单。

标准请求（Hub 当前发送的形状）：

```json
{"model":"Qwen/Qwen3-Embedding-0.6B","input":["商品售后拒绝退款","物流延迟"]}
```

返回 `object:list`、按输入顺序排列的 `data[{index,embedding}]`、模型名称和 tokenizer 实际 `usage`。`dimensions` 可省略；如提供，必须与服务固定维度相同。`encoding_format` 仅支持 `float`。

可选 `input_type:"query"` 会按照 Qwen 官方建议添加查询指令；省略时为 `document`，正文不加指令。**当前 Hub 不发送 input_type，查询与正文均走无指令基线；本次不通过文本长度、batch 大小等猜测请求类型。** 若要启用查询指令，需后续在 Hub 明确区分 query/document，再测检索质量。不能把本次称为已完成指令优化的端到端验收。

1024 维可通过 `MX_EMBEDDING_DIMENSIONS=1024` 显式选择，部署后在空的测试索引比较召回效果。不要在已有 512 维索引上直接切换；模型、revision、维度或预处理策略变化需评估重算与索引迁移。

## 接口和验证

- `GET /healthz`：无鉴权，仅就绪状态。
- `GET /v1/models`、`GET /api/info`、`POST /v1/embeddings`：均要求 Bearer Key。
- `GET /api/info`：维度、输入限制、成功/失败请求、实际 token 与累计处理耗时；不含 Key、输入正文。
- `scripts/manage.sh test`：从容器内读取 Key，检查真实向量顺序、维度、有限值及归一化，不打印 Key 或输入向量。

本地回归：`python3 -m unittest discover -s mx-embedding/tests -v`，需要 PyTorch、FastAPI/Pydantic/httpx；API 测试使用明确的假引擎，不加载模型。真实 GPU 验收还需记录冷启动、显存峰值、稳定吞吐、Hub 查询召回和 OCR 并行负载，不能承诺两天全库完成。

参考：[Qwen 模型与查询指令](https://huggingface.co/Qwen/Qwen3-Embedding-0.6B)、[PyTorch Blackwell/CUDA 12.8 支持](https://pytorch.org/blog/pytorch-2-7/)。
