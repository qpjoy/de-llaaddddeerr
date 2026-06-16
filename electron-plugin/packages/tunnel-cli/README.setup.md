```bash
npm i -g @qpjoy/tunnel-cli@0.1.9
qp-tunnel-cli hdo enroll --internal-url 'http://127.0.0.1:18090' --product-id h2o --identity-kind anonymous --lease-only
HDO_PASSWORD='...' qp-tunnel-cli hdo enroll --server-url 'https://domestic.example.com' --internal-url 'http://127.0.0.1:18090' --product-id h2o --username internal-i

qp-tunnel-cli install --url 'http://user:pass@host:3434/peer_xxx.mihomo.yaml'
# Domestic bootstrap can use an Internal-pushed local YAML before WG relay reaches Internal.
qp-tunnel-cli install --file '/opt/mx/current/qp-tunnel-cli/domestic-bootstrap-subscription.yaml'

sudo qp-tunnel-cli install-script
sudo qp-tunnel-cli upgrade-systemd
sudo qp-tunnel-cli egress-on

sudo qp-tunnel-cli tun-off
sudo qp-tunnel-cli egress-on
sudo qp-tunnel-cli status

qp-tunnel-cli curl google.com

# 删除mac的HDO进程
qp-tunnel-cli hdo down --interface hdo-client
```
