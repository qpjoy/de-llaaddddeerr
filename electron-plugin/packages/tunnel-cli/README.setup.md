```bash
npm i -g @qpjoy/tunnel-cli@0.1.4
HDO_PASSWORD='...' qp-tunnel-cli hdo enroll --server-url 'https://domestic.example.com' --username internal-i

qp-tunnel-cli install --url 'http://user:pass@host:3434/peer_xxx.mihomo.yaml'

sudo qp-tunnel-cli install-script
sudo qp-tunnel-cli upgrade-systemd
sudo qp-tunnel-cli server-on

sudo qp-tunnel-cli tun-off
sudo qp-tunnel-cli server-on
sudo qp-tunnel-cli status

qp-tunnel-cli curl google.com
```
