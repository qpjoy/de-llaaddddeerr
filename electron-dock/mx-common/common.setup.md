```bash
# 配置 HanLP
bash scripts/manage.sh deploy hanlp

# HanLP状态
kubectl -n mx-common get deployment/mx-common-hanlp
kubectl -n mx-common get pods -o wide | grep hanlp

kubectl -n mx-common get service/mx-common-hanlp
kubectl -n mx-common get endpoints/mx-common-hanlp
kubectl -n mx-common rollout status deployment/mx-common-hanlp

# hanlp重建后查看稳定性
kubectl -n mx-common get pods -l app.kubernetes.io/name=mx-common-hanlp

# hanLP占用
kubectl -n mx-common describe pod -l app.kubernetes.io/name=mx-common-hanlp | grep -A 12 "Last State\|Containers:\|Limits\|Requests"

# 调用hanLP分词
kubectl -n mx-insight-hub exec deployment/mx-insight-hub-admin -- node -e "const b='http://mx-common-hanlp.mx-common.svc.cluster.local:8000';(async()=>{const h=await fetch(b+'/health');console.log('health',h.status,await h.text());const t=await fetch(b+'/tokenize',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({text:'吴恩达与人工智能',coarse:true})});console.log('tokenize',t.status,(await t.text()).slice(0,200))})()"

# 查看hanLP seed manifest
docker run --rm --entrypoint sh mx-common-hanlp:local -c 'wc -c /opt/hanlp-model-seed/.mx-common-manifest.sha256; du -sh /opt/hanlp-model-seed'


# 迁移common pvc
bash scripts/manage.sh relocate --confirm

```