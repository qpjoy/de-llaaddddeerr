#!/bin/bash
# fix-routes.sh
# 用途：OpenVPN + WireGuard 共存
# 连 OpenVPN → 连 WireGuard → sudo ./fix-routes.sh

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
CONFIG_FILE="$SCRIPT_DIR/../config.env"

# ============ 加载配置 ============
if [ -f "$CONFIG_FILE" ]; then
    source "$CONFIG_FILE"
    echo "📂 已加载配置: $CONFIG_FILE"
else
    echo "❌ 配置文件不存在: $CONFIG_FILE"
    echo "请复制 config.env.example 为 config.env 并修改"
    exit 1
fi

echo "💾 备份..."
netstat -rn > "$HOME/.route_backup"

# ============ 检测网关 ============
echo ""
echo "🔍 检测网关..."
LOCAL_GW=""
for iface in en0 en1 en2; do
    GW=$(ipconfig getpacket "$iface" 2>/dev/null | grep "router" | awk '{print $3}' | tr -d '{}')
    if [ -n "$GW" ]; then
        LOCAL_GW="$GW"
        echo "  ✅ $iface: $LOCAL_GW"
        break
    fi
done
if [ -z "$LOCAL_GW" ]; then
    echo "  请输入 Wi-Fi 网关:"
    read LOCAL_GW
fi
echo "DEFAULT_GW=$LOCAL_GW" > "$HOME/.route_backup.env"

# ============ 检测接口 ============
echo ""
echo "🔧 检测接口..."
OVPN_IF=""
WG_IF=""
for utun in $(ifconfig -l | tr ' ' '\n' | grep utun); do
    ADDRS=$(ifconfig "$utun" 2>/dev/null | grep "inet " | awk '{print $2}')
    for addr in $ADDRS; do
        if [[ "$addr" == ${OPENVPN_SUBNET}.* ]]; then
            OVPN_IF="$utun"
            echo "  OpenVPN: $utun ($addr)"
        elif [[ "$addr" == ${WG_SUBNET}.* ]]; then
            WG_IF="$utun"
            echo "  WireGuard: $utun ($addr)"
        fi
    done
done
[ -z "$OVPN_IF" ] && echo "  ⚠️  OpenVPN 未检测到"
[ -z "$WG_IF" ]   && echo "  ❌ WireGuard 未检测到" && exit 1

# ============ 设置路由 ============
echo ""
echo "🔧 设置路由..."

# 1. VPN 服务器走本地网关
sudo route delete -host "$OPENVPN_SERVER" 2>/dev/null || true
sudo route add -host "$OPENVPN_SERVER" "$LOCAL_GW"
echo "  ✅ $OPENVPN_SERVER → $LOCAL_GW"

sudo route delete -host "$VPS_IP" 2>/dev/null || true
sudo route add -host "$VPS_IP" "$LOCAL_GW"
echo "  ✅ $VPS_IP → $LOCAL_GW"

# 2. 公司内网走 OpenVPN
if [ -n "$OVPN_IF" ]; then
    sudo route delete -net 10.0.0.0/8 2>/dev/null || true
    sudo route add -net 10.0.0.0/8 -interface "$OVPN_IF"
    echo "  ✅ 10.0.0.0/8 → OpenVPN ($OVPN_IF)"

    sudo route delete -net 172.16.0.0/12 2>/dev/null || true
    sudo route add -net 172.16.0.0/12 -interface "$OVPN_IF"
    echo "  ✅ 172.16.0.0/12 → OpenVPN ($OVPN_IF)"

    sudo route delete -net 192.168.0.0/16 2>/dev/null || true
    sudo route add -net 192.168.0.0/16 -interface "$OVPN_IF"
    echo "  ✅ 192.168.0.0/16 → OpenVPN ($OVPN_IF)"
fi

# 3. 家庭 Wi-Fi（/24 比 /16 优先）
HOME_NET=$(echo "$HOME_NETWORK" | cut -d'/' -f1)
sudo route delete -net "$HOME_NETWORK" 2>/dev/null || true
sudo route add -net "$HOME_NETWORK" "$LOCAL_GW"
echo "  ✅ $HOME_NETWORK → $LOCAL_GW（Wi-Fi）"

# 4. WireGuard 子网（/24 比 /8 优先）
sudo route delete -net "${WG_SUBNET}.0/24" 2>/dev/null || true
sudo route add -net "${WG_SUBNET}.0/24" -interface "$WG_IF"
echo "  ✅ ${WG_SUBNET}.0/24 → WireGuard ($WG_IF)"

# 5. 关键：强制外网走 WireGuard（覆盖 OpenVPN 推送的路由）
sudo route delete -net 0.0.0.0/1 2>/dev/null || true
sudo route add -net 0.0.0.0/1 "$WG_GATEWAY"
echo "  ✅ 0.0.0.0/1 → WireGuard（外网）"

sudo route delete -net 128.0.0.0/1 2>/dev/null || true
sudo route add -net 128.0.0.0/1 "$WG_GATEWAY"
echo "  ✅ 128.0.0.0/1 → WireGuard（外网）"

# ============ 清理 ============
networksetup -setwebproxystate "Wi-Fi" off 2>/dev/null
networksetup -setsecurewebproxystate "Wi-Fi" off 2>/dev/null
networksetup -setsocksfirewallproxystate "Wi-Fi" off 2>/dev/null
sudo dscacheutil -flushcache 2>/dev/null
sudo killall -HUP mDNSResponder 2>/dev/null

# ============ 验证 ============
echo ""
echo "📋 关键路由:"
echo "-------------------------------------------"
netstat -rn | grep -E "^0/1|^128\.0/1|^default|${VPS_IP%.*}|${OPENVPN_SERVER%.*}|10\.|172\.1[6-9]|172\.2|172\.3[0-1]|192\.168" | head -25
echo "-------------------------------------------"

echo ""
echo "🔧 路由验证..."
OVPN_GW_IP="${OPENVPN_SUBNET}.1"
for target in "$VPS_IP VPS" "$OPENVPN_SERVER OpenVPN服务器" "$OVPN_GW_IP 公司内网" "8.8.8.8 外网"; do
    IP=$(echo "$target" | awk '{print $1}')
    NAME=$(echo "$target" | awk '{print $2}')
    IF=$(route -n get "$IP" 2>/dev/null | grep "interface" | awk '{print $2}')
    GW=$(route -n get "$IP" 2>/dev/null | grep "gateway" | awk '{print $2}')
    echo "  $NAME ($IP) → $IF (via $GW)"
done

echo ""
echo "🧪 测试..."
echo -n "  公司内网: "
ping -c 1 -t 3 "$OVPN_GW_IP" >/dev/null 2>&1 && echo "✅" || echo "❌"

echo -n "  百度: "
curl -s --max-time 8 https://www.baidu.com >/dev/null 2>&1 && echo "✅" || echo "❌"

echo -n "  Google: "
curl -s --max-time 8 https://www.google.com >/dev/null 2>&1 && echo "✅" || echo "❌"

echo -n "  出口IP: "
IP=$(curl -s --max-time 8 https://api.ipify.org 2>/dev/null)
if [ -n "$IP" ]; then
    echo "$IP"
    [ "$IP" = "$VPS_IP" ] && echo "  🎉 完美！外网走 WireGuard！"
else
    echo "❌"
fi

echo ""
echo "恢复: sudo ./scripts/restore-routes.sh"
