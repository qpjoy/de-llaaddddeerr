1. 在 O 上部署执行面
O 上拉最新代码后：

cd ~/workspace/de-llaaddddeerr

# 如果 O 还没部署 hysteria2-mihomo-stack
sudo bash ./docker/hysteria2-mihomo-stack/manage.sh setup
setup 里重点填：

Hysteria public host/IP: O 的公网 IP 或域名
Hysteria UDP port/range: 52120-52159
Mihomo routing mode: cn-direct
初始 users 随便填也行，后面会被 D 的 Tunnel 控制面同步覆盖。以后用户以 D 数据库为准，不再手动维护 O 的 users.csv。

2. 在 O 上启动 runner

cd ~/workspace/de-llaaddddeerr

sudo HDO_GATEWAY_RUNNER_HOST=0.0.0.0 \
  HDO_GATEWAY_RUNNER_PORT=18081 \
  ./electron-server/scripts/manage.sh gateway-runner-start

sudo ./electron-server/scripts/manage.sh gateway-runner-status
sudo cat ./electron-server/data/hdo-gateway-runner.token
记下这个 token，等会填到 D 后台。

3. O 的安全组 / 防火墙
需要开放：

UDP 52120-52159     对客户端开放，给 Hysteria2 用
TCP 18081           只允许 D 的公网 IP 访问，给 D 调 O runner 用
不建议把 18081 对全网开放。3434 订阅端口可以不开放，因为现在订阅由 D 发，客户端流量直接连 O。

4. D 后台 Tunnel 页面填写 O
你截图里这个表单这样填：

名称: oversea-1
公网 IP / 域名: O 的公网 IP 或域名
Hysteria2 UDP 端口: 52120-52159
Runner URL: http://O的公网IP:18081
Runner Token: O 上 cat 出来的 hdo-gateway-runner.token
注意：默认的 http://host.docker.internal:18081 只适合 runner 在 D 本机，不适合远程 O。远程 O 必须改成 http://O_IP:18081 或内网/VPC 地址。

然后点：

保存节点
保存策略
发放 TUNNEL
发放后还没有真正写入 O，最后要在下面“节点”表格里点该节点右侧的“同步”按钮。同步成功后状态应变成 online，同步列类似 1 / 1。

5. 验证 D 能连 O
如果后台同步失败，先在 D 服务器上测：

curl -fsS \
  -H "Authorization: Bearer <O_RUNNER_TOKEN>" \
  http://<O_IP>:18081/healthz
如果 D host 能通，但后台点同步失败，再进 D 的 market 容器测：

docker exec -it qpjoy-market node -e "fetch('http://<O_IP>:18081/healthz',{headers:{authorization:'Bearer <O_RUNNER_TOKEN>'}}).then(async r=>console.log(r.status,await r.text())).catch(e=>{console.error(e);process.exit(1)})"
6. 客户端使用
发放账号后，账号表里会出现 D 生成的订阅 URL：

http://D_IP:8080/api/v1/tunnel/subscriptions/<token>/mihomo.yaml
客户端 tunnel 插件导入这个 URL 即可。拉订阅经过 D，但订阅内容里的 server 是 O，所以代理流量是：

客户端 -> O Hysteria2
不是：

客户端 -> D -> O
一个关键点：每次在 D 上新增账号、轮换 token、改节点/端口/策略后，都要点一次节点“同步”，否则 D 发出的订阅和 O 上允许登录的用户会不一致。