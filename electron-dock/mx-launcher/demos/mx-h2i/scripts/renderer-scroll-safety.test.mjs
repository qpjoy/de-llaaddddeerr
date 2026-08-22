import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const source = readFileSync(
  fileURLToPath(new URL('../src/renderer.js', import.meta.url)),
  'utf8'
);

const renderStart = source.indexOf('function render() {');
const renderEnd = source.indexOf('function rememberPhoneScroll() {', renderStart);
assert.ok(renderStart >= 0 && renderEnd > renderStart, 'renderer render function must exist');

const renderSource = source.slice(renderStart, renderEnd);
const rememberIndex = renderSource.indexOf('rememberPhoneScroll();');
const replaceIndex = renderSource.indexOf('root.innerHTML =');
const restoreIndex = renderSource.indexOf('restorePhoneScroll();');
const appCenterRestoreIndex = renderSource.indexOf('restoreAppCenterScroll();');
assert.ok(
  rememberIndex >= 0 && rememberIndex < replaceIndex,
  'phone scroll must be captured before replacing the renderer DOM'
);
assert.ok(
  replaceIndex < restoreIndex && restoreIndex < appCenterRestoreIndex,
  'phone scroll must be restored after DOM replacement without removing AppCenter restoration'
);
assert.match(
  source,
  /class="mx-phone" data-scroll-key="phone:launcher"/,
  'the launcher phone view must have a stable scroll key'
);
assert.match(
  source,
  /class="mx-phone advanced-phone" data-scroll-key="phone:advanced"/,
  'the advanced phone view must have an independent stable scroll key'
);
assert.match(
  source,
  /function retainedConnectionActionLabel\(connection = state\?\.connection\)/,
  'retained guest connection states must have explicit recovery action labels'
);
assert.match(
  source,
  /renewalBlocked[\s\S]*recovering[\s\S]*retainedConnectionActionLabel\(connection\)/,
  'retained tunnel or lease states must keep an explicit recovery label unless product policy blocks renewal'
);
assert.doesNotMatch(
  source,
  /leaseOnly \? '重新连接'/,
  'the startup retained-tunnel UI must not ask users to reconnect while recovery is in progress'
);
assert.match(
  source,
  /function renderConnectionRecoverySteps\(show\)/,
  'retained connection recovery must render step-by-step progress'
);

function functionSource(name) {
  const start = source.indexOf(`function ${name}() {`);
  assert.ok(start >= 0, `${name} must exist`);
  const bodyStart = source.indexOf('{', start);
  let depth = 0;
  for (let index = bodyStart; index < source.length; index += 1) {
    if (source[index] === '{') depth += 1;
    if (source[index] === '}') depth -= 1;
    if (depth === 0) return source.slice(start, index + 1);
  }
  throw new Error(`${name} is not balanced`);
}

let currentPhone = null;
const fakeRoot = {
  querySelector(selector) {
    assert.equal(selector, '.mx-phone[data-scroll-key]');
    return currentPhone;
  }
};
const phoneScrollTops = new Map();
const helpers = Function(
  'root',
  'phoneScrollTops',
  `${functionSource('rememberPhoneScroll')}
${functionSource('restorePhoneScroll')}
return { rememberPhoneScroll, restorePhoneScroll };`
)(fakeRoot, phoneScrollTops);

currentPhone = {
  dataset: { scrollKey: 'phone:advanced' },
  scrollTop: 640
};
helpers.rememberPhoneScroll();
currentPhone = {
  dataset: { scrollKey: 'phone:advanced' },
  scrollTop: 0
};
helpers.restorePhoneScroll();
assert.equal(currentPhone.scrollTop, 640, 'an advanced-page rerender must restore its scroll position');

currentPhone = {
  dataset: { scrollKey: 'phone:launcher' },
  scrollTop: 33
};
helpers.restorePhoneScroll();
assert.equal(currentPhone.scrollTop, 33, 'a launcher view must not inherit the advanced-page scroll position');
currentPhone.scrollTop = 120;
helpers.rememberPhoneScroll();

currentPhone = {
  dataset: { scrollKey: 'phone:advanced' },
  scrollTop: 0
};
helpers.restorePhoneScroll();
assert.equal(currentPhone.scrollTop, 640, 'screen-specific positions must survive navigation between phone views');

currentPhone = null;
assert.doesNotThrow(() => {
  helpers.rememberPhoneScroll();
  helpers.restorePhoneScroll();
}, 'AppCenter renders without a phone scroll container must remain a no-op');

console.log('OK renderer preserves MX-H2I phone scroll independently per screen');
