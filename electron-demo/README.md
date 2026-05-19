# electron-demo

Tracked Electron consumer demos for QPJoy Marketplace.

## Projects

| Folder | Purpose |
| --- | --- |
| `tunnel/` | Pre-HDO tunnel smoke app. It uses published npm packages and keeps the old `@qpjoy/electron-plugin-tunnel@0.1.16` consumer flow. |
| `hdo/` | Current HDO development app. It links local `electron-market`, `electron-plugin-hdo`, and `electron-core-wireguard` packages so ongoing HDO changes can be tested and packaged. |

## Run

```bash
cd electron-demo/tunnel
pnpm install
pnpm dev
```

```bash
cd electron-demo/hdo
pnpm install
pnpm build:local
pnpm dev
```

Each demo has its own lockfile and Electron Forge config. Runtime artifacts
such as `node_modules/`, `out/`, and `dist/` are ignored.
