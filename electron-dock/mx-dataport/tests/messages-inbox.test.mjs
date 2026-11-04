import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { transform } from 'esbuild';

// Execute the actual inbox hook with controlled React scheduling and deferred HTTP.
const environment = {};
globalThis.__dataportInboxTest = environment;
const source = await readFile(new URL('../apps/web/messages.tsx', import.meta.url), 'utf8');
const hook = source.slice(source.indexOf('export function useMessageInbox('), source.indexOf('export function Messages('));
const { code } = await transform(`
  const env=globalThis.__dataportInboxTest;
  const useState=(...args)=>env.useState(...args),useRef=(...args)=>env.useRef(...args),
    useCallback=(...args)=>env.useCallback(...args),useEffect=(...args)=>env.useEffect(...args);
  const request=(...args)=>env.request(...args),document={hidden:false};
  const setInterval=()=>1,clearInterval=()=>{};
  ${hook}`, { loader: 'ts', format: 'esm' });
const { useMessageInbox } = await import(`data:text/javascript;base64,${Buffer.from(code).toString('base64')}`);

function fixture() {
  const hooks=[],pending=[],effects=[];
  let index=0,tenant='enterprise-a',scope='owner';
  const equal=(a,b)=>a && b && a.length===b.length && a.every((v,i)=>Object.is(v,b[i]));
  environment.useState=initial=>{
    const i=index++;hooks[i] ||= {value:initial};
    return [hooks[i].value,update=>{hooks[i].value=typeof update==='function'?update(hooks[i].value):update}];
  };
  environment.useRef=initial=>hooks[index++] ||= {current:initial};
  environment.useCallback=(fn,deps)=>{
    const i=index++;
    if(!equal(hooks[i]?.deps,deps))hooks[i]={value:fn,deps};
    return hooks[i].value;
  };
  environment.useEffect=(fn,deps)=>{
    const i=index++;
    if(equal(hooks[i]?.deps,deps))return;
    const cleanup=hooks[i]?.cleanup;hooks[i]={deps};
    effects.push(()=>{cleanup?.();hooks[i].cleanup=fn()});
  };
  environment.request=path=>new Promise((resolve,reject)=>pending.push({path,resolve,reject}));
  const render=(flush=true)=>{
    index=0;const value=useMessageInbox(tenant,true,scope);
    if(flush)effects.splice(0).forEach(run=>run());
    return value;
  };
  const settle=async()=>{await new Promise(resolve=>setImmediate(resolve));return render()};
  return {render,settle,pending,setScope:value=>{scope=value},setTenant:value=>{tenant=value}};
}

test('role changes immediately clear cached private messages and discard late privileged responses',async()=>{
  const f=fixture();f.render();
  f.pending.shift().resolve({data:{items:[{id:'owner-only'}],unread:1}});
  let state=await f.settle();assert.equal(state.inbox.items[0].id,'owner-only');
  const oldScope=state.scope;
  const oldRequest=state.reload();const late=f.pending.shift();
  f.setScope('employee');state=f.render(false);
  assert.equal(state.inbox,null,'hide old data before passive effects run');assert.notEqual(state.scope,oldScope);
  f.render();late.resolve({data:{items:[{id:'late-owner-only'}],unread:9}});await oldRequest;
  const current=f.pending.shift();current.resolve({data:{items:[{id:'own-ticket'}],unread:1}});
  state=await f.settle();assert.deepEqual(state.inbox,{items:[{id:'own-ticket'}],unread:1});
  f.setTenant('enterprise-b');assert.equal(f.render(false).inbox,null,'tenant switches also clear unread and items synchronously');
});
