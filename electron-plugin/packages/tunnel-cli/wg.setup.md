# wg services

```bash
# Server
qp-tunnel-cli wg preflight --server --subnet 100.127.50.0/24

qp-tunnel-cli wg install \
  --host <AWS_ELASTIC_IP> \
  --subnet 100.127.50.0/24 \
  --port-range 20000-20100
  
#  --dns '1.1.1.1, 8.8.8.8, 172.31.0.2'

qp-tunnel-cli wg create internal-01 --ip 100.127.50.10

# Client
qp-tunnel-cli wg enroll --file internal-01.conf
qp-tunnel-cli wg rotate-port

qp-tunnel-cli wg enroll --file internal-01.conf --force

## Client 重新设置ip和端口
Endpoint = <AWS_EIP>:<新端口>
qp-tunnel-cli wg restart --client


# 检查服务
iptables -S | grep qp-wg-mx
iptables -t nat -S | grep qp-wg-mx
wg show qpwgs-mx
```