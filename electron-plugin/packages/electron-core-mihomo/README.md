# @qpjoy/electron-core-mihomo

Electron-scoped Mihomo utilities for QPJoy plugins.

This package is intentionally UI-free and host-free. It owns the stable route
compiler contracts used by `@qpjoy/electron-plugin-tunnel` and, later,
`@qpjoy/electron-plugin-hdo`.

Current scope:

- validate Mihomo subscription YAML
- render runtime Mihomo config from a base subscription
- expose route/mesh profile types for HDO composition
- keep DNS, TUN, private direct, and policy-group behavior consistent
