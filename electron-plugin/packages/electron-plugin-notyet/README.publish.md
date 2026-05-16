```bash
# A. 构建 + 同步 manifest 版本（dist/plugin.manifest.json → 0.1.1）
cd electron-plugin/packages/electron-plugin-notyet
pnpm build
# 期望输出：
#   [copy-assets] wrote dist/plugin.manifest.json @ 0.1.1 (synced from package.json)
#   [copy-assets] copied src/assets → ...

# B. （推荐）dry-run 检查 tarball 内容
pnpm pack --pack-destination /tmp/notyet-preview
tar -xzOf /tmp/notyet-preview/qpjoy-electron-plugin-notyet-0.1.1.tgz package/package.json \
  | jq '{name, version, dependencies, peerDependencies, qpjoyPlugin}'
# 期望 version=0.1.1，没有任何 workspace: 协议遗留

# C. 发布到 npm（需要 OTP）
pnpm publish --no-git-checks
# 提示：
#   This operation requires a one-time password from your authenticator.
#   Enter OTP: <6 位>
# 成功：
#   + @qpjoy/electron-plugin-notyet@0.1.1

# D. 校验上线
npm view @qpjoy/electron-plugin-notyet versions
# 期望看到 ["0.1.0", "0.1.1"]
```