```bash
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
```