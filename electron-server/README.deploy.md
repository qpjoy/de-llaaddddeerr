```bash
cd electron-server
MARKETPLACE_ALLOWLIST='@qpjoy/electron-plugin-tunnel,@qpjoy/electron-plugin-notyet,@qpjoy/electron-game-suduku' ./scripts/manage.sh redeploy
./scripts/manage.sh sync


pnpm --dir electron-market install --frozen-lockfile=false
pnpm --dir electron-market --filter @qpjoy/electron-market-admin-ui build
./scripts/manage.sh server redeploy


./scripts/manage.sh deploy hdo
# domestic 公网 IP/域名: 121.43.253.179
# HDO / 插件市场 server URL: http://121.43.253.179:8080
# WireGuard UDP 端口: 51888
# domestic overlay IP: 100.88.0.1

wg show hdo-home
systemctl status wg-quick@hdo-home --no-pager

# sync domestic peers
./docker/hdo-gateway-stack/manage.sh sync-domestic-peers --server-url http://127.0.0.1:8080


# update
pnpm --filter @qpjoy/electron-market-admin-ui build
pnpm --filter @qpjoy/electron-market build
pnpm --dir electron-server build
./electron-server/scripts/manage.sh redeploy

# ReBorn
cd /root/workspace/de-llaaddddeerr
./electron-server/scripts/manage.sh nuke
sudo systemctl disable --now wg-quick@hdo-home || true
sudo rm -f /etc/wireguard/hdo-home.conf /etc/sysctl.d/99-hdo-forwarding.conf
sudo iptables -D DOCKER-USER -i hdo-home -o hdo-home -j ACCEPT 2>/dev/null || true
sudo iptables -D FORWARD -i hdo-home -o hdo-home -j ACCEPT 2>/dev/null || true
rm -rf docker/hdo-gateway-stack/data/wireguard docker/hdo-gateway-stack/.env
./electron-server/scripts/manage.sh up
./electron-server/scripts/manage.sh bootstrap-admin
```
## 在 部署 tab 按顺序：

1. 运行 Domestic WireGuard gateway
2. 到 Mesh 创建 mesh，确认 CIDR 和 Domestic 网关转发
3. 到 许可 给用户加入 mesh
4. 用户在 Mac/Windows 客户端登录，点 连接 / 更新 HDO
5. 回后台 部署 点 同步并修复 D peers / routes
6. 点 查看 D 网关状态，确认 allowed-ips 里有 100.89.0.11/32 和 100.89.0.12/32
7. 客户端互 ping / 访问服务验证