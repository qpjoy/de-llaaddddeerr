```bash
PROXY=127.0.0.1:7788 bash scripts/manage.sh deploy mx-launcher


# dataport解锁
KUBECONFIG=/etc/kubernetes/admin.conf \
bash mx-dataport/scripts/manage.sh ops internal-production recover-lock
```