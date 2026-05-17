```bash
# A. 构建 + 同步 manifest 版本（dist/plugin.manifest.json → 当前 package.json 版本）
cd electron-plugin/packages/electron-plugin-notyet
pnpm build
# 期望输出：
#   [copy-assets] wrote dist/plugin.manifest.json @ <version> (synced from package.json)
#   [copy-assets] copied src/assets → ...

# B. （推荐）dry-run 检查 tarball 内容
pnpm pack --pack-destination /tmp/notyet-preview
tar -xzOf /tmp/notyet-preview/qpjoy-electron-plugin-notyet-*.tgz package/package.json \
  | jq '{name, version, peerDependencies, peerDependenciesMeta, qpjoyPlugin}'
# 期望 electron peer 标记为 optional，没有任何 workspace: 协议遗留

# C. 发布到 npm（需要 OTP）
pnpm publish --no-git-checks
# 提示：
#   This operation requires a one-time password from your authenticator.
#   Enter OTP: <6 位>
# 成功：
#   + @qpjoy/electron-plugin-notyet@<version>

# D. 校验上线
npm view @qpjoy/electron-plugin-notyet versions
# 期望看到刚发布的新版本
```
