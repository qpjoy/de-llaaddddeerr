```bash
# 推送机（装了 tunnel-cli 的服务器）
npm i -g @qpjoy/tunnel-cli
sudo install -d -m 700 -o "$(id -un)" /var/lib/qp-tunnel/edge   # 首次

# 一条命令：保存主机、推送 hy2 服务端、本机起 127.0.0.1:7891、检查
qp-tunnel-cli hy2 up oversea-1 --host 203.0.113.10 --key ~/.ssh/<私钥>
# 只有密码：不带 --key，在终端里按提示用密码登录一次

# 国内推送机取引擎慢时
MIHOMO_NPM_REGISTRY=https://registry.npmmirror.com qp-tunnel-cli hy2 up oversea-1 --host 203.0.113.10

# 应用使用
curl -x http://127.0.0.1:7891 http://api.ipify.org/
HTTPS_PROXY=http://127.0.0.1:7891 HTTP_PROXY=http://127.0.0.1:7891 <命令>

# 日常
qp-tunnel-cli hy2 status
qp-tunnel-cli hy2 test oversea-1
qp-tunnel-cli hy2 push oversea-1 --rotate-password     # 换密码；--port 8443 / --obfs / --new-cert
qp-tunnel-cli hy2 export oversea-1 --format uri         # 给手机/桌面客户端
qp-tunnel-cli hy2 disconnect oversea-1                  # 只删本机实例
qp-tunnel-cli edge status oversea-1 --health            # 目标机
```

云安全组放行服务端 UDP 端口（默认 443，被占用时会自动换并打印）。
7788（默认实例 / MX-H2I）和 7890（subscriptions）不会被使用。
