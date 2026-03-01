#!/bin/bash
# restore-routes.sh
# 网络断了就运行: sudo ./restore-routes.sh

echo "🔄 恢复默认网络..."

# ============ 检测网关（去掉花括号） ============
LOCAL_GW=""

for iface in en0 en1 en2; do
    GW=$(ipconfig getpacket "$iface" 2>/dev/null | grep "router" | awk '{print $3}' | tr -d '{}')
    if [ -n "$GW" ]; then
        LOCAL_GW="$GW"
        echo "📶 DHCP 网关: $LOCAL_GW ($iface)"
        break
    fi
done

if [ -z "$LOCAL_GW" ]; then
    for service in "Wi-Fi" "Ethernet"; do
        GW=$(networksetup -getinfo "$service" 2>/dev/null | grep "^Router" | awk '{print $2}' | tr -d '{}')
        if [ -n "$GW" ] && [ "$GW" != "none" ]; then
            LOCAL_GW="$GW"
            echo "📶 从 $service 检测到网关: $LOCAL_GW"
            break
        fi
    done
fi

if [ -z "$LOCAL_GW" ] && [ -f "$HOME/.route_backup.env" ]; then
    LOCAL_GW=$(grep "^DEFAULT_GW=" "$HOME/.route_backup.env" | cut -d= -f2 | tr -d '{}')
    [ -n "$LOCAL_GW" ] && echo "📂 从备份读取网关: $LOCAL_GW"
fi

if [ -z "$LOCAL_GW" ]; then
    echo "❌ 无法检测，请输入网关:"
    read LOCAL_GW
fi

echo ""
echo "🔧 使用网关: $LOCAL_GW"

# ============ 清空重建 ============
echo ""
sudo route -n flush 2>/dev/null
echo "✅ 路由表已清空"

sudo route add default "$LOCAL_GW"
echo "✅ default → $LOCAL_GW"

# ============ 清理 ============
networksetup -setwebproxystate "Wi-Fi" off 2>/dev/null
networksetup -setsecurewebproxystate "Wi-Fi" off 2>/dev/null
networksetup -setsocksfirewallproxystate "Wi-Fi" off 2>/dev/null
sudo dscacheutil -flushcache 2>/dev/null
sudo killall -HUP mDNSResponder 2>/dev/null
echo "✅ 代理关闭，DNS 刷新"

# ============ 验证 ============
echo ""
echo "📋 默认路由:"
netstat -rn | grep "^default" | head -3

echo ""
echo "🧪 测试..."
echo -n "  Ping 网关: "
ping -c 1 -t 3 "$LOCAL_GW" >/dev/null 2>&1 && echo "✅" || echo "❌"

echo -n "  Ping 114: "
ping -c 1 -t 3 114.114.114.114 >/dev/null 2>&1 && echo "✅" || echo "❌"

echo -n "  百度: "
curl -s --max-time 5 https://www.baidu.com >/dev/null 2>&1 && echo "✅" || echo "❌"

echo ""
echo "✅ 完成！不通就断开所有VPN，关开Wi-Fi再试。"