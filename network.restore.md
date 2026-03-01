```bash
sudo route -n flush
sudo route delete default
sudo route add default 192.168.1.1
sudo dscacheutil -flushcache
sudo killall -HUP mDNSResponder
ping -c 2 baidu.com

# 关闭clash的全局代理，或者在 Clash Verge 设置里关掉「退出时保留系统代理」
networksetup -setwebproxystate "Wi-Fi" off
networksetup -setsecurewebproxystate "Wi-Fi" off
networksetup -setsocksfirewallproxystate "Wi-Fi" off
```
