```bash
PROXY=127.0.0.1:7788 bash scripts/manage.sh deploy mx-launcher


# dataport解锁
KUBECONFIG=/etc/kubernetes/admin.conf \
bash mx-dataport/scripts/manage.sh ops internal-production recover-lock


PROXY=127.0.0.1:7788 bash scripts/manage.sh deploy mx-launcher
# hub依赖
# PROXY=127.0.0.1:7788 bash electron-dock/mx-common/scripts/manage.sh deploy hanlp
PROXY=127.0.0.1:7788 bash scripts/manage.sh deploy mx-insight-hub
# 采集 runner：在 Hub 之后、用同一 PROXY；只在 runner 代码或交付包变化时发布
PROXY=127.0.0.1:7788 bash scripts/manage.sh deploy mx-crawler-runner
PROXY=127.0.0.1:7788 bash scripts/manage.sh deploy mx-dataport
PROXY=127.0.0.1:7788 bash scripts/manage.sh deploy mx-device
PROXY=127.0.0.1:7788 bash scripts/manage.sh deploy mx-pay
```

```bash
# 开机自启动
bash scripts/manage.sh plan all
bash scripts/manage.sh boot audit
bash scripts/manage.sh boot install
bash scripts/manage.sh boot verify
systemctl is-enabled mx-boot-verify.service
```