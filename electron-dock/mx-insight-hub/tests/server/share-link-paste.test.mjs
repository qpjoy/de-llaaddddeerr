import assert from 'node:assert/strict'
import test from 'node:test'
import { scanShareText } from '../../shared/share-link-resolver.mjs'
import { shareClipboardText, sharePasteText } from '../../src/share-link-paste.js'

const douyin = 'https://v.douyin.com/7h9Ip7hjLRY/'
const xhs = 'https://xhslink.cn/o/3EUFAcQijZe'
const targets = text => [...scanShareText(text).urls.keys()]

test('pasting copied titles restores both real anchor destinations in place', () => {
  const title = '长沙是什么法外之地吗!!! #撬车 [图文] - 抖音'
  const plain = `1.71 复制打开抖音，看看【Elowen～的图文作品】 ${title} 08/11 :1pm NjP:/ G@V.lp\n进入小红书探索笔记详情`
  const text = sharePasteText(plain, [{ label: title, href: douyin }, { label: '探索笔记详情', href: xhs }], douyin)
  assert.deepEqual(targets(text), [douyin, xhs])
  assert.match(text, /^1\.71 复制打开抖音/u)
  assert.match(text, /08\/11 :1pm NjP:\/ G@V\.lp/u)
  assert.equal(text.split(douyin).length, 2)
})

test('native paste handles plain and visible URLs; URI lists add missing official URLs only', () => {
  assert.equal(shareClipboardText({ getData: type => type === 'text/plain' ? '只有标题' : '' }), null)
  assert.equal(sharePasteText(douyin, [{ label: douyin, href: douyin }], douyin), null)
  const uris = `# comment\r\n${xhs}\r\njavascript:void(0)\r\nhttps://v.douyin.com.example.org/private\r\n${xhs}`
  assert.equal(sharePasteText('', [], uris), xhs)
  assert.equal(sharePasteText('两条链接 ' + douyin, [], uris), '两条链接 ' + douyin + '\n' + xhs)
})

test('unmatched clipboard labels retain the plain text and the exact official destination', () => {
  const note = 'https://www.xiaohongshu.com/explore/6afedd3200000000260272af?xsec_token=A%2BB&xsec_source=copy'
  const plain = '分享文案（格式已改变）'
  assert.equal(sharePasteText(plain, [
    { href: 'https://elsewhere.example/n', label: '不相关的标题' },
    { href: '/explore/6afedd3200000000260272af', label: '相对地址' },
    { href: note, label: '原始标题' },
  ]), plain + '\n' + note)
})

test('an official-looking title resolves to its actual href even if the href is separately visible', () => {
  const text = sharePasteText(douyin + ' 独立链接 ' + xhs, [{ label: douyin, href: xhs }])
  assert.deepEqual(targets(text), [xhs])
  assert.ok(text.includes('独立链接 ' + xhs))
})

test('an external target masks only its own linked label and is never added to the API input', () => {
  const external = 'https://other.example/private-target'
  const anchors = [{ label: douyin, href: external }]
  const masked = sharePasteText(douyin, anchors)
  assert.deepEqual(targets(masked), [])
  assert.ok(!masked.includes(external))
  const separate = sharePasteText(douyin + ' 来自另一个粘贴来源 ' + douyin, anchors)
  assert.deepEqual(targets(separate), [douyin])
  const restored = sharePasteText(douyin + ' 真实作品', [...anchors, { label: '真实作品', href: douyin }])
  assert.deepEqual(targets(restored), [douyin])
})

test('oversized rich clipboard input is refused before parsing HTML', () => {
  for (const formats of [
    { 'text/plain': '字'.repeat(16_385), 'text/html': '<a>' },
    { 'text/html': ' '.repeat(1024 * 1024 + 1) },
  ]) {
    assert.throws(() => shareClipboardText({ getData: key => formats[key] || '' }), RangeError)
  }
})
