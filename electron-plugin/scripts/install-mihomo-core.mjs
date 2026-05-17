#!/usr/bin/env node
import { execFile } from 'node:child_process';
import {
  copyFileSync,
  createReadStream,
  createWriteStream,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  rmSync,
  statSync
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { pipeline } from 'node:stream/promises';
import { promisify } from 'node:util';
import { createGzip } from 'node:zlib';

const rootDir = resolve(new URL('..', import.meta.url).pathname);
const appOutputRoot = join(rootDir, 'resources/mihomo');
const execFileAsync = promisify(execFile);

function argValue(name, fallback) {
  const index = process.argv.indexOf(name);
  return index >= 0 ? process.argv[index + 1] : fallback;
}

const platform = argValue('--platform', process.platform);
const arch = argValue('--arch', process.arch);
const version = argValue('--version', process.env.MIHOMO_VERSION || 'latest');
const outputArch = arch === 'x64' ? 'x64' : arch;
const releaseArch = arch === 'x64' ? 'amd64' : arch;
const releasePlatform = platform === 'win32' ? 'windows' : platform;
const outputFile = platform === 'win32' ? 'mihomo.exe.gz' : 'mihomo.gz';
const outputTarget = `${platform}-${outputArch}`;
const appOutputPath = join(appOutputRoot, outputTarget, outputFile);
const enginePackageOutputPath = join(
  rootDir,
  'packages/tunnel-engines',
  outputTarget,
  'resources/engine',
  outputTarget,
  outputFile
);

const assetPatterns = {
  'darwin-arm64': [/^mihomo-darwin-arm64-v[\d.]+\.gz$/],
  'darwin-amd64': [
    /^mihomo-darwin-amd64-compatible-v[\d.]+\.gz$/,
    /^mihomo-darwin-amd64-v1-v[\d.]+\.gz$/,
    /^mihomo-darwin-amd64-v[\d.]+\.gz$/
  ],
  'linux-amd64': [
    /^mihomo-linux-amd64-v1-v[\d.]+\.gz$/,
    /^mihomo-linux-amd64-compatible-v[\d.]+\.gz$/,
    /^mihomo-linux-amd64-v[\d.]+\.gz$/
  ],
  'linux-arm64': [/^mihomo-linux-arm64-v[\d.]+\.gz$/],
  'windows-amd64': [
    /^mihomo-windows-amd64-v1(?:-go\d+)?-v[\d.]+\.zip$/,
    /^mihomo-windows-amd64-compatible-v[\d.]+\.zip$/,
    /^mihomo-windows-amd64-v[\d.]+\.zip$/
  ],
  'windows-arm64': [/^mihomo-windows-arm64-v[\d.]+\.zip$/]
};

async function githubJson(url) {
  const response = await fetch(url, {
    headers: {
      accept: 'application/vnd.github+json',
      'user-agent': 'qpjoy-tunnel-engine-installer'
    }
  });

  if (!response.ok) {
    throw new Error(`GitHub API failed: HTTP ${response.status}`);
  }

  return response.json();
}

function selectAsset(release) {
  const key = `${releasePlatform}-${releaseArch}`;
  const patterns = assetPatterns[key];
  if (!patterns) {
    throw new Error(`Unsupported tunnel engine target: ${platform}-${arch}`);
  }

  for (const pattern of patterns) {
    const asset = release.assets.find((item) => pattern.test(item.name));
    if (asset) {
      return asset;
    }
  }

  throw new Error(`No tunnel engine asset matched ${key} in ${release.tag_name}`);
}

async function downloadAsset(asset, targetPath) {
  const response = await fetch(asset.browser_download_url, {
    headers: { 'user-agent': 'qpjoy-tunnel-engine-installer' }
  });
  if (!response.ok || !response.body) {
    throw new Error(`Download failed: HTTP ${response.status}`);
  }
  await pipeline(response.body, createWriteStream(targetPath));
}

function findExtractedMihomo(dir) {
  for (const name of readdirSync(dir)) {
    const current = join(dir, name);
    const stat = statSync(current);
    if (stat.isDirectory()) {
      const nested = findExtractedMihomo(current);
      if (nested) return nested;
      continue;
    }
    const lower = name.toLowerCase();
    if (lower === 'mihomo' || (lower.startsWith('mihomo-') && lower.endsWith('.exe')) || lower === 'mihomo.exe') {
      return current;
    }
  }
  return null;
}

async function extractZipToGzip(archivePath, targetPath) {
  const scratch = mkdtempSync(join(tmpdir(), 'qpjoy-mihomo-'));
  try {
    if (process.platform === 'win32') {
      await execFileAsync('powershell.exe', [
        '-NoProfile',
        '-Command',
        'Expand-Archive -LiteralPath $args[0] -DestinationPath $args[1] -Force',
        archivePath,
        scratch
      ]);
    } else {
      await execFileAsync('unzip', ['-q', archivePath, '-d', scratch]);
    }

    const executable = findExtractedMihomo(scratch);
    if (!executable) {
      throw new Error(`No mihomo executable found in ${archivePath}`);
    }

    await pipeline(
      createReadStream(executable),
      createGzip({ level: 9 }),
      createWriteStream(targetPath)
    );
  } finally {
    rmSync(scratch, { recursive: true, force: true });
  }
}

async function main() {
  const releaseUrl = version === 'latest'
    ? 'https://api.github.com/repos/MetaCubeX/mihomo/releases/latest'
    : `https://api.github.com/repos/MetaCubeX/mihomo/releases/tags/${version}`;
  const release = await githubJson(releaseUrl);
  const asset = selectAsset(release);

  mkdirSync(dirname(appOutputPath), { recursive: true });
  const archivePath = join(tmpdir(), asset.name);
  await downloadAsset(asset, archivePath);

  if (asset.name.endsWith('.zip')) {
    await extractZipToGzip(archivePath, appOutputPath);
    rmSync(archivePath, { force: true });
  } else {
    copyFileSync(archivePath, appOutputPath);
    rmSync(archivePath, { force: true });
  }

  const copyTargets = [enginePackageOutputPath];
  for (const target of copyTargets) {
    mkdirSync(dirname(target), { recursive: true });
    copyFileSync(appOutputPath, target);
  }
  console.log(`Downloaded ${asset.name}`);
  console.log(`Saved ${appOutputPath}`);
  console.log(`Saved ${enginePackageOutputPath}`);
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
});
