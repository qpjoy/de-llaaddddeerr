import test from 'node:test'
import assert from 'node:assert/strict'
import { hasInodeAccounting } from '../packages/test-platform/server/artifacts.mjs'
test('unsupported Windows inode counts are distinct from inode exhaustion', () => {
  assert.equal(hasInodeAccounting({ files: 0, ffree: 0 }, 'win32'), false)
  assert.equal(hasInodeAccounting({ files: 100, ffree: 0 }, 'win32'), true)
  assert.equal(hasInodeAccounting({ files: 0, ffree: 0 }, 'linux'), true)
  assert.equal(hasInodeAccounting({ ffree: 0 }, 'win32'), true)
})
