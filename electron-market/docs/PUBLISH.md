# Publish to npm

Three packages get published; one (`@qpjoy/electron-market-admin-ui`) stays
private and ships baked into `@qpjoy/electron-market`'s `dist/admin-ui/`.

```
@qpjoy/electron-plugin-sdk          types + definePlugin       no workspace deps
@qpjoy/marketplace-db      SQLite data layer          no workspace deps
@qpjoy/electron-market     host runtime + admin SPA   depends on marketplace-db
```

## ⚠️ Always use `pnpm publish`, not `npm publish`

`@qpjoy/electron-market`'s `package.json` carries `"@qpjoy/marketplace-db": "workspace:^"`.
Only `pnpm publish` rewrites that to a real version (`^0.1.0`) at pack
time. `npm publish` leaves `workspace:^` literal, which **silently breaks
every install** — npm has no idea what `workspace:` means and 404s when
consumers try to install your package.

Run from inside the package directory, with the workspace root reachable
upwards:

```bash
cd electron-market/packages/electron-market
pnpm publish
```

NOT:
```bash
# DON'T do these — they bypass the rewrite:
npm publish
cd electron-market/packages/electron-market && (cd /tmp && pnpm publish)
```

## Standard flow

```bash
cd electron-market

# 1. clean build (topological order: sdk → db → admin-ui → host)
pnpm install
pnpm -r build

# 2. dry-run pack to inspect what would ship
mkdir -p /tmp/qpjoy-pub-preview && rm -f /tmp/qpjoy-pub-preview/*.tgz
for p in electron-plugin-sdk marketplace-db electron-plugin; do
  (cd packages/$p && pnpm pack --pack-destination /tmp/qpjoy-pub-preview)
done

# Verify electron-plugin's marketplace-db ref is ^x.y.z, NOT workspace:^
tar -xzOf /tmp/qpjoy-pub-preview/qpjoy-electron-market-*.tgz package/package.json \
  | jq '.dependencies."@qpjoy/marketplace-db"'

# 3. publish in dep order (npm 2FA prompts each time if enabled)
cd packages/electron-plugin-sdk     && pnpm publish && cd ../..
cd packages/marketplace-db && pnpm publish && cd ../..
cd packages/electron-plugin && pnpm publish && cd ../..

# 4. tag
git tag electron-plugin-sdk-v$(cat packages/electron-plugin-sdk/package.json | jq -r .version)
git tag marketplace-db-v$(cat packages/marketplace-db/package.json | jq -r .version)
git tag electron-market-v$(cat packages/electron-plugin/package.json | jq -r .version)
git push --tags
```

## Recovering from a botched publish

`workspace:^` slipped into an actual npm release? `unpublish` only works
within 72 hours, so the durable fix is:

```bash
# 1. Bump patch in the offending package, re-publish with pnpm
cd packages/electron-plugin
pnpm version patch       # 0.1.0 → 0.1.1
pnpm publish              # NOTE: pnpm, not npm

# 2. Deprecate the broken version with a useful message
npm deprecate '@qpjoy/electron-market@0.1.0' \
  'broken — published with unresolved workspace:^ dep. Use 0.1.1+.'

# 3. (Optional) unpublish if still within 72h
npm unpublish '@qpjoy/electron-market@0.1.0'
```

`npm deprecate` doesn't remove the version — installs still resolve — but
yarn / pnpm / npm all print a warning, which is enough to push users
forward.

## Special considerations per package

### `@qpjoy/electron-plugin-sdk` (2.4 KB)

- No runtime deps. `electron` is an optional peer (types only).
- Pure types + a `definePlugin` identity helper + a `PermissionDeniedError` class.

### `@qpjoy/marketplace-db` (10 KB)

- Runtime dep: `better-sqlite3` (native module). Consumer's `pnpm install`
  triggers the prebuild fetch + rebuild for their Electron ABI.
- No peer / no workspace deps.

### `@qpjoy/electron-market` (~490 KB)

- The big one. Bakes:
  - The compiled TS runtime (`dist/`)
  - The Quasar admin SPA (`dist/admin-ui/`, ~370 KB)
  - The bundled marketplace seed (`dist/seed-index.json`)
- Runtime dep on `@qpjoy/marketplace-db` (which `workspace:^` only resolves
  via `pnpm publish` — see warning above).
- Peer deps: `@qpjoy/electron-plugin-sdk` (must be installed by the consumer
  alongside) + `electron >= 28`.
- `qpjoyPlugin.self: true` — the host package itself ships a manifest
  (`dist/plugin.manifest.json`) for spec compatibility, but the `self`
  flag tells the server-side sync job to skip it during marketplace
  discovery. Without this you'd see the marketplace host show up as an
  installable card inside its own marketplace.

### `@qpjoy/electron-market-admin-ui` — PRIVATE

`"private": true` — never published. Its dist is copied into
`@qpjoy/electron-market/dist/admin-ui/` by the host package's `build`
script (`scripts/copy-admin-ui.mjs`). Consumers serve those static files
out of node_modules without ever installing admin-ui.

## What consumers run

```bash
# Application that hosts plugins (e.g. electron-test):
pnpm add @qpjoy/electron-market @qpjoy/electron-plugin-sdk

# Optional: also bundle a plugin like the tunnel as a seed
pnpm add @qpjoy/electron-plugin-tunnel
```

The `@qpjoy/electron-plugin-sdk` peer must be installed explicitly — it's a peer
so plugin authors and host integrators can pin different versions if
needed.

## Beta channel

For risky changes, publish to a `beta` tag first:

```bash
pnpm publish --tag beta
# consumers opt in with:
pnpm add @qpjoy/electron-market@beta
```

Promote to `latest` once stable:

```bash
npm dist-tag add @qpjoy/electron-market@0.2.0 latest
```

## Marketplace inclusion convention (for plugin authors)

For your package to appear in the marketplace SPA, **all three** must hold:

1. **Discoverable**. Either
   - npm name matches `@qpjoy/electron-*` (the default scope + prefix the
     server's `sync-npm.ts` uses with `text=` search), **or**
   - the package name is in the server's `MARKETPLACE_ALLOWLIST` env var
     (comma-separated). The default allowlist is `@qpjoy/electron-plugin-tunnel`
     — historical name predating the `electron-plugin-*` convention; new
     QPJoy plugins should just match the prefix.
2. **Has a `qpjoyPlugin` field** in published `package.json`:
   ```json
   "qpjoyPlugin": {
     "specVersion": 1,
     "manifest": "dist/plugin.manifest.json"
   }
   ```
   The server downloads the tarball, extracts that manifest, and uses its
   `id` / `name` / `description` / `permissions` to render the card.
3. **`qpjoyPlugin.self !== true`**. The `self` flag is reserved for the
   host package itself (`@qpjoy/electron-market`) — see above. A normal
   plugin omits it entirely (or sets `false`).

Failing any of these three is fine — your package just won't be listed
(diagnostic reason is recorded in the sync job's `rejected[]` array,
visible via `manage.sh sync`). No more "soft" placeholder cards for
discovered-but-not-onboarded packages: either you've published a real
plugin manifest, or you're absent from the marketplace.

### Recommended naming for new plugins

```
@qpjoy/electron-plugin-<feature>      # e.g. @qpjoy/electron-plugin-clipboard
```

The `electron-plugin-` prefix is a convention, not enforcement. It makes
intent obvious in `package.json` and the npm UI. Existing packages
(`@qpjoy/electron-plugin-tunnel`) keep their names via the allowlist; new ones
should pick the prefixed form unless there's a good reason not to.
