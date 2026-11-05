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
        ? 'const e=globalThis.__dataportLoginDialogTest;export const useState=(...a)=>e.useState(...a),useEffect=(...a)=>e.useEffect(...a),useRef=(...a)=>e.useRef(...a);'
        : path === './api'
          ? 'const e=globalThis.__dataportLoginDialogTest;export const loadAccountForm=(...a)=>e.load(...a),startAccountSession=(...a)=>e.start(...a),request=(...a)=>e.request(...a),navigateAfterLogin=(...a)=>e.navigate(...a);'
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
  const previous=globalThis.location, previousFormData=globalThis.FormData;
  globalThis.FormData=class extends Map { constructor(form) { super(Object.entries(form?.values || {})); } };
  globalThis.location={search,replace:value=>redirects.push(value)};
  const unmount=()=>hooks.forEach(h=>h?.cleanup?.());
  t.after(()=>{unmount();globalThis.FormData=previousFormData;if(previous===undefined)delete globalThis.location;else globalThis.location=previous});
  environment.useState=initial=>{
    const i=index++;hooks[i] ||= {value:initial};
    return [hooks[i].value,update=>{hooks[i].value=typeof update==='function'?update(hooks[i].value):update}];
  };
  environment.useRef=initial=>hooks[index++] ||= {current:initial};
  environment.useEffect=(fn,deps)=>{
    const i=index++;
    if(hooks[i]?.deps?.every((value,n)=>Object.is(value,deps[n])))return;
    const cleanup=hooks[i]?.cleanup;hooks[i]={deps};
    effects.push(()=>{cleanup?.();hooks[i].cleanup=fn()});
  };
  environment.load=guards=>new Promise((resolve,reject)=>loads.push({resolve,reject,guards}));
  environment.request=(...args)=>{requests.push(args);return Promise.resolve({})};
  environment.start=()=>assert.fail('mode switching never starts SSO');
  environment.navigate=value=>redirects.push(value);
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
  return {render,settle,mode,form,loads,redirects,changes,requests,unmount};
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

const values={login:'fixture-owner',password:'SyntheticPassword123!',inviteCode:'fixture-invite'};
const submit=f=>f.form().props.onSubmit({preventDefault(){},currentTarget:{values}});

test('MX fields are immediately editable on switching, including while preparation is pending',async t=>{
  const f=fixture(t);f.render();f.mode(false);
  for(const state of [f.render(false),f.render()]) {
    assert.equal(state.props.open,true);
    for(const name of ['login','password','inviteCode'])assert.equal(nodes(state).find(n=>n.props?.name===name).props.disabled,false);
    assert.equal(nodes(state).find(n=>n.props?.className==='auth-submit').props.type,'submit');
  }
  assert.deepEqual(f.redirects,[]);assert.equal(f.requests.length,0);
  f.loads[0].resolve({options:{...options,passwordFirst:true}});await f.settle();
  assert.equal(f.form().key,'mx-owner-login','preparing authentication cannot remount and clear the fields');
});

test('one login click submits credentials once before OIDC; no separate continue action',async t=>{
  const f=fixture(t);f.render();f.mode(false);f.render();
  f.loads[0].resolve({options:{...options,passwordFirst:true}});await f.settle();
  environment.request=(...args)=>{f.requests.push(args);return Promise.resolve({redirect:'https://auth.example.test/authorize?state=fixture'})};
  await Promise.all([submit(f),submit(f)]);
  assert.equal(f.requests.length,1);
  const [path,request]=f.requests[0];assert.equal(path,'/auth/sso/password');
  assert.equal(request.headers['x-mx-csrf'],options.csrf);
  assert.deepEqual(JSON.parse(request.body),{action:'login',formId:options.formId,...values});
  assert.deepEqual(f.redirects,['https://auth.example.test/authorize?state=fixture']);
  assert.ok(!f.redirects[0].includes(values.password));
});

test('wrong credentials remain in the same form, and retry is explicit',async t=>{
  const f=fixture(t);f.render();f.mode(false);f.render();
  f.loads[0].resolve({options:{...options,passwordFirst:true}});await f.settle();
  environment.request=(...args)=>{f.requests.push(args);return Promise.reject(Object.assign(Error('账号或密码不正确'),{status:401}))};
  await submit(f);const failed=await f.settle();
  assert.equal(failed.props.open,true);assert.equal(f.form().key,'mx-owner-login');
  assert.equal(f.requests.length,1);assert.deepEqual(f.redirects,[]);
  assert.equal(nodes(failed).find(n=>n.props?.role==='alert').props.children,'账号或密码不正确');
  await f.settle();assert.equal(f.requests.length,1);
  await submit(f);assert.equal(f.requests.length,2);
});

test('late login response after dialog unmount cannot navigate',async t=>{
  const f=fixture(t);let resolve;
  f.render();f.mode(false);f.render();f.loads[0].resolve({options:{...options,passwordFirst:true}});await f.settle();
  environment.request=()=>new Promise(done=>{resolve=done});
  const pending=submit(f);f.unmount();resolve({redirect:'https://auth.example.test/late'});await pending;
  assert.deepEqual(f.redirects,[]);
});

test('an existing browser MX form keeps its established credential submission endpoint',async t=>{
  const f=fixture(t,{search:'?account=1'});f.render();f.loads[0].resolve({options});await f.settle();
  environment.request=(...args)=>{f.requests.push(args);return Promise.resolve({redirect:'https://auth.example.test/complete'})};
  await submit(f);assert.equal(f.requests[0][0],'/auth/sso/form');
});
