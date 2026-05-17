import { spawn, execFile } from 'child_process';
import { promisify } from 'util';
import { readFile, rm, mkdir, cp, rename, writeFile, symlink, lstat, readdir } from 'fs/promises';
import { createWriteStream, existsSync } from 'fs';
import { join, isAbsolute, resolve } from 'path';

import type { PluginManifest } from '@qpjoy/electron-plugin-sdk';
import type { PluginRegistry } from '../registry/PluginRegistry';

const execFileAsync = promisify(execFile);

/**
 * Cross-platform wrapper around `npm install` / `pnpm install`.
 *
 * The motivating Windows quirk: `npm` and `pnpm` ship as `.cmd` batch
 * wrappers around the actual Node entry. `child_process.execFile` on
 * Windows doesn't consult PATHEXT, so `execFile('npm', …)` fails with
 * `spawn npm ENOENT` even though `where npm` works fine. The standard
 * workaround is to route through the system shell so `cmd.exe` does the
 * lookup; that needs `shell: true`, which in turn requires us to quote
 * args ourselves because shell-mode disables Node's argv quoting.
 *
 * On macOS / Linux the no-shell `execFile` fast path is fine and avoids
 * any sh quoting concerns.
 */
async function exec(file: string, args: string[], opts: { cwd: string; env?: NodeJS.ProcessEnv }): Promise<void> {
  if (process.platform !== 'win32') {
    await execFileAsync(file, args, {
      ...opts,
      env: opts.env ? { ...process.env, ...opts.env } : process.env
    });
    return;
  }
  return new Promise((resolve, reject) => {
    // Windows shell quoting: wrap any arg that contains a space / quote /
    // cmd metachar in double quotes and escape inner double quotes.
    const quoted = args.map((a) =>
      /[\s"&<>|^()]/.test(a) ? `"${a.replace(/"/g, '\\"')}"` : a
    );
    const child = spawn(file, quoted, {
      cwd: opts.cwd,
      env: opts.env ? { ...process.env, ...opts.env } : process.env,
      stdio: 'pipe',
      shell: true,
      windowsHide: true
    });
    let stderr = '';
    let stdout = '';
    child.stdout?.on('data', (d) => { stdout += d.toString(); });
    child.stderr?.on('data', (d) => { stderr += d.toString(); });
    child.on('error', (err) => reject(err));
    child.on('close', (code) => {
      if (code === 0) {
        resolve();
      } else {
        const tail = (stderr || stdout).split('\n').slice(-20).join('\n');
        reject(new Error(`${file} ${args.join(' ')} exited with code ${code}\n${tail}`));
      }
    });
  });
}

/**
 * Where the plugin tarball / source comes from.
 *
 *  - `registry` — `npm install <pkg>@<ver>` from the public npm registry.
 *  - `tarball`  — `npm install <path-to-tgz>`; works fully offline.
 *  - `local-dir` — copy a directory we already have on disk into the
 *    plugin's `node_modules/<npm>/`. This is the seed path: ship the
 *    bundled tunnel inside your app's `resources/` so the host can
 *    bootstrap it without any network at all.
 */
export type PluginSource =
  | { type: 'registry'; version: string; tarballUrl?: string | null }
  | { type: 'tarball'; path: string }
  | { type: 'local-dir'; path: string };

/**
 * Filter passed to `fs.cp` when seeding from a local dev directory. We
 * intentionally drop things that would either bloat the seed or, worse,
 * make the copy itself fail:
 *
 *  - `node_modules/electron/...` ships a giant binary distribution plus
 *    `default_app.asar`. When this code runs *inside Electron*, the
 *    monkey-patched fs refuses to lstat into the asar with an "Invalid
 *    package" error. We never need the tunnel's own copy of electron at
 *    runtime — it's a peer dep, the host provides it.
 *  - `node_modules/.pnpm/...` is pnpm's content-addressed store, full of
 *    symlinks pointing back into itself. Copying it explodes in size and
 *    is useless once flattened.
 *  - `node_modules/@types/...` are TS compile-time types only.
 *  - dot-dirs like `.git`, `.cache` are dev-only.
 *  - `dist` for nested packages (we already copied the top-level dist).
 *    Not strictly needed but keeps the seed lean.
 */
function shouldCopyPath(src: string): boolean {
  const normalized = src.replace(/\\/g, '/');
  if (/\/node_modules\/electron(\/|$)/.test(normalized)) return false;
  if (/\/node_modules\/\.pnpm(\/|$)/.test(normalized)) return false;
  if (/\/node_modules\/@types(\/|$)/.test(normalized)) return false;
  if (/\/node_modules\/typescript(\/|$)/.test(normalized)) return false;
  if (/\/\.git(\/|$)/.test(normalized)) return false;
  if (/\/\.cache(\/|$)/.test(normalized)) return false;
  if (/\.asar$/.test(normalized)) return false;
  return true;
}

/**
 * Best-effort directory link from `sourceDir` to `targetDir`.
 *
 * Strategy:
 *   1. On Windows: use a **junction** (`fs.symlink(..., 'junction')`). NTFS
 *      junctions don't require `SeCreateSymbolicLinkPrivilege` so they
 *      work for unprivileged users. Limitation: same-volume only.
 *   2. On macOS / Linux: a regular directory symlink.
 *   3. If either fails (e.g. Windows cross-volume, sandboxed FS, etc.),
 *      fall back to a recursive copy. Copies are slower and lose the
 *      "edit source → see change immediately" dev workflow, but every
 *      Electron `require()` path keeps working because the destination
 *      tree is self-contained.
 */
async function linkOrCopy(sourceDir: string, targetDir: string): Promise<void> {
  const linkType = process.platform === 'win32' ? 'junction' : 'dir';
  try {
    await symlink(sourceDir, targetDir, linkType);
    return;
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    // EPERM: e.g. Windows without admin AND junction unavailable (rare).
    // ENOTSUP / EXDEV: cross-volume junctions.
    if (code !== 'EPERM' && code !== 'ENOTSUP' && code !== 'EXDEV') {
      throw err;
    }
  }
  // Fallback: deep copy. cpSync via `cp` from fs/promises supports
  // recursive copying since Node 16.7.
  await cp(sourceDir, targetDir, {
    recursive: true,
    dereference: true,
    filter: (src) => shouldCopyPath(src)
  });
}

export interface PluginStoreOptions {
  pluginsRoot: string;
  registry: PluginRegistry;
  /** Package manager binary. Defaults to `npm`. */
  packageManager?: 'npm' | 'pnpm';
}

export type InstallProgressStage =
  | 'queued'
  | 'downloading'
  | 'installing'
  | 'finalizing'
  | 'done'
  | 'failed';

export interface InstallProgress {
  id: string;
  stage: InstallProgressStage;
  message: string;
  receivedBytes: number;
  totalBytes: number | null;
  percent: number | null;
  updatedAt: string;
  error: string | null;
}

type PackageManager = NonNullable<PluginStoreOptions['packageManager']>;

function installArgs(target: string, allowScripts: boolean, packageManager: PackageManager): string[] {
  const args = ['install', '--no-audit', '--no-fund'];
  // Plugins run inside the host Electron process. Installing peer deps would
  // put a second `electron` package under userData/plugins, which is huge and
  // makes Windows cleanup brittle when Electron's resources are still touched.
  if (packageManager === 'npm') {
    args.push('--omit=peer');
  } else {
    args.push('--config.auto-install-peers=false');
  }
  if (!allowScripts) args.push('--ignore-scripts');
  args.push(target);
  return args;
}

function delay(ms: number): Promise<void> {
  return new Promise((resolveDelay) => setTimeout(resolveDelay, ms));
}

function isRetryableRemoveError(err: unknown): boolean {
  const code = (err as NodeJS.ErrnoException).code;
  return code === 'ENOTEMPTY' || code === 'EBUSY' || code === 'EPERM' || code === 'EMFILE' || code === 'ENFILE';
}

async function removePath(target: string): Promise<void> {
  for (let attempt = 0; attempt < 8; attempt += 1) {
    try {
      await rm(target, {
        recursive: true,
        force: true,
        maxRetries: 3,
        retryDelay: 150
      });
      return;
    } catch (err) {
      if (!isRetryableRemoveError(err) || attempt === 7) {
        throw err;
      }
      await delay(150 * (attempt + 1));
    }
  }
}

async function retirePath(target: string): Promise<void> {
  if (!existsSync(target)) return;
  try {
    await removePath(target);
    return;
  } catch (err) {
    const retired = `${target}.__delete-${Date.now()}`;
    try {
      await rename(target, retired);
    } catch {
      throw err;
    }
    void removePath(retired).catch(() => undefined);
  }
}

function electronNativeBuildEnv(): NodeJS.ProcessEnv | null {
  const electronVersion = process.versions.electron;
  if (!electronVersion) return null;

  return {
    npm_config_runtime: 'electron',
    npm_config_target: electronVersion,
    npm_config_disturl: 'https://electronjs.org/headers'
  };
}

/**
 * Filesystem layer: install / uninstall npm packages into
 * `userData/plugins/<id>@<version>/` and read their manifests.
 *
 * Strict rules:
 *  - `--ignore-scripts` is the default. First-party bootstrap packages that
 *    intentionally ship native storage (currently Tunnel + better-sqlite3)
 *    are allowed to run install scripts so their native binding exists.
 *  - Each plugin gets its own dir with its own `node_modules` — no hoisting,
 *    no cross-talk.
 */
export class PluginStore {
  private readonly progress = new Map<string, InstallProgress>();

  constructor(private readonly opts: PluginStoreOptions) {}

  pluginDir(id: string, version: string): string {
    return join(this.opts.pluginsRoot, `${id}@${version}`);
  }

  getInstallProgress(id?: string): InstallProgress[] {
    const values = [...this.progress.values()];
    return id ? values.filter((p) => p.id === id) : values;
  }

  private setProgress(
    id: string,
    patch: Partial<Omit<InstallProgress, 'id' | 'updatedAt'>>
  ): void {
    const prev = this.progress.get(id) ?? {
      id,
      stage: 'queued' as InstallProgressStage,
      message: '等待安装',
      receivedBytes: 0,
      totalBytes: null,
      percent: null,
      updatedAt: new Date().toISOString(),
      error: null
    };
    const next = {
      ...prev,
      ...patch,
      updatedAt: new Date().toISOString()
    };
    next.percent = next.totalBytes && next.totalBytes > 0
      ? Math.max(0, Math.min(100, Math.round((next.receivedBytes / next.totalBytes) * 100)))
      : patch.percent ?? next.percent;
    this.progress.set(id, next);
  }

  private allowInstallScripts(npm: string): boolean {
    // Tunnel is a first-party bootstrap plugin and intentionally owns a
    // better-sqlite3 database for standalone mode. Installing it with
    // --ignore-scripts leaves the native .node binding absent on Windows.
    return npm === '@qpjoy/electron-plugin-tunnel';
  }

  private nativeElectronPackages(npm: string): string[] {
    return npm === '@qpjoy/electron-plugin-tunnel' ? ['better-sqlite3'] : [];
  }

  private nativeInstallEnv(npm: string): NodeJS.ProcessEnv | undefined {
    return this.nativeElectronPackages(npm).length > 0
      ? electronNativeBuildEnv() ?? undefined
      : undefined;
  }

  private async downloadTarball(url: string, dest: string, id: string): Promise<void> {
    this.setProgress(id, {
      stage: 'downloading',
      message: '正在下载安装包',
      receivedBytes: 0,
      totalBytes: null,
      percent: 0,
      error: null
    });

    const res = await fetch(url);
    if (!res.ok) {
      throw new Error(`download failed: ${res.status} ${res.statusText}`);
    }

    const totalRaw = res.headers.get('content-length');
    const totalBytes = totalRaw ? Number(totalRaw) : null;
    if (!res.body) {
      throw new Error('download failed: empty response body');
    }

    const out = createWriteStream(dest);
    const reader = res.body.getReader();
    let receivedBytes = 0;
    try {
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        if (!value) continue;
        receivedBytes += value.byteLength;
        await new Promise<void>((resolveWrite, rejectWrite) => {
          out.write(Buffer.from(value), (err) => {
            if (err) rejectWrite(err);
            else resolveWrite();
          });
        });
        this.setProgress(id, {
          stage: 'downloading',
          message: totalBytes ? '正在下载安装包' : `已下载 ${receivedBytes} bytes`,
          receivedBytes,
          totalBytes,
          error: null
        });
      }
    } finally {
      reader.releaseLock();
    }

    await new Promise<void>((resolveEnd, rejectEnd) => {
      out.end((err?: Error | null) => {
        if (err) rejectEnd(err);
        else resolveEnd();
      });
    });
  }

  /**
   * Install from the public registry. Requires network.
   * Equivalent to `install({ id, npm, source: { type:'registry', version }})`.
   */
  async install(input: { id: string; npm: string; version: string; tarballUrl?: string | null }): Promise<PluginManifest> {
    return this.installFrom({
      id: input.id,
      npm: input.npm,
      source: { type: 'registry', version: input.version, tarballUrl: input.tarballUrl }
    });
  }

  /**
   * Generic install. Picks the path based on `source.type`. The end state is
   * always the same: `<pluginsRoot>/<id>@<version>/node_modules/<npm>/` exists
   * and a record is upserted into the registry in `awaitingGrant` state.
   */
  async installFrom(input: { id: string; npm: string; source: PluginSource }): Promise<PluginManifest> {
    const pm = this.opts.packageManager ?? 'npm';
    const allowScripts = this.allowInstallScripts(input.npm);
    const installEnv = this.nativeInstallEnv(input.npm);
    this.setProgress(input.id, {
      stage: 'queued',
      message: '准备安装',
      receivedBytes: 0,
      totalBytes: null,
      percent: 0,
      error: null
    });

    // We need a version up-front to compute the install dir. For local-dir we
    // read it from the source's package.json; for tarball we install first
    // into a scratch dir and then re-read. The simplest unified scheme is to
    // stage in a temp dir, learn the version, then move/rename.
    //
    // Two subtleties:
    //   1. The staging dir name must NOT start with `.` — `npm init -y`
    //      would refuse, and even our hand-rolled package.json would make
    //      `npm install <path>` (the tarball + local-dir paths) unhappy.
    //   2. We write a minimal package.json directly instead of running
    //      `npm init -y`, which is faster and avoids npm's package-name
    //      validation against the staging dir basename.
    const slug = input.id.replace(/[^a-z0-9-]+/gi, '-').toLowerCase();
    const stagingDir = join(this.opts.pluginsRoot, `_staging-${Date.now()}-${slug}`);
    await mkdir(stagingDir, { recursive: true });
    await writeFile(
      join(stagingDir, 'package.json'),
      JSON.stringify({ name: 'qpjoy-plugin-staging', version: '0.0.0', private: true }) + '\n',
      'utf8'
    );

    try {
      switch (input.source.type) {
        case 'registry': {
          if (input.source.tarballUrl) {
            const tgz = join(stagingDir, `${slug}.tgz`);
            await this.downloadTarball(input.source.tarballUrl, tgz, input.id);
            this.setProgress(input.id, {
              stage: 'installing',
              message: allowScripts ? '正在安装并准备原生依赖' : '正在安装依赖',
              error: null
            });
            await exec(pm, installArgs(tgz, allowScripts, pm), { cwd: stagingDir, env: installEnv });
            break;
          }
          this.setProgress(input.id, {
            stage: 'installing',
            message: allowScripts ? '正在从 npm 安装并准备原生依赖' : '正在从 npm 安装',
            error: null
          });
          await exec(
            pm,
            installArgs(`${input.npm}@${input.source.version}`, allowScripts, pm),
            { cwd: stagingDir, env: installEnv }
          );
          break;
        }

        case 'tarball': {
          const tgz = isAbsolute(input.source.path) ? input.source.path : resolve(input.source.path);
          if (!existsSync(tgz)) throw new Error(`Tarball not found: ${tgz}`);
          this.setProgress(input.id, {
            stage: 'installing',
            message: allowScripts ? '正在安装并准备原生依赖' : '正在安装本地包',
            error: null
          });
          await exec(
            pm,
            installArgs(tgz, allowScripts, pm),
            { cwd: stagingDir, env: installEnv }
          );
          break;
        }

        case 'local-dir': {
          this.setProgress(input.id, {
            stage: 'installing',
            message: '正在使用内置插件源',
            error: null
          });
          // Symlink the source dir into `node_modules/<npm>/` rather than
          // copying. Two big reasons:
          //
          //  1. The source's node_modules is usually pnpm-managed, where
          //     transitive deps live under a `.pnpm/` content-addressed
          //     store with symlinks. `cp --dereference` flattens those
          //     symlinks and loses the resolver semantics — Node walks up
          //     `node_modules/` chains but never enters `.pnpm/`, so deps
          //     like `bindings` (transitive of better-sqlite3) become
          //     unfindable in the dest.
          //
          //  2. For dev workflows it's just nicer — edit the source and the
          //     next plugin restart picks it up, no re-seed needed.
          //
          // Node `require()` calls `fs.realpath()` on each resolved file,
          // so requires from inside the seeded plugin walk through the
          // symlink back to the source tree and resolve correctly against
          // pnpm's structure.
          const sourceDir = isAbsolute(input.source.path)
            ? input.source.path
            : resolve(input.source.path);
          if (!existsSync(sourceDir)) throw new Error(`Local source not found: ${sourceDir}`);

          // Sanity: make sure it really is a directory (not a file or broken link).
          const stat = await lstat(sourceDir);
          if (!stat.isDirectory()) throw new Error(`Local source is not a directory: ${sourceDir}`);

          const targetDir = join(stagingDir, 'node_modules', input.npm);
          // mkdir the PARENT (e.g. node_modules/@qpjoy), not the target itself.
          await mkdir(join(targetDir, '..'), { recursive: true });
          await linkOrCopy(sourceDir, targetDir);
          break;
        }
      }

      this.setProgress(input.id, {
        stage: 'finalizing',
        message: '正在读取插件清单',
        error: null
      });
      const manifest = await this.readManifest(stagingDir, input.npm);
      if (manifest.id !== input.id) {
        throw new Error(
          `Manifest id mismatch: caller said "${input.id}", package ships "${manifest.id}"`
        );
      }

      const finalDir = this.pluginDir(manifest.id, manifest.version);
      if (existsSync(finalDir)) {
        await retirePath(finalDir);
      }
      // Rename atomically (within the same filesystem).
      await mkdir(this.opts.pluginsRoot, { recursive: true });
      await this.renameOrFallback(stagingDir, finalDir);

      this.opts.registry.upsert(
        {
          id: manifest.id,
          npm: input.npm,
          version: manifest.version,
          installPath: finalDir,
          manifest,
          grantedPermissions: [],
          state: 'awaitingGrant',
          errorMessage: null
        },
        // Carry the actual install source through to the DB.
        input.source.type === 'registry'
          ? 'registry'
          : input.source.type === 'tarball'
          ? 'tarball'
          : 'local-dir'
      );

      this.setProgress(input.id, {
        stage: 'done',
        message: '安装完成',
        receivedBytes: 0,
        totalBytes: null,
        percent: 100,
        error: null
      });
      return manifest;
    } catch (err) {
      this.setProgress(input.id, {
        stage: 'failed',
        message: '安装失败',
        error: err instanceof Error ? err.message : String(err)
      });
      // Best-effort cleanup of the staging dir on failure.
      await removePath(stagingDir).catch(() => undefined);
      throw err;
    }
  }

  private async renameOrFallback(from: string, to: string): Promise<void> {
    try {
      await rename(from, to);
    } catch {
      // Cross-device or permission issue → fall back to copy+delete.
      await cp(from, to, { recursive: true });
      await retirePath(from);
    }
  }

  private async cleanupPluginDirs(id: string, keepPath?: string): Promise<void> {
    const entries = await readdir(this.opts.pluginsRoot, { withFileTypes: true }).catch(() => []);
    const prefix = `${id}@`;
    const keep = keepPath ? resolve(keepPath) : null;
    for (const entry of entries) {
      if (!entry.isDirectory() || !entry.name.startsWith(prefix)) continue;
      const fullPath = join(this.opts.pluginsRoot, entry.name);
      if (keep && resolve(fullPath) === keep) continue;
      await retirePath(fullPath).catch(() => undefined);
    }
  }

  async uninstall(id: string): Promise<void> {
    const record = this.opts.registry.get(id);
    if (!record) return;
    if (existsSync(record.installPath)) {
      await retirePath(record.installPath).catch(() => undefined);
    }
    await this.cleanupPluginDirs(id);
    this.opts.registry.remove(id);
  }

  /**
   * Install a new version side-by-side, then delete the previous install
   * directory. Caller is responsible for deactivating + re-activating the
   * plugin around the swap (PluginRuntime exposes that).
   *
   * Preserves the registry row's grants by passing through `upsert` —
   * the row's `version` and `installPath` change, but `grantedPermissions`
   * is left alone (the caller can intersect with the new manifest's
   * permissions if it changed).
   */
  async upgrade(id: string, source: PluginSource): Promise<PluginManifest> {
    const existing = this.opts.registry.get(id);
    if (!existing) {
      throw new Error(`cannot upgrade: ${id} is not installed`);
    }
    const oldPath = existing.installPath;
    const oldGrants = existing.grantedPermissions;

    // installFrom upserts the row with the new path/version AND resets
    // grants to []. Re-apply the previous grants intersected with the new
    // manifest's permission set so we don't silently widen privileges.
    const manifest = await this.installFrom({
      id,
      npm: existing.npm,
      source
    });
    const allowed = new Set(manifest.permissions);
    const preserved = oldGrants.filter((p) => allowed.has(p));
    this.opts.registry.grant(id, preserved);

    // Mark "installed" instead of "awaitingGrant" if the previous grants
    // already cover the new manifest. Else surface that the user has new
    // permissions to review (any permission added in the new version).
    const fullyGranted = manifest.permissions.every((p) => preserved.includes(p));
    this.opts.registry.setState(id, fullyGranted ? 'installed' : 'awaitingGrant');

    // Clean up old install dir if it's different.
    const newPath = this.pluginDir(id, manifest.version);
    if (oldPath !== newPath && existsSync(oldPath)) {
      await retirePath(oldPath).catch(() => undefined);
    }
    await this.cleanupPluginDirs(id, newPath);
    return manifest;
  }

  /**
   * Read `<dir>/node_modules/<npm>/package.json` plus the manifest file it
   * points at via `qpjoyPlugin.manifest`.
   */
  async readManifest(dir: string, npm: string): Promise<PluginManifest> {
    const pkgPath = join(dir, 'node_modules', npm, 'package.json');
    const pkg = JSON.parse(await readFile(pkgPath, 'utf8')) as {
      version?: string;
      qpjoyPlugin?: { specVersion: number; manifest: string; entry?: string };
    };
    if (!pkg.qpjoyPlugin) {
      throw new Error(`Package ${npm} is not a QPJoy plugin (missing qpjoyPlugin field).`);
    }
    if (pkg.qpjoyPlugin.specVersion !== 1) {
      throw new Error(`Unsupported plugin spec version: ${pkg.qpjoyPlugin.specVersion}`);
    }
    const manifestPath = join(dir, 'node_modules', npm, pkg.qpjoyPlugin.manifest);
    const manifest = JSON.parse(await readFile(manifestPath, 'utf8')) as PluginManifest;

    // `package.json#version` is the source of truth — npm tracks it, the
    // marketplace tracks it, and the install path uses it. The plugin's
    // `manifest.version` field is meant to mirror it, but in practice it
    // drifts (publishers forget to bump the manifest copy). Defensively
    // override the manifest to match the package so the marketplace UI
    // never shows a stale version label.
    if (pkg.version && pkg.version !== manifest.version) {
      // eslint-disable-next-line no-console
      console.warn(
        `[plugin-store] ${npm} manifest.version (${manifest.version}) differs from ` +
          `package.json#version (${pkg.version}); using package.json as authoritative.`
      );
      manifest.version = pkg.version;
    }

    return manifest;
  }
}
