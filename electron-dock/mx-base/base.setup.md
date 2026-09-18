# OCR 服务
```bash
BIND=0.0.0.0 bash scripts/manage.sh deploy mx-ocr
# .env
# BIND=0.0.0.0
```

# Embedding 服务
```bash
# 注意这里的ip是docker的ip，192.168.1.2也不行
bash scripts/manage.sh deploy mx-embedding \
  --proxy http://172.17.0.1:7788

# key
electron-dock/mx-base/mx-embedding/secrets/api-key

# 在 LLM Provider → Embedding Provider Catalog → 新建 Provider 中填写：
# 字段	填写值
# ID	mx-local-embedding
# 显示名称	本机 Qwen3 Embedding
# 连接来源	独立配置
# 协议	OpenAI-compatible
# Base URL	http://127.0.0.1:18210/v1
# 模型	Qwen/Qwen3-Embedding-0.6B
# 维度	512
# 鉴权	Bearer
# API Key	mx-embedding 已生成的 Key
# 超时	先保持 60000 ms
```