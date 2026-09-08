```bash
openssl rand -hex 32

# bash scripts/manage.sh admin-token

# 状态，临时出口
kubectl -n mx-auto get pods,svc,pvc
kubectl -n mx-auto port-forward service/mx-auto-server 8790:80

# 一键部署
bash scripts/manage.sh deploy
```