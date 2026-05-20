```bash
cd electron-plugin/packages/electron-plugin-tunnel
npm_config_cache=/private/tmp/qpjoy-npm-cache pnpm pack --dry-run
npm_config_cache=/private/tmp/qpjoy-npm-cache pnpm publish --access public --otp 123456

npm view @qpjoy/electron-plugin-tunnel version
npm view @qpjoy/electron-plugin-tunnel bin

pnpm add @qpjoy/electron-plugin-tunnel
pnpm exec qpjoy-tunnel snippet

# 更新HDO客户端
pnpm --dir electron-plugin --filter @qpjoy/electron-plugin-hdo build
./scripts/manage.sh sync-apps
```