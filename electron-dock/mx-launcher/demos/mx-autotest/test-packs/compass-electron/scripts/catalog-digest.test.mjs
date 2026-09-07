import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

import { CATALOG_DIGEST_ALGORITHM, catalogDigest } from './catalog-digest.mjs';

const catalog = JSON.parse(readFileSync(new URL('../case-catalog.electron.json', import.meta.url), 'utf8'));

test('catalog digest ignores deployment location and set ordering', () => {
  const deploymentCopy = {
    catalogFile: 'mx-auto-server/catalogs/compass-electron.json',
    ...catalog,
    cases: [...catalog.cases]
      .reverse()
      .map((entry) => ({ ...entry, tags: [...(entry.tags || [])].reverse() }))
  };
  assert.equal(CATALOG_DIGEST_ALGORITHM, 'mx-catalog-canonical-v1');
  assert.equal(catalogDigest(deploymentCopy), catalogDigest(catalog));
});

test('catalog digest changes when an acceptance assertion changes', () => {
  const changed = structuredClone(catalog);
  changed.cases[0].title = `${changed.cases[0].title} changed`;
  assert.notEqual(catalogDigest(changed), catalogDigest(catalog));
});
