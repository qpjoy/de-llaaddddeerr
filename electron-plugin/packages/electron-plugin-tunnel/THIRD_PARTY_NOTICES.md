# Third Party Notices

This npm package redistributes third-party software as bundled tunnel engine
resources. The resources are installed into the consuming Electron app at
runtime; end users do not need to install or configure the engine separately.

## MetaCubeX/mihomo

- Project: MetaCubeX/mihomo
- Source: https://github.com/MetaCubeX/mihomo
- Release used for bundled binaries: v1.19.24
- License: GNU General Public License version 3
- License text: https://raw.githubusercontent.com/MetaCubeX/mihomo/Meta/LICENSE
- Corresponding source: https://github.com/MetaCubeX/mihomo/tree/v1.19.24

Bundled binary resources:

```text
resources/engine/darwin-arm64/mihomo.gz
resources/engine/darwin-x64/mihomo.gz
resources/engine/linux-x64/mihomo.gz
resources/engine/linux-arm64/mihomo.gz
```

The bundled binaries are unmodified release artifacts downloaded from the
upstream project. If you redistribute an Electron application that includes
these resources, preserve this notice and comply with the upstream GPL-3.0
license terms, including source-code availability requirements for the bundled
engine.
