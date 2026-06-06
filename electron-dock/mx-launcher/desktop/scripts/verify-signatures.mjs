import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);
const manifestPath = process.argv[2];

if (!manifestPath) {
  console.error('usage: node scripts/verify-signatures.mjs <mx-launcher.package-manifest.json>');
  process.exit(2);
}

const manifest = JSON.parse(await readFile(manifestPath, 'utf8'));
const root = dirname(manifestPath);
for (const entry of manifest.files || []) {
  const file = join(root, entry.path);
  const actual = await sha256(file);
  if (actual !== entry.sha256) {
    throw new Error(`hash mismatch: ${entry.path}`);
  }
  if (process.platform === 'win32' && isSignable(entry.path)) {
    await verifyAuthenticode(file, manifest.signerThumbprint);
  }
}

console.log(`[mx-launcher] verified ${manifest.files.length} package files`);

async function verifyAuthenticode(file, expectedThumbprint) {
  const script = [
    '$sig = Get-AuthenticodeSignature -LiteralPath $args[0]',
    'if ($sig.Status -ne "Valid") { throw "invalid signature: $($sig.Status)" }',
    expectedThumbprint
      ? 'if ($sig.SignerCertificate.Thumbprint -ne $args[1]) { throw "unexpected signer thumbprint" }'
      : ''
  ].filter(Boolean).join('; ');
  await execFileAsync('powershell.exe', [
    '-NoProfile',
    '-ExecutionPolicy',
    'Bypass',
    '-Command',
    script,
    file,
    expectedThumbprint || ''
  ]);
}

async function sha256(file) {
  return createHash('sha256').update(await readFile(file)).digest('hex');
}

function isSignable(file) {
  return /\.(exe|dll|node)$/i.test(file);
}
