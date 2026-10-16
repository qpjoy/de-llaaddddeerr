import { createHash } from 'node:crypto';

export const CATALOG_DIGEST_ALGORITHM = 'mx-catalog-canonical-v1';

const ROOT_FIELDS = ['schemaVersion', 'application', 'surface', 'suite', 'executionMode', 'coverage'];
const CASE_FIELDS = [
  'id',
  'title',
  'priority',
  'tags',
  'tracks',
  'spec',
  'suite',
  'requirementRef',
  'retired',
  'coverageMode',
  'automationState',
  'prerequisites'
];
const SET_FIELDS = new Set(['tags', 'tracks', 'prerequisites']);

function stableValue(value) {
  if (Array.isArray(value)) return value.map(stableValue);
  if (!value || typeof value !== 'object') return value;
  return Object.fromEntries(
    Object.keys(value)
      .sort()
      .filter((key) => value[key] !== undefined)
      .map((key) => [key, stableValue(value[key])])
  );
}

function projection(record, fields) {
  return Object.fromEntries(
    fields
      .filter((field) => record[field] !== undefined)
      .map((field) => {
        const value =
          SET_FIELDS.has(field) && Array.isArray(record[field])
            ? [...new Set(record[field])].sort()
            : record[field];
        return [field, stableValue(value)];
      })
  );
}

export function canonicalCatalogDocument(input) {
  const catalog = typeof input === 'string' || Buffer.isBuffer(input) ? JSON.parse(input.toString()) : input;
  if (!catalog || typeof catalog !== 'object' || !Array.isArray(catalog.cases)) {
    throw new Error('Catalog must be an object with a cases array.');
  }
  const root = projection(catalog, ROOT_FIELDS);
  root.cases = catalog.cases
    .map((entry) => projection(entry, CASE_FIELDS))
    .sort((left, right) => String(left.id || '').localeCompare(String(right.id || '')));
  return JSON.stringify(stableValue(root));
}

export function catalogDigest(input) {
  return `sha256:${createHash('sha256').update(canonicalCatalogDocument(input)).digest('hex')}`;
}
