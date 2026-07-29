import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';

const workerSource = readFileSync(
  fileURLToPath(new URL('./site-slot-worker-run.mjs', import.meta.url)),
  'utf8'
);

function functionSource(source, name) {
  const candidates = [`async function ${name}(`, `function ${name}(`];
  const start = candidates
    .map((prefix) => source.indexOf(prefix))
    .filter((index) => index >= 0)
    .sort((left, right) => left - right)[0];
  assert.ok(Number.isInteger(start), `${name} must exist`);
  const parametersStart = source.indexOf('(', start);
  let parametersDepth = 0;
  let parametersEnd = -1;
  for (let index = parametersStart; index < source.length; index += 1) {
    if (source[index] === '(') parametersDepth += 1;
    if (source[index] === ')') parametersDepth -= 1;
    if (parametersDepth === 0) {
      parametersEnd = index;
      break;
    }
  }
  const bodyStart = source.indexOf('{', parametersEnd);
  let depth = 0;
  for (let index = bodyStart; index < source.length; index += 1) {
    if (source[index] === '{') depth += 1;
    if (source[index] === '}') depth -= 1;
    if (depth === 0) return source.slice(start, index + 1);
  }
  throw new Error(`${name} is not balanced`);
}

test('effective artifact transport commands use SITE_SLOT_ARTIFACT_BASE_DIR', () => {
  const artifactBaseDir = resolve('/runtime root', 'site-slots');
  const commandCwd = '/worker-cwd';
  const applyArtifactBaseDir = Function(
    'resolve',
    'artifactBaseDir',
    'commandCwd',
    [
      functionSource(workerSource, 'commandKind'),
      functionSource(workerSource, 'resolveArtifactReference'),
      functionSource(workerSource, 'shellQuote'),
      functionSource(workerSource, 'applyArtifactBaseDir'),
      'return applyArtifactBaseDir;'
    ].join('\n')
  )(resolve, artifactBaseDir, commandCwd);
  const relativeArtifact = './artifacts/site-slots/domestic/mx-domestic-services.tar.gz';
  const command = [
    `if command -v rsync >/dev/null 2>&1; then rsync -az ${relativeArtifact} root@domestic:/opt/mx/incoming/;`,
    `else scp -P 22 ${relativeArtifact} root@domestic:/opt/mx/incoming/; fi`
  ].join(' ');
  const effectiveCommand = applyArtifactBaseDir(command);
  const resolvedArtifact = resolve(artifactBaseDir, 'domestic', 'mx-domestic-services.tar.gz');

  assert.equal(effectiveCommand.split(`'${resolvedArtifact}'`).length - 1, 2);
  assert.doesNotMatch(effectiveCommand, /\.\/artifacts\/site-slots\//);
  assert.equal(
    applyArtifactBaseDir('rsync -az ./artifacts/site-slots/domestic/runtime/ root@domestic:/opt/mx/runtime/'),
    `rsync -az '${resolve(artifactBaseDir, 'domestic', 'runtime')}'/ root@domestic:/opt/mx/runtime/`,
    'rsync directory source semantics must retain the trailing slash'
  );
  assert.equal(
    applyArtifactBaseDir(`ssh -p 22 root@domestic 'test -f ${relativeArtifact}'`),
    `ssh -p 22 root@domestic 'test -f ${relativeArtifact}'`,
    'remote paths must not be rewritten as worker-local artifact paths'
  );

  const effectiveConstruction = /applyArtifactBaseDir\(applySshProfile\(workerStep\.command, sshProfile\)\)/g;
  assert.equal(
    workerSource.match(effectiveConstruction)?.length,
    3,
    'plan, real SSH, and fake transport must share the same effective path resolution'
  );
  assert.match(
    functionSource(workerSource, 'artifactPushEvidence'),
    /artifactReferences\(step\.command\)/,
    'artifact validation and gates must continue to inspect the logical command'
  );
});

test('redacted SSH diagnosis keeps classification without retaining stderr', () => {
  const sshFailureDiagnosis = Function(
    `${functionSource(workerSource, 'sshFailureDiagnosis')}; return sshFailureDiagnosis;`
  )();
  const secret = 'hysteria2://domestic-user:SUBSCRIPTION_SECRET@example.invalid';
  const diagnosis = sshFailureDiagnosis(`Permission denied while reading ${secret}`, 255, true);

  assert.equal(diagnosis.category, 'auth');
  assert.equal(diagnosis.exitCode, 255);
  assert.equal(diagnosis.stderr, '[redacted output]');
  assert.equal(JSON.stringify(diagnosis).includes(secret), false);
  assert.ok(diagnosis.nextActions.includes('rotate-or-bootstrap-internal-managed-key'));

  const visible = sshFailureDiagnosis(`remote failed: ${secret}`, 17, false);
  assert.equal(visible.category, 'remote-command');
  assert.match(visible.stderr, /SUBSCRIPTION_SECRET/);
  assert.equal(sshFailureDiagnosis('', 255, true).stderr, '');
});

test('redacted evidence removes normalized and original commands', () => {
  const redactEvidence = Function(
    `${functionSource(workerSource, 'redactEvidence')}; return redactEvidence;`
  )();
  const commandSecret = 'COMMAND_SECRET';
  const originalSecret = 'ORIGINAL_COMMAND_SECRET';
  const effectiveSecret = 'EFFECTIVE_COMMAND_SECRET';
  const evidence = {
    command: commandSecret,
    originalCommand: originalSecret,
    effectiveCommand: effectiveSecret,
    notes: [],
    executionResult: {
      stderr: '[redacted output]',
      diagnosis: {
        category: 'remote-command',
        stderr: '[redacted output]'
      }
    }
  };
  const redacted = redactEvidence({ redactOutput: true }, evidence);
  const serialized = JSON.stringify(redacted);

  assert.equal(redacted.command, '[redacted command]');
  assert.equal(redacted.originalCommand, '[redacted original command]');
  assert.equal(redacted.effectiveCommand, '[redacted effective command]');
  assert.equal(serialized.includes(commandSecret), false);
  assert.equal(serialized.includes(originalSecret), false);
  assert.equal(serialized.includes(effectiveSecret), false);
  assert.strictEqual(redactEvidence({ redactOutput: false }, evidence), evidence);

  assert.match(
    functionSource(workerSource, 'remoteReadonlyProbeStep'),
    /sshFailureDiagnosis\([\s\S]*step\.redactOutput\)/,
    'read-only probe failures must pass the step redaction policy into diagnosis'
  );
  assert.match(
    functionSource(workerSource, 'artifactPushRemoteSshStep'),
    /sshFailureDiagnosis\([\s\S]*workerStep\.redactOutput\)/,
    'artifact transport failures must pass the normalized step redaction policy into diagnosis'
  );
});
