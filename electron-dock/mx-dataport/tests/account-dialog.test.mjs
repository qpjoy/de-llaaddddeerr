import test from 'node:test';
import assert from 'node:assert/strict';
import { build } from 'esbuild';
import { createRequire } from 'node:module';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { loadAccountForm } from '../apps/web/api.ts';

const require = createRequire(import.meta.url), environment = {};
globalThis.__dataportLoginDialogTest = environment;
const { outputFiles } = await build({
  stdin: { contents: "export { AccountDialog } from './account-dialog.tsx'", loader: 'js', resolveDir: fileURLToPath(new URL('../apps/web/', import.meta.url)) },
  bundle: true, format: 'esm', platform: 'node', jsx: 'automatic', write: false,
  plugins: [{ name: 'dialog-interaction', setup(builder) {
    builder.onResolve({ filter: /^react\/jsx-runtime$/ }, args => ({ path: pathToFileURL(require.resolve(args.path)).href, external: true }));
    builder.onResolve({ filter: /^react$|^lucide-react$|^\.\/(?:api|dialog)$|^@\/components\/ui\// }, args => ({ path: args.path, namespace: 'fixture' }));
    builder.onLoad({ filter: /.*/, namespace: 'fixture' }, ({ path }) => {
      const names = ['Dialog','DialogContent','DialogHeader','DialogTitle','DialogDescription','DialogClose','Button','Field','FieldGroup','FieldLabel','FieldDescription','FieldError','InputGroup','InputGroupInput','InputGroupAddon','InputGroupButton','Spinner','Layers3','ShieldCheck','Eye','EyeOff','Mail','LockKeyhole','ArrowRight','X'];
      const contents = path === 'react'
        ? 'const e=globalThis.__dataportLoginDialogTest;export const useState=(...a)=>e.useState(...a),useEffect=(...a)=>e.useEffect(...a);'
        : path === './api'
          ? 'const e=globalThis.__dataportLoginDialogTest;export const loadAccountForm=(...a)=>e.load(...a),request=(...a)=>e.request(...a),navigateAfterLogin=()=>{};'
          : names.map(name => `export const ${name}=()=>null;`).join('\n');
      return { contents, loader: 'js' };
    });
  } }],
});
const { AccountDialog } = await import(`data:text/javascript;base64,${Buffer.from(outputFiles[0].contents).toString('base64')}`);
const nodes = tree => !tree || typeof tree !== 'object' ? [] : [tree, ...(Array.isArray(tree.props?.children) ? tree.props.children.flat(Infinity) : [tree.props?.children]).flatMap(nodes)];
const options = { csrf: 'synthetic-csrf', formId: 'synthetic-form', loginHint: 'fixture-owner' };

function fixture(t, { search = '' } = {}) {
  const hooks=[],effects=[],loads=[],redirects=[],changes=[],requests=[];
  let index=0;
  const previous=globalThis.location;
  globalThis.location={search,replace:value=>redirects.push(value)};
  t.after(()=>{hooks.forEach(h=>h?.cleanup?.());if(previous===undefined)delete globalThis.location;else globalThis.location=previous});
  environment.useState=initial=>{
    const i=index++;hooks[i] ||= {value:initial};
    return [hooks[i].value,update=>{hooks[i].value=typeof update==='function'?update(hooks[i].value):update}];
  };
  environment.useEffect=(fn,deps)=>{
    const i=index++;
    if(hooks[i]?.deps?.every((value,n)=>Object.is(value,deps[n])))return;
    const cleanup=hooks[i]?.cleanup;hooks[i]={deps};
    effects.push(()=>{cleanup?.();hooks[i].cleanup=fn()});
  };
  environment.load=guards=>new Promise((resolve,reject)=>loads.push({resolve,reject,guards}));
  environment.request=(...args)=>{requests.push(args);return Promise.resolve({})};
  const render=(flush=true)=>{
    index=0;const session=AccountDialog({open:true,onOpenChange:value=>changes.push(value)});
    const dialog=session.type(session.props);
    if(flush)effects.splice(0).forEach(run=>run());
    return dialog;
  };
  const settle=async()=>{await new Promise(resolve=>setImmediate(resolve));return render()};
  const mode=(employee)=>{
    const group=nodes(render()).find(n=>n.props?.role==='group');
    group.props.children[employee?1:0].props.onClick();
  };
  const form=()=>nodes(render(false)).find(n=>n.type==='form');
  return {render,settle,mode,form,loads,redirects,changes,requests};
}

test('switching employee to MX keeps the dialog open before effects, throughout loading and after readiness',async t=>{
  const f=fixture(t);f.render();f.render();assert.equal(f.loads.length,0);
  assert.equal(f.form().key,'dataport-employee-login');
  f.mode(false);
  const transition=f.render(false);
  assert.equal(transition.props.open,true,'mode changes must never close the controlled dialog');
  const submit=nodes(transition).find(n=>n.props?.className==='auth-submit');assert.equal(submit.props.disabled,true);
  await f.form().props.onSubmit({preventDefault(){}});assert.equal(f.requests.length,0);
  f.render();assert.equal(f.loads.length,1);assert.equal(f.render().props.open,true);
  f.loads[0].resolve({options});const ready=await f.settle();
  assert.equal(ready.props.open,true);assert.equal(f.form().key,'mx-owner-login');
  assert.equal(nodes(ready).find(n=>n.props?.className==='auth-submit').props.disabled,false);
  f.mode(false);assert.equal(f.render().props.open,true);assert.equal(f.loads.length,1,'selecting the current mode does not restart or get stuck');
  assert.deepEqual(f.changes,[]);
});

test('switching back to employee ignores a late MX redirect and keeps local login usable',async t=>{
  const f=fixture(t);f.render();f.mode(false);f.render();
  const pending=f.loads[0];f.mode(true);
  assert.equal(f.render(false).props.open,true);f.render();
  pending.resolve({redirect:'https://auth.example.test/stale'});const employee=await f.settle();
  assert.equal(f.form().key,'dataport-employee-login');assert.deepEqual(f.redirects,[]);
  assert.equal(nodes(employee).find(n=>n.props?.className==='auth-submit').props.disabled,false);
});

test('MX connection failure and retry keep the same dialog open',async t=>{
  const f=fixture(t);f.render();f.mode(false);f.render();
  f.loads[0].reject(Error('Synthetic connection failure'));const failed=await f.settle();
  assert.equal(failed.props.open,true);
  nodes(failed).find(n=>n.props?.className==='auth-submit').props.onClick();
  assert.equal(f.render(false).props.open,true);f.render();
  assert.equal(f.loads.length,2);f.loads[1].resolve({options});
  assert.equal((await f.settle()).props.open,true);assert.deepEqual(f.changes,[]);
});

for (const code of ['account_flow_expired','account_request_failed']) {
  test(`explicit MX selection recovers ${code} with an old account callback marker but automatic callbacks never loop`,async t=>{
    const f=fixture(t,{search:'?account=1'});
    let starts=0,reads=0;
    environment.load=guards=>loadAccountForm({...guards,
      read:async()=>{reads++;throw Object.assign(Error('Synthetic expired flow'),{status:410,code})},
      start:async()=>{starts++;return {redirect:'https://auth.example.test/fresh-oidc-flow'}},
    });
    f.render();const callback=await f.settle();
    assert.equal(callback.props.open,true);assert.equal(starts,0,'failed automatic callback must not restart itself');
    assert.equal(reads,1);
    f.mode(true);f.render();assert.equal(f.form().key,'dataport-employee-login');
    f.mode(false);assert.equal(f.render(false).props.open,true);f.render();
    await f.settle();
    assert.equal(starts,1,'the explicit switch allows exactly one new OIDC flow');
    assert.deepEqual(f.redirects,['https://auth.example.test/fresh-oidc-flow']);
    assert.equal(f.requests.length,0,'reconnecting never resubmits credentials');
    await f.settle();assert.equal(starts,1);
  });
}

test('an explicit MX selection reuses an unexpired form instead of starting another flow',async t=>{
  const f=fixture(t,{search:'?account=1'});
  let reads=0;
  environment.load=guards=>loadAccountForm({...guards,read:async()=>{reads++;return options},start:()=>assert.fail('valid form must not restart')});
  f.render();await f.settle();f.mode(true);f.render();f.mode(false);f.render();
  const ready=await f.settle();
  assert.equal(reads,2);assert.equal(ready.props.open,true);
  assert.equal(nodes(ready).find(n=>n.props?.className==='auth-submit').props.disabled,false);
  assert.deepEqual(f.redirects,[]);
});
