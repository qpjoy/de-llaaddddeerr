import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import test from 'node:test'

test('legacy error notifications render as accessible danger toasts', async () => {
  const source = await readFile(new URL('../../src/components.jsx', import.meta.url), 'utf8')

  assert.match(source, /toast\.tone === 'error' \? 'danger' : toast\.tone/u)
  assert.match(source, /role=\{tone === 'danger' \? 'alert' : 'status'\}/u)
  assert.match(source, /mih-toast--\$\{tone\}/u)
})
