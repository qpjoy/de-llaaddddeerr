```bash
npm whoami          # 应该输出 qpjoy（你前面发 electron-tunnel 用的账号）
# 没登录就：
npm login


# 1. 一次性最终 build
cd electron-market
pnpm install                # 确保 lockfile 最新
pnpm -r build               # 4 个包都构建：sdk, db, admin-ui, electron-plugin

# 2. 干跑预览（强烈推荐）
mkdir -p /tmp/qpjoy-publish-preview && rm -f /tmp/qpjoy-publish-preview/*.tgz
for pkg in electron-plugin-sdk marketplace-db electron-plugin; do
  (cd packages/$pkg && pnpm pack --pack-destination /tmp/qpjoy-publish-preview)
done

# 看大小、文件清单、依赖被重写后的样子
ls -lah /tmp/qpjoy-publish-preview/
tar -xzOf /tmp/qpjoy-publish-preview/qpjoy-electron-market-*.tgz package/package.json | jq .dependencies

# 3. 按依赖顺序发布
cd packages/electron-plugin-sdk     && pnpm publish
cd ../marketplace-db       && pnpm publish
cd ../electron-plugin      && pnpm publish

# 4. 验证 + 打 git tag
# npm 上看一下
npm view @qpjoy/electron-plugin-sdk version
npm view @qpjoy/marketplace-db version
npm view @qpjoy/electron-market version

# 各打一个 tag
cd ../..   # 回到 electron-market workspace 根
git tag electron-market-v0.1.0
git tag electron-plugin-sdk-v0.1.0
git tag marketplace-db-v0.1.0
git push --tags


### pnpm publish
cd electron-market
pnpm --filter @qpjoy/electron-market publish --no-git-checks
```


```bash
cd electron-market

# 1. 改源码
# 2. 全量构建
pnpm -r build

# 3. 按依赖底→上发：
cd packages/electron-plugin-sdk      && pnpm version patch && pnpm publish --no-git-checks
cd ../marketplace-db        && pnpm version patch && pnpm publish --no-git-checks
cd ../electron-plugin       && pnpm version patch && pnpm publish --no-git-checks

# 4. 消费方（如 electron-test）
cd ../../../electron-test && rm -rf node_modules pnpm-lock.yaml && pnpm install



# 一条命令搞完所有发布前置（除了 pnpm publish 那一步需要 OTP）
cd /Users/qpjoy/workspace/qpjoy/de/de-llaaddddeerr
pnpm --filter @qpjoy/electron-market build
pnpm --filter @qpjoy/electron-plugin-notyet build

# 接下来两个 publish 必须手动跑（OTP 交互）
cd electron-market/packages/electron-market && pnpm publish --no-git-checks
cd ../../../electron-plugin/packages/electron-plugin-notyet && pnpm publish --no-git-checks


# publish market
pnpm --filter @qpjoy/electron-market-admin-ui build
pnpm --filter @qpjoy/electron-market build

# bump market -> 0.3.19 后
pnpm --filter @qpjoy/electron-market-admin-ui build
pnpm --filter @qpjoy/electron-market build
pnpm --filter @qpjoy/electron-market publish --access public --no-git-checks
```