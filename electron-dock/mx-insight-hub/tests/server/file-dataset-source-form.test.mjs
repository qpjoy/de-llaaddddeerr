import assert from 'node:assert/strict'
import test from 'node:test'
import { fileDataset } from '../../shared/file-datasets.mjs'
import { fileDatasetSourceError, initialFileDatasetSource } from '../../src/file-dataset-source-form.mjs'

const roots = (...ids) => ids.map(rootId => ({ rootId }))
const archive = 'email-phone-archive'
const email = fileDataset('email-directory')
const phone = fileDataset('phone-directory')
const twitter = fileDataset('twitter-user-email')

test('unconfigured email and phone forms select their own entry in the mounted archive', () => {
  for (const [product, entry] of [[phone, 'phone_only.txt'], [email, 'email_only.txt']]) {
    assert.deepEqual(initialFileDatasetSource(product, {}, roots('other', 'shared-dir', archive)), {
      rootId: archive, relativePath: 'email-phone.zip', entry, expectedSha256: '',
    })
    assert.deepEqual(initialFileDatasetSource(product, {}, roots('other', 'shared-dir')), {
      rootId: 'shared-dir', relativePath: 'imports/email-phone.zip', entry, expectedSha256: '',
    })
  }
})

test('a saved source takes precedence, including its empty entry and optional fingerprint', () => {
  const saved = { rootId: 'saved-id', relativePath: 'custom.zip', entry: 'subdir/phones.txt' }
  const mounted = roots(archive, 'shared-dir')
  const expectedSha256 = 'a'.repeat(64)
  assert.deepEqual(initialFileDatasetSource(phone, { source: saved, expectedSha256 }, mounted), { ...saved, expectedSha256 })
  const plain = { rootId: 'saved-id', relativePath: 'phones.txt', entry: null }
  assert.deepEqual(initialFileDatasetSource(phone, { source: plain }, mounted), { ...plain, entry: '', expectedSha256: '' })
  assert.equal(initialFileDatasetSource(twitter, { source: { rootId: 'shared-dir', relativePath: 'users.json' }, expectedSha256: null }, mounted).expectedSha256, '')
})

test('the dedicated archive root is never chosen for a new Twitter source', () => {
  for (const [mounted, selection] of [
    [roots(archive, 'alternate', 'shared-dir'), 'shared-dir'],
    [roots(archive, 'alternate'), 'alternate'],
    [roots(archive), ''],
    [[], ''],
  ]) {
    const source = initialFileDatasetSource(twitter, {}, mounted)
    assert.equal(source.rootId, selection)
    assert.equal(source.relativePath, twitter.defaultSource.relativePath)
    assert.equal(source.expectedSha256, twitter.defaultSource.sha256)
  }
})

test('a rejected path explains the mounted IDs and relative-path input and preserves the request ID', () => {
  const error = Object.assign(new Error('Server file path is outside the configured import roots'), {
    code: 'server_file_path_not_allowed', status: 403, requestId: 'request-id',
  })
  const shown = fileDatasetSourceError(error, phone, roots('shared-dir', archive))
  assert.equal(shown.code, error.code)
  assert.equal(shown.status, error.status)
  assert.equal(shown.requestId, error.requestId)
  assert.match(shown.message, /shared-dir、email-phone-archive/u)
  assert.match(shown.message, /清空“服务器路径”/u)
  assert.match(shown.message, /email-phone\.zip/u)
  const internal = fileDatasetSourceError(error, phone, roots('internal')).message
  assert.match(internal, /根目录 ID：internal。/u)
  assert.match(internal, /请将文件放在其中一个挂载目录内/u)
  assert.match(internal, /启用只读挂载 email-phone-archive，部署后重新打开任务/u)
  assert.doesNotMatch(fileDatasetSourceError(error, twitter, roots('internal')).message, /email-phone-archive/u)
  assert.match(fileDatasetSourceError(error, phone, []).message, /未配置可读根目录/u)
  const missing = Object.assign(new Error('File not found'), { code: 'server_file_not_found' })
  assert.equal(fileDatasetSourceError(missing, phone, []), missing)
})
