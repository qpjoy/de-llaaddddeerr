import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const { renderReleaseNotesMarkdown } = require('../src/release-notes-markdown.js');

const rendered = renderReleaseNotesMarkdown([
  '# 第一版',
  '',
  '- 支持 **ASAR 热更新**',
  '- 阅读 [发版说明](https://example.com/releases?id=1&channel=stable)',
  '',
  '> 灰度发布',
  '',
  '```js',
  '<script>alert("unsafe")</script>',
  '```'
].join('\n'));

assert.match(rendered, /<h1>第一版<\/h1>/);
assert.match(rendered, /<ul><li>支持 <strong>ASAR 热更新<\/strong><\/li>/);
assert.match(rendered, /href="https:\/\/example\.com\/releases\?id=1&amp;channel=stable"/);
assert.match(rendered, /<blockquote>灰度发布<\/blockquote>/);
assert.match(rendered, /&lt;script&gt;alert\(&quot;unsafe&quot;\)&lt;\/script&gt;/);
assert.doesNotMatch(rendered, /<script|onclick=|javascript:/i);

const rawHtml = renderReleaseNotesMarkdown('<img src=x onerror=alert(1)>');
assert.equal(rawHtml, '<p>&lt;img src=x onerror=alert(1)&gt;</p>');

const unsafeLink = renderReleaseNotesMarkdown('[危险链接](javascript:alert(1))');
assert.doesNotMatch(unsafeLink, /href=/);

const rendererSource = readFileSync(
  fileURLToPath(new URL('../src/renderer.js', import.meta.url)),
  'utf8'
);
const mainSource = readFileSync(
  fileURLToPath(new URL('../src/main-runtime.cjs', import.meta.url)),
  'utf8'
);
assert.match(rendererSource, /renderReleaseUpdatePrompt\(\)[\s\S]*release-update-dialog__notes/);
assert.match(rendererSource, /renderReleaseNotesMarkdown\(update\.releaseNotes\)/);
assert.doesNotMatch(mainSource, /promptForLauncherUpdate|lastPromptedReleaseUpdateKey/);

console.log('release notes markdown tests passed');
