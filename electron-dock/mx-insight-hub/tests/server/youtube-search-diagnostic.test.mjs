import test from 'node:test'
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { inspectYoutubeArchive, valueFormat } from '../../server/ops/diagnose-youtube-search.mjs'

const archive = data => {
  const bytes = Buffer.from(JSON.stringify({ code: 200, data }))
  return { body_bytes: bytes, body_sha256: createHash('sha256').update(bytes).digest('hex') }
}

test('value formats separate exact counters from display strings without returning values', () => {
  for (const [value, format] of [[1234, 'integer'], ['1234', 'digits'], ['1,234', 'digits_with_commas'], ['12万次观看', 'abbreviated_count'],
    ['1.2M views', 'abbreviated_count'], ['3年前', 'relative_time'], ['3 years ago', 'relative_time'], ['2024-05-01T00:00:00Z', 'iso_date'],
    ['12:34', 'duration'], ['private channel name', 'other_text'], ['', 'empty_string'], [null, 'null']]) {
    assert.equal(valueFormat(value), format, String(value))
  }
})

test('receipt shapes list key names and formats for sample entries without leaking text', () => {
  const report = inspectYoutubeArchive(archive({ videos: [{ video_id: 'privateVideoId', title: 'private title', author: 'private author',
    channel: { name: 'private channel', id: 'privateChannel' }, views: '12万次观看', published_time: '3年前', thumbnails: [{ url: 'https://private.example' }] }],
    channels: [], continuation_token: 'private-token' }))
  assert.equal(report.state, 'archive_verified')
  assert.deepEqual(report.lists, { videos: 1, shorts: 'missing', channels: 0, playlists: 'missing', items: 'missing', contents: 'missing' })
  assert.deepEqual(report.dataKeys, ['channels', 'continuation_token', 'videos'])
  assert.deepEqual(report.samples.videos[0], { author: 'other_text', channel: { id: 'other_text', name: 'other_text' },
    published_time: 'relative_time', thumbnails: { array: 1, first: { url: 'other_text' } }, title: 'other_text',
    video_id: 'other_text', views: 'abbreviated_count' })
  assert.doesNotMatch(JSON.stringify(report), /private/u)
  assert.equal(inspectYoutubeArchive({ ...archive({}), body_sha256: '0'.repeat(64) }).state, 'archive_integrity_failed')
})

test('the command validates its request UUID before reading the database', () => {
  const script = fileURLToPath(new URL('../../server/ops/diagnose-youtube-search.mjs', import.meta.url))
  for (const [args, code] of [[[], 'invalid_arguments'], [['nope'], 'invalid_request_id'], [['462579ff-1cd1-40a1-981c-d3cbb3e3b144'], 'database_url_required']]) {
    const run = spawnSync(process.execPath, [script, ...args], { encoding: 'utf8', env: { PATH: process.env.PATH } })
    assert.equal(JSON.parse(run.stdout).errorCode, code)
  }
})
