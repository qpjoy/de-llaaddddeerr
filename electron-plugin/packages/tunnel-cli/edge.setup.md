```bash
install -d -m 700 -o "$(id -un)" /var/lib/qp-tunnel/edge

apt-get install -y wireguard-tools

qp-tunnel-cli edge add domestic02 --host 47.97.46.168 --user root --key ~/.ssh/<私钥> --role domestic

# 默认 --plan launcher 10.88.88.88 递增
# --plan isolated 就是 100.127.200.0/24
qp-tunnel-cli edge setup

```