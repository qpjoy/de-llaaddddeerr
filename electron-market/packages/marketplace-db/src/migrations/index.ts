/**
 * Bundled-with-the-package migrations. Each new schema bump adds a file
 * here and appends to this array. Never re-order or delete — the migrator
 * tracks them by `version` integer.
 */
import type { Migration } from '../Migrator';
import migration001 from './001_initial';

export const bundledMigrations: Migration[] = [migration001];
