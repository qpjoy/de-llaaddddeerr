```bash
# 预检并生成计划 → 执行计划
MX_INSIGHT_HUB_DEPLOY=0 bash scripts/manage.sh ops internal-production deploy


TMPDIR=/data/tmp \
MX_PAY_BUILD_PROXY=http://127.0.0.1:7789 \
bash scripts/manage.sh deploy
```