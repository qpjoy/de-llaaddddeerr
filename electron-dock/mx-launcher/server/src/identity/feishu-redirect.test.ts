import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { feishuRedirectPage } from './feishu-redirect.js';

test('Feishu handoff escapes URLs, hashes only its fixed navigation script and retains a manual link', () => {
  const page = feishuRedirectPage('https://accounts.feishu.cn/authorize?state=fixture&hint="</script><script>bad()</script>');
  const script = /<script>([\s\S]+?)<\/script>/.exec(page.html)![1];
  assert.equal(page.scriptHash, `'sha256-${createHash('sha256').update(script).digest('base64')}'`);
  assert.equal(script, "window.location.replace(document.getElementById('feishu-continue').href);");
  assert.equal([...page.html.matchAll(/<script>/g)].length, 1);
  assert.ok(!page.html.includes('"</script>') && !page.html.includes('<form'));
  assert.match(page.html, /id="feishu-continue" href="https:\/\/accounts.feishu.cn\/authorize\?state=fixture&amp;hint=/);
  assert.match(page.html, /rel="noreferrer">继续前往飞书<\/a>/);
  assert.equal(feishuRedirectPage('https://accounts.feishu.cn/authorize?state=other').scriptHash, page.scriptHash);
});

test('Feishu handoff rejects executable URLs, insecure transport and URL credentials', () => {
  for (const url of ['javascript:alert(1)', 'data:text/html,test', 'http://accounts.feishu.cn/', '//accounts.feishu.cn/', 'https://user:password@accounts.feishu.cn/', '']) {
    assert.throws(() => feishuRedirectPage(url));
  }
});
