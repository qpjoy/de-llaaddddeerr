sudo bash <<'EOF'
set -euo pipefail
umask 077

unit=wg-quick@qpwgs-mx.service
backup=$(mktemp -d /root/wg-mx-reinstall.XXXXXX)

# 备份包含密钥，不要公开或贴回内容。
wg showconf qpwgs-mx > "$backup/runtime.conf"
iptables-save > "$backup/iptables.before"
ip -4 route show table all > "$backup/routes.before"
cp -a /etc/qp-wireguard/server/mx "$backup/managed-state"
echo "备份目录：$backup"

# 配置缺失时 stop 可能失败；随后定向删除残留接口。
systemctl disable "$unit"
if ! systemctl stop "$unit"; then
  echo "服务停止失败，继续清理已确认的孤立接口 qpwgs-mx。"
fi

if ip link show dev qpwgs-mx >/dev/null 2>&1; then
  ip link delete dev qpwgs-mx
fi

# 删除已确认属于该实例的规则；同时处理重复规则。
remove_rule() {
  local table="$1" chain="$2"
  shift 2
  while iptables -w 5 -t "$table" -C "$chain" "$@" 2>/dev/null; do
    iptables -w 5 -t "$table" -D "$chain" "$@"
  done
}

remove_rule filter INPUT \
  -p udp --dport 40002 \
  -m comment --comment qp-wg-mx -j ACCEPT

remove_rule filter FORWARD \
  -o qpwgs-mx -m conntrack --ctstate RELATED,ESTABLISHED \
  -m comment --comment qp-wg-mx -j ACCEPT

remove_rule filter FORWARD \
  -i qpwgs-mx \
  -m comment --comment qp-wg-mx -j ACCEPT

remove_rule nat POSTROUTING \
  -s 100.127.50.0/24 -o ens34 \
  -m comment --comment qp-wg-mx -j MASQUERADE

# 核验后才删除实例状态，避免丢失清理依据。
if ip link show dev qpwgs-mx >/dev/null 2>&1; then
  echo "接口仍存在，中止。" >&2
  exit 1
fi

iptables-save > "$backup/iptables.after"
if grep -Eq -- '--comment "?qp-wg-mx"? |qpwgs-mx' \
    "$backup/iptables.after"; then
  echo "仍有实例规则残留，请贴回相关规则；状态目录已保留。" >&2
  exit 1
fi

rm -f /etc/wireguard/qpwgs-mx.conf
rm -f /etc/sysctl.d/99-qp-wireguard-mx.conf
rm -rf /etc/qp-wireguard/server/mx
systemctl reset-failed "$unit"

echo "mx 服务端残留已清理，备份位于：$backup"
EOF