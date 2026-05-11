#!/usr/bin/env node
import { copyFileSync, createWriteStream, mkdirSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { pipeline } from 'node:stream/promises';

const rootDir = resolve(new URL('..', import.meta.url).pathname);
const appOutputRoot = join(rootDir, 'resources/mihomo');
const packageOutputRoot = join(rootDir, 'packages/electron-mihomo-tunnel/resources/engine');

function argValue(name, fallback) {
  const index = process.argv.indexOf(name);
  return index >= 0 ? process.argv[index + 1] : fallback;
}

const platform = argValue('--platform', process.platform);
const arch = argValue('--arch', process.arch);
const version = argValue('--version', process.env.MIHOMO_VERSION || 'latest');
const outputArch = arch === 'x64' ? 'x64' : arch;
const releaseArch = arch === 'x64' ? 'amd64' : arch;
const appOutputPath = join(appOutputRoot, `${platform}-${outputArch}`, 'mihomo.gz');
const packageOutputPath = join(packageOutputRoot, `${platform}-${outputArch}`, 'mihomo.gz');

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
  'linux-arm64': [/^mihomo-linux-arm64-v[\d.]+\.gz$/]
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
  const key = `${platform}-${releaseArch}`;
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

async function main() {
  const releaseUrl = version === 'latest'
    ? 'https://api.github.com/repos/MetaCubeX/mihomo/releases/latest'
    : `https://api.github.com/repos/MetaCubeX/mihomo/releases/tags/${version}`;
  const release = await githubJson(releaseUrl);
  const asset = selectAsset(release);

  mkdirSync(dirname(appOutputPath), { recursive: true });
  mkdirSync(dirname(packageOutputPath), { recursive: true });
  const response = await fetch(asset.browser_download_url, {
    headers: { 'user-agent': 'qpjoy-tunnel-engine-installer' }
  });
  if (!response.ok || !response.body) {
    throw new Error(`Download failed: HTTP ${response.status}`);
  }

  await pipeline(response.body, createWriteStream(appOutputPath));
  copyFileSync(appOutputPath, packageOutputPath);
  console.log(`Downloaded ${asset.name}`);
  console.log(`Saved ${appOutputPath}`);
  console.log(`Saved ${packageOutputPath}`);
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
});
