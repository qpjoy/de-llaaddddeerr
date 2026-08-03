import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const rendererSource = readFileSync(
  fileURLToPath(new URL('../renderer.js', import.meta.url)),
  'utf8'
);

function functionSource(source, name) {
  const start = source.indexOf(`function ${name}(`);
  assert.ok(start >= 0, `${name} must exist`);
  const bodyStart = source.indexOf('{', source.indexOf(')', start));
  let depth = 0;
  for (let index = bodyStart; index < source.length; index += 1) {
    if (source[index] === '{') depth += 1;
    if (source[index] === '}') depth -= 1;
    if (depth === 0) return source.slice(start, index + 1);
  }
  throw new Error(`${name} is not balanced`);
}

const helpers = Function(`
const apps = [
  { productId: 'mx-h2i', displayName: 'MX-H2I', version: '2.1.13', packageName: '@qpjoy/mx-h2i-demo' },
  { productId: 'luopan', displayName: 'Luopan', version: '0.1.0', packageName: '@qpjoy/luopan-demo' }
];
function releaseStandaloneApps() { return apps; }
function releaseProductCurrentVersion(productId) {
  return apps.find((app) => app.productId === productId)?.version || '0.1.0';
}
${functionSource(rendererSource, 'cleanLauncherProductId')}
${functionSource(rendererSource, 'cleanReleaseVersion')}
${functionSource(rendererSource, 'releaseVersionFromFileName')}
${functionSource(rendererSource, 'releaseArtifactHintsFromFileName')}
${functionSource(rendererSource, 'applyReleaseUploadHints')}
${functionSource(rendererSource, 'releaseUploadProductError')}
return { releaseArtifactHintsFromFileName, applyReleaseUploadHints, releaseUploadProductError };
`)();

assert.deepEqual(
  helpers.releaseArtifactHintsFromFileName('Luopan-0.2.1-win32-x64-app.asar'),
  {
    productId: 'luopan',
    version: '0.2.1',
    platform: 'win32',
    arch: 'x64',
    kind: 'asar'
  }
);
assert.equal(
  helpers.releaseArtifactHintsFromFileName('app.asar').productId,
  null,
  'an unidentified file must never silently fall back to mx-h2i'
);

function formWithProduct(value, userEdited = false) {
  const productId = {
    value,
    dataset: userEdited ? { userEdited: 'true' } : {},
    setCustomValidity() {},
    reportValidity() {}
  };
  return {
    elements: {
      productId,
      currentVersion: { value: '' },
      version: { value: '', dataset: {} },
      kind: { value: '' },
      platform: { value: '' },
      arch: { value: '' }
    }
  };
}

const selectedLuopan = formWithProduct('luopan', true);
helpers.applyReleaseUploadHints(selectedLuopan, { productId: null, version: '0.2.1', kind: 'asar' });
assert.equal(selectedLuopan.elements.productId.value, 'luopan', 'empty inference must preserve an explicit Luopan selection');

const inferredLuopan = formWithProduct('', false);
helpers.applyReleaseUploadHints(inferredLuopan, helpers.releaseArtifactHintsFromFileName('Luopan-0.2.1-win32-x64-app.asar'));
assert.equal(inferredLuopan.elements.productId.value, 'luopan', 'the generated Luopan filename should select Luopan');
assert.equal(inferredLuopan.elements.currentVersion.value, '0.1.0');
assert.equal(inferredLuopan.elements.version.value, '0.2.1');

assert.match(
  helpers.releaseUploadProductError(formWithProduct('mx-h2i', true), { name: 'Luopan-0.2.1-win32-x64-app.asar' }),
  /luopan.*mx-h2i/,
  'a recognized Luopan artifact cannot be submitted under MX-H2I'
);
assert.equal(
  helpers.releaseUploadProductError(formWithProduct('luopan', true), { name: 'Luopan-0.2.1-win32-x64-app.asar' }),
  ''
);

assert.match(rendererSource, /请选择发布应用/);
assert.match(rendererSource, /app\.packageName \|\| 'packageName 未登记'/);
assert.match(rendererSource, /productInput\.dataset\.userEdited/);
assert.doesNotMatch(
  functionSource(rendererSource, 'releaseUploadInputFromForm'),
  /\|\| MX_H2I_PRODUCT_ID/,
  'release submission must never use MX-H2I as an implicit identity'
);

console.log('release upload product identity contract: ok');
