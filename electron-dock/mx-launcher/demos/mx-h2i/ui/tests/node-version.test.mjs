import assert from 'node:assert/strict';
import test from 'node:test';
import { assertUiNodeVersion } from '../../scripts/ui-node-version.mjs';

test('UI build rejects Node versions without default TypeScript support with an upgrade instruction', () => {
  for (const version of ['20.19.0', '22.16.0', '22.17.1']) {
    assert.throws(() => assertUiNodeVersion(version), (error) => {
      assert.match(error.message, /requires Node\.js >=22\.18\.0/);
      assert.ok(error.message.includes(`current version is ${version}`));
      assert.match(error.message, /Upgrade Node\.js/);
      return true;
    });
  }
});

test('UI build accepts the documented minimum and newer Node versions', () => {
  for (const version of ['22.18.0', '22.18.1', '22.23.5', '24.0.0', process.versions.node]) {
    assert.doesNotThrow(() => assertUiNodeVersion(version));
  }
});
