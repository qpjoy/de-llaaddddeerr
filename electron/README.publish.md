```bash
cd electron/packages/electron-mihomo-tunnel
npm_config_cache=/private/tmp/qpjoy-npm-cache npm pack --dry-run
npm_config_cache=/private/tmp/qpjoy-npm-cache npm publish --access public --otp 123456

npm view @qpjoy/electron-tunnel version
npm view @qpjoy/electron-tunnel bin

pnpm add @qpjoy/electron-tunnel
pnpm exec qpjoy-tunnel snippet
```