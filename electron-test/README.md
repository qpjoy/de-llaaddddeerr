# QPJoy Electron Test (plugin host demo)

End-to-end harness for `@qpjoy/electron-market` + `@qpjoy/electron-tunnel`.
Runs in **two modes** so you can either iterate on local source or
validate the real "user installs from npm" path.

## Two dev modes

```bash
pnpm dev          # local mode (default for iterating on host/tunnel source)
pnpm dev:npm      # npm mode (installs published packages from the registry)
```

| Mode | Where deps come from | When to use |
| --- | --- | --- |
| `local` | Workspace tarballs (`pnpm pack` of `electron-plugin/...` and `electron/...`) installed via file: refs | While editing host / SDK / tunnel source. Auto-builds + re-packs on first run. |
| `npm` | `^x.y.z` from the npm registry | To validate the published versions still work end-to-end. |

`scripts/dev-mode.mjs` rewrites `package.json` deps + reinstalls only when
the mode actually changes; repeated runs are no-ops.

> **Heads up**: when you've been working in `local` mode, your
> `package.json` has `file:` refs. Run `pnpm dev:reset` (or just
> `pnpm dev:npm`) before committing so the canonical npm refs land
> back in git.

## What runs where

| URL | What it is |
| --- | --- |
| `http://127.0.0.1:23455` | Plugin host admin panel (in-app iframe + standalone). |
| `http://127.0.0.1:23456` | Tunnel admin panel (visible only when tunnel is active). |

## Where does the marketplace server URL come from?

It's not configured here — that's intentional. `@qpjoy/electron-market`
picks the right default based on `app.isPackaged`:

| Build | Default URL |
| --- | --- |
| `pnpm dev` (unpackaged) | `http://127.0.0.1:8080` (your local docker stack) |
| Packaged (`pnpm make`) | The production VPS URL baked into the package |

End-user apps consuming `@qpjoy/electron-market` from npm do **not** need
to set anything — `createElectronMarket(host, { ...options })` Just
Works. Override the default by passing `serverBaseUrl: 'https://...'`
(or `null` for forced offline) to the same function.

## Running the local market server

```bash
cd ../electron-server
scripts/manage.sh up          # postgres + market in docker
scripts/manage.sh sync        # one-shot npm sync (auto-runs hourly too)
```

Then in another terminal:

```bash
cd electron-test
pnpm dev
```

## Package + make

```bash
pnpm package
pnpm make
```

`forge.config.cjs` ships the `electron-mihomo-tunnel/` package under
`Resources/`, so the seed step still works after the app is bundled.
