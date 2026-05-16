```bash
cd electron-plugin/packages/electron-mihomo-tunnel
npm_config_cache=/private/tmp/qpjoy-npm-cache pnpm pack --dry-run
npm_config_cache=/private/tmp/qpjoy-npm-cache pnpm publish --access public --otp 123456

npm view @qpjoy/electron-tunnel version
npm view @qpjoy/electron-tunnel bin

pnpm add @qpjoy/electron-tunnel
pnpm exec qpjoy-tunnel snippet
```