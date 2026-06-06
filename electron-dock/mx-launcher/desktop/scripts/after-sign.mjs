import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { readdir, readFile, writeFile } from 'node:fs/promises';
import { join, relative } from 'node:path';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);
const SIGNABLE_EXTENSIONS = new Set(['.exe', '.dll', '.node']);

export default async function afterSign(context) {
  const appOutDir = context.appOutDir;
  const files = await collectFiles(appOutDir);
  const signable = files.filter((file) => isSignable(file));
  await signWindowsFiles(signable);
  await writePackageManifest(appOutDir, files);
}

async function signWindowsFiles(files) {
  if (process.platform !== 'win32') return;
  const tool = process.env.MX_WINDOWS_SIGNTOOL || process.env.WINDOWS_SIGNTOOL_PATH || 'signtool.exe';
  const thumbprint = process.env.MX_WINDOWS_CERT_SHA1 || process.env.WINDOWS_CERT_SHA1;
  const timestampUrl = process.env.MX_WINDOWS_TIMESTAMP_URL || 'http://timestamp.digicert.com';
  if (!thumbprint) {
    if (process.env.MX_LAUNCHER_STRICT_SIGN === '1') {
      throw new Error('MX_WINDOWS_CERT_SHA1 is required when MX_LAUNCHER_STRICT_SIGN=1');
    }
    console.warn('[mx-launcher] skipping Authenticode signing: MX_WINDOWS_CERT_SHA1 is not set');
    return;
  }
  for (const file of files) {
    await execFileAsync(tool, [
      'sign',
      '/sha1',
      thumbprint,
      '/fd',
      'SHA256',
      '/tr',
      timestampUrl,
      '/td',
      'SHA256',
      file
    ]);
  }
}

async function writePackageManifest(appOutDir, files) {
  const entries = [];
  for (const file of files) {
    entries.push({
      path: normalizePath(relative(appOutDir, file)),
      sha256: await sha256(file)
    });
  }
  entries.sort((a, b) => a.path.localeCompare(b.path));
  const manifest = {
    schemaVersion: 1,
    productId: 'mx-launcher',
    generatedAt: new Date().toISOString(),
    signerThumbprint: process.env.MX_WINDOWS_CERT_SHA1 || process.env.WINDOWS_CERT_SHA1 || null,
    files: entries
  };
  await writeFile(join(appOutDir, 'mx-launcher.package-manifest.json'), JSON.stringify(manifest, null, 2) + '\n');
}

async function collectFiles(root) {
  const out = [];
  async function visit(dir) {
    const entries = await readdir(dir, { withFileTypes: true });
    for (const entry of entries) {
      const target = join(dir, entry.name);
      if (entry.isDirectory()) await visit(target);
      else if (entry.isFile()) out.push(target);
    }
  }
  await visit(root);
  return out;
}

function isSignable(file) {
  const dot = file.lastIndexOf('.');
  if (dot < 0) return false;
  return SIGNABLE_EXTENSIONS.has(file.slice(dot).toLowerCase());
}

async function sha256(file) {
  return createHash('sha256').update(await readFile(file)).digest('hex');
}

function normalizePath(value) {
  return value.split('\\').join('/');
}
