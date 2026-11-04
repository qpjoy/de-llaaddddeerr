```bash
PROXY=127.0.0.1:7788 bash scripts/manage.sh deploy mx-launcher


# dataport解锁
KUBECONFIG=/etc/kubernetes/admin.conf \
bash mx-dataport/scripts/manage.sh ops internal-production recover-lock


PROXY=127.0.0.1:7788 bash scripts/manage.sh deploy mx-launcher
# hub依赖
# PROXY=127.0.0.1:7788 bash electron-dock/mx-common/scripts/manage.sh deploy hanlp
PROXY=127.0.0.1:7788 bash scripts/manage.sh deploy mx-insight-hub
PROXY=127.0.0.1:7788 bash scripts/manage.sh deploy mx-dataport
PROXY=127.0.0.1:7788 bash scripts/manage.sh deploy mx-device
PROXY=127.0.0.1:7788 bash scripts/manage.sh deploy mx-pay
```