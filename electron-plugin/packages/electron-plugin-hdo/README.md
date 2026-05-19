# @qpjoy/electron-plugin-hdo

HDO (Home-Domestic-Oversea) control-panel plugin for QPJoy Marketplace.

It runs a local admin panel at `http://127.0.0.1:23459` and talks to the
configured `electron-server` HDO API:

- client readiness
- device registration
- manifest download
- Mihomo subscription download
- admin node/service/rate-limit management
- deployment checklist and role-based install commands

The plugin uses the marketplace login session stored by `@qpjoy/electron-market`.
Set the HDO control URL in the plugin panel, or leave it empty to reuse the
marketplace server URL selected in the marketplace settings page.

The admin panel is split into Overview, Client, Server, Install, and Egress
tabs. Overview tells the user which HDO steps are already complete and calls
out the next action, including the common case where the plugin is installed
but the domestic control plane has not been deployed yet.
