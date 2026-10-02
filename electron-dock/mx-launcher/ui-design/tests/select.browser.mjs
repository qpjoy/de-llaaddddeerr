// Uses an existing Playwright installation; never downloads a browser.
// MX_PLAYWRIGHT_MODULE can point to the host's shared Playwright runtime.
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { once } from 'node:events';
const { chromium } = await import(process.env.MX_PLAYWRIGHT_MODULE || 'playwright');
const html = `<!doctype html><html lang="zh"><head><meta charset="utf-8"><link rel="stylesheet" href="/styles.css"><link rel="stylesheet" href="/select.css"><style>body{margin:24px}form{width:320px}label{display:grid;gap:8px;margin:8px 0}.clipped{height:70px;overflow:hidden}button,input{font:inherit}#outside{position:fixed;right:24px;top:24px}</style></head><body class="qp-app qp-theme-neon-void"><form>
<div class="clipped"><label>操作<select id="action" name="action"><option value="status">查看状态</option><option value="logs">查看日志</option><optgroup label="维护"><option value="deploy">部署当前版本</option><option value="forbidden" disabled>停机（不可选）</option></optgroup><optgroup label="无权限" disabled><option value="denied">不可操作</option></optgroup></select></label></div>
<input id="next" aria-label="下一字段"><label>空选择<select id="empty"></select></label><fieldset disabled><label>继承禁用<select id="disabled"><option>不可编辑</option></select></label></fieldset>
<button type="reset">重置</button><button id="outside" type="button">外部按钮</button></form><div id="dynamic"></div>
<script type="module">import {installNeonSelects} from '/select.js'; window.controls=installNeonSelects(); window.events=[]; document.querySelector('form').addEventListener('input',e=>events.push('input:'+e.target.value)); document.querySelector('form').addEventListener('change',e=>events.push('change:'+e.target.value)); window.escaped=0; window.addEventListener('keydown',e=>{if(e.key==='Escape')window.escaped++});</script></body></html>`;
const server = createServer(async (req, res) => {
  const path = req.url.split('?')[0];
  if (path === '/') { res.setHeader('content-type', 'text/html'); res.end(html); return; }
  if (!['/styles.css','/tokens.css','/select.css','/select.js'].includes(path)) { res.writeHead(404); res.end(); return; }
  res.setHeader('content-type', path.endsWith('.js') ? 'text/javascript' : 'text/css'); res.end(await readFile(new URL('../src' + path, import.meta.url)));
});
server.listen(0, '127.0.0.1'); await once(server, 'listening');
const browser = await chromium.launch({ channel: process.env.MX_BROWSER_CHANNEL || 'chrome', headless: true });
try {
  const page = await browser.newPage({ viewport: { width: 900, height: 720 } }); const errors=[]; page.on('pageerror',e=>errors.push(e.message));
  await page.goto(`http://127.0.0.1:${server.address().port}`);
  await page.waitForFunction(()=>window.controls);
  const action = page.getByRole('combobox', { name:'操作',exact:true });
  assert.equal(await page.locator('.qp-select-control').count(),3);
  assert.ok(await page.getByRole('combobox',{name:'继承禁用',exact:true}).isDisabled());
  await action.click();
  assert.equal(await page.locator('.qp-select-popup').count(),1);
  const popup = await page.locator('.qp-select-popup').boundingBox(); assert.ok(popup.height>70, 'menu must escape clipped parent');
  await page.locator('.qp-select-search').fill('deploy');
  assert.equal(await page.getByRole('option').count(),1);
  await page.keyboard.press('Enter');
  assert.equal(await page.locator('#action').inputValue(),'deploy');
  assert.deepEqual(await page.evaluate(()=>window.events),['input:deploy','change:deploy']);
  assert.equal(await page.evaluate(()=>new FormData(document.querySelector('form')).get('action')),'deploy');
  await action.click(); await page.locator('.qp-select-search').fill('部署');
  await page.locator('.qp-select-search').evaluate(node=>node.dispatchEvent(new KeyboardEvent('keydown',{key:'Enter',isComposing:true,bubbles:true})));
  assert.equal(await page.locator('.qp-select-popup').count(),1,'IME confirmation must not commit a selection');
  await page.keyboard.press('Escape');
  await action.click(); await page.keyboard.press('Enter');
  assert.equal((await page.evaluate(()=>window.events)).length,2,'same selection must not fire extra events');
  await action.click(); await page.locator('.qp-select-search').fill('没有这个名字');
  assert.ok(await page.getByText('没有匹配的选项').isVisible()); await page.keyboard.press('Escape');
  assert.equal(await page.evaluate(()=>document.activeElement.getAttribute('role')),'combobox'); assert.equal(await page.evaluate(()=>window.escaped),0);
  await page.evaluate(()=>{document.querySelector('#action').value='logs'}); assert.match(await action.innerText(),/查看日志/);
  await action.press('ArrowDown'); await page.keyboard.press('End'); await page.keyboard.press('Enter'); assert.equal(await page.locator('#action').inputValue(),'deploy','disabled options must be skipped');
  await action.click(); await page.keyboard.press('Tab'); assert.equal(await page.evaluate(()=>document.activeElement.id),'next');
  await action.click(); await page.getByRole('button',{name:'外部按钮'}).click(); assert.equal(await page.locator('.qp-select-popup').count(),0);
  await page.evaluate(()=>document.querySelector('form').classList.add('qp-theme-neon-void-light'));
  await action.click();
  assert.ok(await page.evaluate(()=>getComputedStyle(document.querySelector('.qp-select-popup')).getPropertyValue('--qp-bg-3')===getComputedStyle(document.querySelector('#action')).getPropertyValue('--qp-bg-3')), 'body portal must inherit the field’s scoped light theme');
  await page.evaluate(()=>document.querySelector('form').classList.remove('qp-theme-neon-void-light'));
  await page.waitForFunction(()=>getComputedStyle(document.querySelector('.qp-select-popup')).getPropertyValue('--qp-bg-3')===getComputedStyle(document.querySelector('#action')).getPropertyValue('--qp-bg-3'));
  await page.evaluate(()=>{window.mutations=0;window.mo=new MutationObserver(r=>window.mutations+=r.length);mo.observe(document.querySelector('.qp-select-popup'),{subtree:true,childList:true,attributes:true})});
  await page.waitForTimeout(150); const first=await page.evaluate(()=>window.mutations); await page.waitForTimeout(150); assert.equal(await page.evaluate(()=>window.mutations),first,'idle menu must not continuously mutate'); await page.evaluate(()=>mo.disconnect());
  await page.evaluate(()=>{document.querySelector('#action option[value=logs]').label='最新日志';document.querySelector('#action').value='logs'}); await page.waitForFunction(()=>document.querySelector('.qp-select-trigger').textContent.includes('最新日志'));
  await page.evaluate(()=>{document.querySelector('#action').disabled=true}); await page.waitForFunction(()=>!document.querySelector('.qp-select-popup')); assert.ok(await action.isDisabled());
  await page.evaluate(()=>{document.querySelector('#action').disabled=false}); await page.getByRole('button',{name:'重置'}).click(); await page.waitForFunction(()=>document.querySelector('.qp-select-trigger').textContent.includes('查看状态'));
  await page.getByRole('combobox',{name:'空选择',exact:true}).click(); assert.ok(await page.getByText('没有匹配的选项').isVisible()); await page.keyboard.press('Escape');
  await page.evaluate(()=>{document.querySelector('#dynamic').innerHTML='<form id="required-form"><label>必填<select required id="required"><option value="">请选择</option><option value="yes">确认</option></select></label><button type="submit">提交</button></form>'});
  await page.getByRole('button',{name:'提交',exact:true}).click();
  assert.ok(await page.locator('.qp-select-validation:not([hidden])').isVisible()); assert.equal(await page.evaluate(()=>document.activeElement.getAttribute('aria-label')),'必填');
  await page.getByRole('combobox',{name:'必填',exact:true}).click(); await page.getByRole('option',{name:'确认',exact:true}).click(); assert.equal(await page.locator('#required').inputValue(),'yes');
  await page.getByRole('combobox',{name:'必填',exact:true}).click();
  await page.evaluate(()=>document.querySelector('#dynamic').replaceChildren()); await page.waitForFunction(()=>!document.querySelector('.qp-select-popup'));
  await page.setViewportSize({width:390,height:720}); await action.click(); const mobile=await page.locator('.qp-select-popup').boundingBox(); assert.ok(mobile.x>=0 && mobile.x+mobile.width<=390); await page.keyboard.press('Escape');
  await page.evaluate(()=>{controls.destroy()}); assert.equal(await page.locator('.qp-select-control').count(),0); assert.equal(await page.locator('select[aria-hidden]').count(),0); assert.equal(await page.locator('#action').getAttribute('tabindex'),null);
  assert.deepEqual(errors,[]);
  console.log('Neon Void select: PASS — selection/search/keyboard/IME-safe keys/groups/disabled/form events/reset/validation/programmatic values/portal/cleanup/mobile; no runtime errors');
} finally { await browser.close(); await new Promise(resolve=>server.close(resolve)); }
