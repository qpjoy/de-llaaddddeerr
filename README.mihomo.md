```bash
# 1. 先备份和做基线。
cd /你的项目目录
cp docker/wg-mihomo-stack/.env.example docker/wg-mihomo-stack/.env
sudo bash ./scripts/check-vpn-stack.sh | tee /root/vpn-pre.txt

# 2. 把 docker/wg-mihomo-stack/.env 先改成最小测试版。

WG_SERVER_HOST=你的公网IP
WG_SERVER_PORT=52080

WG_STACK_SUBNET=10.253.0.0/24
WG_STACK_GATEWAY=10.253.0.1

WG_PEERS=test01
WG_PEER_DNS=1.1.1.1,8.8.8.8
WG_INTERNAL_SUBNET=10.13.13.0
WG_ALLOWEDIPS=0.0.0.0/0
WG_KEEPALIVE_PEERS=all
WG_LOG_CONFS=false

WG_EXPORT_SITE_ADDRESS=:8080
WG_EXPORT_BASE_URL=http://你的公网IP:3434
WG_EXPORT_FALLBACK_PORT=3434
WG_EXPORT_USER=download
WG_EXPORT_PASSWORD_HASH=这里填 caddy 哈希

# 3. 先生成订阅登录密码哈希。
docker run --rm caddy:2-alpine caddy hash-password --plaintext '你自己的强密码'
docker run --rm caddy:2-alpine caddy hash-password --plaintext '你的强密码'
## 编辑 docker/wg-mihomo-stack/.env 
## 重点是这一行必须用单引号包住整个哈希：
WG_EXPORT_PASSWORD_HASH='$2a$14$xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx'

# 4. 先只启动 subscriptions，不要起 wireguard。
cd /你的项目目录/docker/wg-mihomo-stack
docker-compose up -d subscriptions
curl -I http://127.0.0.1:3434/healthz
sudo bash /你的项目目录/scripts/check-vpn-stack.sh | tee /root/vpn-after-subscriptions.txt

# 5. 
cd /你的项目目录/docker/wg-mihomo-stack
docker-compose up -d wireguard

# 6. 测试
docker-compose logs --tail=100 wireguard
sudo ss -lunp | grep 52080
docker exec wg-mihomo-wireguard wg show
sudo bash /你的项目目录/scripts/check-vpn-stack.sh | tee /root/vpn-after-wg.txt

# 7. 导出 Mihomo YAML，并验证订阅能拿到。
cd /你的项目目录
bash ./scripts/export-wg-mihomo-stack.sh
curl -u download:你的明文密码 http://127.0.0.1:3434/peer_test01.mihomo.yaml

# 8. 用一台外部机器只导入 test01.mihomo.yaml 测试。
## 在服务器侧同时看：
docker exec wg-mihomo-wireguard wg show

# 9. 测试通过后，再把 .env 里的 WG_PEERS= 扩成多人，然后重新生成。
cd /你的项目目录/docker/wg-mihomo-stack
docker-compose up -d wireguard

cd /你的项目目录
bash ./scripts/export-wg-mihomo-stack.sh
```


# 限速
```bash
cd /root/workspace/qpjoy/de-lader-formal

cat > ./docker/wg-mihomo-stack/peer-limits.csv <<'EOF'
# name,cidr,down_rate,down_ceil,up_rate,up_ceil
test01,10.13.13.3/32,1mbit,9mbit,1mbit,9mbit
EOF

sudo bash ./scripts/wg-tc-limit.sh apply \
  --docker-container wg-mihomo-wireguard \
  --if wg0 \
  --ingress \
  --limits-file ./docker/wg-mihomo-stack/peer-limits.csv \
  --total-rate 9mbit \
  --ingress-total-rate 9mbit \
  --base-rate 1mbit

# 查看规则：
sudo bash ./scripts/wg-tc-limit.sh show \
  --docker-container wg-mihomo-wireguard \
  --if wg0

# 清理规则：
sudo bash ./scripts/wg-tc-limit.sh clean \
  --docker-container wg-mihomo-wireguard \
  --if wg0
```

# 新建用户
```bash
# 1. 新增用户时
## 改 .env 里的 WG_PEERS=...
# 2. 重建 WG 容器
cd /root/workspace/qpjoy/de-lader-formal/docker/wg-mihomo-stack
docker-compose up -d wireguard
# 3. 重新导出订阅
cd /root/workspace/qpjoy/de-lader-formal
bash ./scripts/export-wg-mihomo-stack.sh
```