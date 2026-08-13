#!/usr/bin/env node

import { createHash } from 'node:crypto';
import {
  chmodSync,
  cpSync,
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync
} from 'node:fs';
import { join, relative, resolve } from 'node:path';

const STAMP_NAME = '.image-artifact-revision';
const WIREGUARD_MODULE_ID = 'wireguard-config';
const WIREGUARD_FILES = Object.freeze([
  'mx-domestic-wg-relay.conf',
  'mx-domestic-wg.conf',
  'mx-internal-service-peer.conf',
  'mx-internal-service-peer-apply.sh',
  'mx-domestic-relay.env'
]);
const RUNTIME_SUBSCRIPTIONS = Object.freeze([
  {
    moduleId: 'domestic-bootstrap-subscription',
    fileName: 'mx-domestic-bootstrap-subscription.yaml'
  },
  {
    moduleId: 'internal-egress-subscription',
    fileName: 'mx-internal-egress-subscription.yaml'
  }
]);

export function seedSiteSlotArtifacts({ imageDir, runtimeDir }) {
  const imageRoot = resolveRequiredDirectory(imageDir, 'imageDir');
  const runtimeRoot = resolveRequiredPath(runtimeDir, 'runtimeDir');
  if (imageRoot === runtimeRoot) throw new Error('imageDir and runtimeDir must be different directories');

  mkdirSync(runtimeRoot, { recursive: true });
  const revision = imageArtifactRevision(imageRoot);
  if (!revision) {
    return { status: 'no-image-artifacts', revision: null, preservedModules: [] };
  }

  const stampPath = join(runtimeRoot, STAMP_NAME);
  if (readTextIfExists(stampPath)?.trim() === revision) {
    return { status: 'unchanged', revision, preservedModules: [] };
  }

  const preserved = collectRuntimeOwnedDomesticArtifacts(runtimeRoot);
  const domesticManifest = prepareDomesticManifest(imageRoot, preserved);
  copyImageArtifacts(imageRoot, runtimeRoot, preserved);
  commitDomesticArtifacts(runtimeRoot, domesticManifest, preserved);
  writeRevisionStamp(stampPath, revision);

  return {
    status: 'seeded',
    revision,
    preservedModules: [...preserved.modules.keys()].sort()
  };
}

function collectRuntimeOwnedDomesticArtifacts(runtimeRoot) {
  const domesticRoot = join(runtimeRoot, 'domestic');
  const manifest = readJsonIfExists(join(domesticRoot, 'manifest.json'));
  const modules = new Map(
    (Array.isArray(manifest?.modules) ? manifest.modules : [])
      .filter((module) => module && typeof module.moduleId === 'string')
      .map((module) => [module.moduleId, structuredClone(module)])
  );
  const preservedModules = new Map();
  const files = new Map();

  const wireguard = modules.get(WIREGUARD_MODULE_ID);
  const wireguardReady = wireguard?.status === 'ready'
    && wireguard?.metadata?.secretMaterial === 'injected'
    && WIREGUARD_FILES.every((fileName) => existsSync(join(domesticRoot, fileName)));
  if (wireguardReady) {
    preservedModules.set(WIREGUARD_MODULE_ID, wireguard);
    for (const fileName of WIREGUARD_FILES) {
      files.set(fileName, readPreservedFile(join(domesticRoot, fileName)));
    }
  }

  for (const subscription of RUNTIME_SUBSCRIPTIONS) {
    const filePath = join(domesticRoot, subscription.fileName);
    const module = modules.get(subscription.moduleId);
    const runtimeGenerated = ['runtime-generated', 'ready'].includes(module?.status)
      && module?.metadata?.containsSecret === true
      && existsSync(filePath)
      && (statSync(filePath).mode & 0o777) === 0o600;
    if (!runtimeGenerated) continue;
    files.set(subscription.fileName, {
      ...readPreservedFile(filePath),
      mode: 0o600
    });
    preservedModules.set(subscription.moduleId, module);
  }

  return { files, modules: preservedModules };
}

function prepareDomesticManifest(imageRoot, preserved) {
  const manifestPath = join(imageRoot, 'domestic', 'manifest.json');
  const manifest = readJsonIfExists(manifestPath);
  if (!manifest || !Array.isArray(manifest.modules)) {
    throw new Error(`image Domestic artifact manifest is invalid: ${manifestPath}`);
  }
  manifest.modules = manifest.modules.map((module) => {
    const preservedModule = preserved.modules.get(module?.moduleId);
    if (preservedModule) return preservedModule;
    if (RUNTIME_SUBSCRIPTIONS.some(({ moduleId }) => moduleId === module?.moduleId)) {
      return {
        ...module,
        status: 'runtime-generated',
        sha256: null,
        bytes: null
      };
    }
    return module;
  });
  const bytes = Buffer.from(JSON.stringify(manifest, null, 2));
  const sha256 = createHash('sha256').update(bytes).digest('hex');
  return { bytes, sha256 };
}

function copyImageArtifacts(imageRoot, runtimeRoot, preserved) {
  const excluded = new Set([
    'domestic/manifest.json',
    'domestic/manifest.json.sha256',
    ...RUNTIME_SUBSCRIPTIONS.map(({ fileName }) => `domestic/${fileName}`),
    ...[...preserved.files.keys()].map((fileName) => `domestic/${fileName}`)
  ]);
  for (const entry of readdirSync(imageRoot, { withFileTypes: true })) {
    cpSync(join(imageRoot, entry.name), join(runtimeRoot, entry.name), {
      recursive: entry.isDirectory(),
      force: true,
      filter: (source) => !excluded.has(relative(imageRoot, source))
    });
  }
}

function commitDomesticArtifacts(runtimeRoot, manifest, preserved) {
  const domesticRoot = join(runtimeRoot, 'domestic');
  const manifestPath = join(domesticRoot, 'manifest.json');
  mkdirSync(domesticRoot, { recursive: true });

  // Runtime-generated subscription secrets must never be introduced from an
  // image layer. They are restored only when the PVC already owns them.
  for (const { fileName } of RUNTIME_SUBSCRIPTIONS) {
    if (!preserved.files.has(fileName)) rmSync(join(domesticRoot, fileName), { force: true });
  }

  writeFileAtomically(manifestPath, manifest.bytes, 0o644);
  writeFileAtomically(`${manifestPath}.sha256`, `${manifest.sha256}  manifest.json\n`, 0o644);
}

function imageArtifactRevision(imageRoot) {
  const manifestPaths = readdirSync(imageRoot, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => join(imageRoot, entry.name, 'manifest.json'))
    .filter((path) => existsSync(path))
    .sort();
  if (manifestPaths.length === 0) return null;
  const hash = createHash('md5');
  for (const manifestPath of manifestPaths) hash.update(readFileSync(manifestPath));
  return hash.digest('hex');
}

function readPreservedFile(path) {
  return {
    bytes: readFileSync(path),
    mode: statSync(path).mode & 0o777
  };
}

function readJsonIfExists(path) {
  if (!existsSync(path)) return null;
  try {
    return JSON.parse(readFileSync(path, 'utf8'));
  } catch {
    return null;
  }
}

function readTextIfExists(path) {
  return existsSync(path) ? readFileSync(path, 'utf8') : null;
}

function resolveRequiredDirectory(value, name) {
  const path = resolveRequiredPath(value, name);
  if (!existsSync(path) || !statSync(path).isDirectory()) {
    throw new Error(`${name} must be an existing directory: ${path}`);
  }
  return path;
}

function resolveRequiredPath(value, name) {
  if (typeof value !== 'string' || !value.trim()) throw new Error(`${name} is required`);
  return resolve(value);
}

function writeRevisionStamp(stampPath, revision) {
  writeFileAtomically(stampPath, `${revision}\n`, 0o644);
}

function writeFileAtomically(path, content, mode) {
  const temporaryPath = `${path}.${process.pid}.tmp`;
  try {
    writeFileSync(temporaryPath, content, { mode });
    chmodSync(temporaryPath, mode);
    renameSync(temporaryPath, path);
  } finally {
    rmSync(temporaryPath, { force: true });
  }
}

function optionValue(args, name) {
  const index = args.indexOf(name);
  return index >= 0 ? args[index + 1] : null;
}

function main() {
  const args = process.argv.slice(2);
  const imageDir = optionValue(args, '--image-dir');
  const runtimeDir = optionValue(args, '--runtime-dir');
  if (!imageDir || !runtimeDir || args.length !== 4) {
    throw new Error('Usage: node seed-site-slot-artifacts.mjs --image-dir DIR --runtime-dir DIR');
  }
  const result = seedSiteSlotArtifacts({ imageDir, runtimeDir });
  process.stdout.write(`seed-site-slot-artifacts: ${result.status}${result.revision ? ` ${result.revision}` : ''}`
    + `${result.preservedModules.length ? `; preserved ${result.preservedModules.join(',')}` : ''}\n`);
}

if (import.meta.url === `file://${process.argv[1]}`) {
  try {
    main();
  } catch (error) {
    process.stderr.write(`seed-site-slot-artifacts failed: ${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  }
}
