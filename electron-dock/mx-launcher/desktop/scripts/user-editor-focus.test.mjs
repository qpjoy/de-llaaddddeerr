import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const source = readFileSync(new URL('../renderer.js', import.meta.url), 'utf8');
const openDrawer = source.match(/^function openUserEditorDrawer\([^]*?^\}/m)?.[0];
assert.ok(openDrawer);

test('deferred user drawer autofocus respects ongoing input and drawer lifetime', () => {
  const callbacks = [];
  const field = { focus() { document.activeElement = field; } };
  const typedField = {};
  const document = { activeElement: null };
  const drawer = { hidden: false, contains(node) { return node === field || node === typedField; }, querySelector() { return field; } };
  const state = { userCenter: { overseaLinkRequestGeneration: 0 } };
  const open = Function('state', 'document', 'userEditorDrawer', 'requestAnimationFrame', `
    function createUserEditorDraft() { return {}; }
    function renderUserEditorDrawer() {}
    ${openDrawer}
    return openUserEditorDrawer;
  `)(state, document, drawer, callback => callbacks.push(callback));

  open('create'); callbacks.shift()();
  assert.equal(document.activeElement, field, 'initial focus still enters the form');

  open('create'); document.activeElement = typedField; callbacks.shift()();
  assert.equal(document.activeElement, typedField, 'a fast click into another field must retain focus');

  open('create'); document.activeElement = null; state.userCenter.drawer = null; callbacks.shift()();
  assert.equal(document.activeElement, null, 'closing before the next frame must not steal focus');

  open('create'); open('create'); callbacks.shift()();
  assert.equal(document.activeElement, null, 'an old callback must not focus a newer drawer');
  callbacks.shift()(); assert.equal(document.activeElement, field);
});
