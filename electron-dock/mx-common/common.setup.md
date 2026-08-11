```bash
# 配置 HanLP
bash scripts/manage.sh deploy hanlp

# HanLP状态
kubectl -n mx-common get deployment/mx-common-hanlp
kubectl -n mx-common get pods -o wide | grep hanlp

kubectl -n mx-common get service/mx-common-hanlp
kubectl -n mx-common get endpoints/mx-common-hanlp
kubectl -n mx-common rollout status deployment/mx-common-hanlp
```