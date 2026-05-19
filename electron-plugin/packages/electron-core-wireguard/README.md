# @qpjoy/electron-core-wireguard

Electron-scoped WireGuard profile contracts and rendering helpers for QPJoy HDO.

This package does not create system interfaces by itself. It is the stable
data/config layer that HDO clients, installers, and future plugins can share.

Current scope:

- HDO mesh address defaults
- peer/interface config rendering
- shared port and ACL types
- helpers for splitting home/user/service overlay ranges
