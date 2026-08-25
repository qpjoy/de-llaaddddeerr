# openvpn qp-tunnel-cli

```bash
# --instance 是多台示例，默认mx
qp-tunnel-cli open preflight --server --subnet 100.127.0.0/24
qp-tunnel-cli open install --host <公网IP> --port-range 20000-20100
# --oversea是具备海外网络能力
qp-tunnel-cli open create internal-01 --ip 100.127.0.10 --oversea

# 生成ovpn
qp-tunnel-cli open preflight --file internal-01.ovpn
qp-tunnel-cli open enroll --file internal-01.ovpn && qp-tunnel-cli open doctor
# 强制更新文件
qp-tunnel-cli open enroll --file ~/internal-06.ovpn --force

# 重启服务
systemctl enable qp-openvpn-client@mx && systemctl restart qp-openvpn-client@mx

# 验收
qp-tunnel-cli open reachable


# 重新设置端口
sudo qp-tunnel-cli open install --force --port 443 --port-range 20000-20100
# 删除
qp-tunnel-cli open revoke internal-01
# 重启
qp-tunnel-cli open restart --instance mx
systemctl enable --now qp-openvpn-server@mx.service && qp-tunnel-cli open status
# 日志
qp-tunnel-cli open logs


# 打开流量转发
qp-tunnel-cli open egress on

# Q&A
## ip和设置不一致，权限问题
chmod 0755 /etc/qp-openvpn-server/mx
```