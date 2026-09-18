# OCR 服务
```bash
BIND=0.0.0.0 bash scripts/manage.sh deploy mx-ocr
# .env
# BIND=0.0.0.0
```

# Embedding 服务
```bash
MX_EMBEDDING_PROXY=http://192.168.1.2:7788 \
bash scripts/manage.sh deploy mx-embedding
```