import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { gunzipSync, gzipSync } from 'node:zlib';
import { spawn } from 'node:child_process';

const demo = fileURLToPath(new URL('..', import.meta.url));
const source = path.join(demo, 'native', 'windows-network-service');
const output = path.join(demo, 'out', 'windows-network-service');
const repository = path.resolve(demo, '../../../..');

export function installDirectoryCommand(script) {
  const compressed = gzipSync(Buffer.from(script, 'utf8')).toString('base64');
  const command = `$ErrorActionPreference='Stop';if(-not $env:MINCAVE_INSTALL_DIRECTORY -or -not $env:MINCAVE_INSTALL_DIRECTORY_SCRIPT){exit 1};$s=[IO.MemoryStream]::new([Convert]::FromBase64String($env:MINCAVE_INSTALL_DIRECTORY_SCRIPT));$g=[IO.Compression.GZipStream]::new($s,[IO.Compression.CompressionMode]::Decompress);$r=[IO.StreamReader]::new($g,[Text.Encoding]::UTF8);& ([scriptblock]::Create($r.ReadToEnd()))`;
  const encoded = Buffer.from(command, 'utf16le').toString('base64');
  if (encoded.length > 7400 || compressed.length > 7400) throw new Error('Installation directory validation exceeds the NSIS command limit.');
  return { command: encoded, script: compressed };
}

async function run(command, args, options) {
  await new Promise((resolve, reject) => {
    const child = spawn(command, args, { ...options, stdio: 'inherit', windowsHide: true, shell: false });
    child.once('error', (error) => reject(new Error(error.code === 'ENOENT'
      ? 'Windows full packaging requires Go 1.26 or newer to build MinCave Network Service. Install Go from https://go.dev/dl/ and reopen the terminal. End users do not need Go or Node.' : error.message)));
    child.once('exit', (code) => code === 0 ? resolve() : reject(new Error(`Windows network service build failed (${code})`)));
  });
}

export async function buildWindowsNetworkService(arch = 'x64') {
  if (arch !== 'x64') throw new Error('MinCave Network Service currently supports only Windows x64.');
  await mkdir(output, { recursive: true });
  const directoryCommand = installDirectoryCommand(await readFile(path.join(demo, 'build', 'prepare-install-directory.ps1'), 'utf8'));
  await writeFile(path.join(output, 'install-directory.nsh'), `!define MINCAVE_INSTALL_DIRECTORY_COMMAND "${directoryCommand.command}"\n!define MINCAVE_INSTALL_DIRECTORY_SCRIPT "${directoryCommand.script}"\n`);
  await run('go', ['test', '-mod=readonly', './...'], { cwd: source, env: { ...process.env, GOOS: process.platform === 'win32' ? 'windows' : process.platform, GOARCH: process.arch === 'x64' ? 'amd64' : process.arch, CGO_ENABLED: '0' } });
  await run('go', ['build', '-mod=readonly', '-trimpath', '-ldflags=-s -w -H=windowsgui', '-o', path.join(output, 'MinCaveNetworkService.exe'), '.'], {
    cwd: source, env: { ...process.env, GOOS: 'windows', GOARCH: 'amd64', CGO_ENABLED: '0' },
  });
  const uiRequire = createRequire(path.join(demo, 'ui', 'package.json'));
  const viteRequire = createRequire(uiRequire.resolve('vite'));
  const { build } = viteRequire('esbuild');
  const pluginRequire = createRequire(path.join(repository, 'electron-plugin', 'packages', 'electron-plugin-tunnel', 'package.json'));
  await build({
    entryPoints: [path.join(demo, 'native', 'windows-network-worker.cjs')],
    outfile: path.join(output, 'worker.cjs'), bundle: true, platform: 'node', format: 'cjs', target: 'node20',
    alias: {
      '@qpjoy/electron-core-wireguard': path.join(repository, 'electron-plugin', 'packages', 'electron-core-wireguard', 'src', 'index.ts'),
      yaml: pluginRequire.resolve('yaml'),
    },
  });
  const engine = path.join(repository, 'electron-plugin', 'packages', 'tunnel-engines', 'win32-x64', 'resources', 'engine', 'win32-x64', 'mihomo.exe.gz');
  await writeFile(path.join(output, 'mihomo.exe'), gunzipSync(await readFile(engine)));
  await writeFile(path.join(output, 'THIRD_PARTY_NOTICES.txt'), [
    'MinCave Network Service uses golang.org/x/sys (BSD-3-Clause) and Microsoft/go-winio (MIT).',
    await readFile(path.join(source, 'THIRD_PARTY_NOTICES.md'), 'utf8'),
    await readFile(path.join(repository, 'electron-plugin', 'packages', 'electron-plugin-tunnel', 'THIRD_PARTY_NOTICES.md'), 'utf8'),
  ].join('\n\n'));
  console.log('[MinCave] Windows network service and protected worker are ready.');
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  await buildWindowsNetworkService(process.argv[2] || 'x64');
}
