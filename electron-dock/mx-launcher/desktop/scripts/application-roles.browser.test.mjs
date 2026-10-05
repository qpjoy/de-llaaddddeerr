import test from 'node:test';
import assert from 'node:assert/strict';
import {createServer} from 'node:http';
import {readFileSync} from 'node:fs';
import {once} from 'node:events';
import {resolve,extname,join} from 'node:path';
import {fileURLToPath} from 'node:url';
import {builtinUserCenterRoles} from '../../server/src/store/domain.ts';

// Browser plugin not available: exercise the real renderer with Playwright/Chrome.
test('Launcher user editor grants and revokes application roles without losing existing roles', {skip:!process.env.MX_SSO_BROWSER_MODULE,timeout:60000},async t=>{
 const {chromium}=await import(process.env.MX_SSO_BROWSER_MODULE);
 const staticRoot=fileURLToPath(new URL('../',import.meta.url));
 let user={userId:'usr_root',account:'root',displayName:'root',status:'active',roleIds:['mx-user','mx-release-publisher','retained-custom-role'],profile:{},appAccess:{allowedAppIds:['mx-h2i'],deniedAppIds:[]}},saves=0;
 const server=createServer(async(req,res)=>{
  const path=new URL(req.url,'http://localhost').pathname;
  const send=(data,status=200)=>res.writeHead(status,{'content-type':'application/json'}).end(JSON.stringify(data));
  try {
   if(path==='/auth/admin/session')return send({enabled:true,authenticated:true,canManage:true,csrf:'fixture-csrf',user:{userId:'operator',account:'Operator'}});
   if(path.endsWith('/user-center/roles'))return send({roles:builtinUserCenterRoles()});
   if(path.endsWith('/user-center/users')){
    if(req.method==='POST'){
     assert.ok(path.startsWith('/admin-api/'));assert.equal(req.headers['x-mx-admin-csrf'],'fixture-csrf');
     let raw='';for await(const chunk of req)raw+=chunk;
     const body=JSON.parse(raw);assert.equal(body.userId,user.userId);assert.equal(body.provisionOversea,false);
     assert.deepEqual(body.allowedAppIds,['mx-h2i']);assert.deepEqual(body.deniedAppIds,[]);
     user={...user,roleIds:body.roleIds,displayName:body.displayName};saves++;return send({user});
    }
    return send({users:[user]});
   }
   if(path.includes('/internal/'))return send(path.endsWith('/dashboard')?{overview:{siteId:'fixture',storeDriver:'fixture'},sites:[]}:{});
   if(path==='/favicon.ico')return res.writeHead(204).end();
   const target=resolve(staticRoot,path==='/admin/'?'index.html':path.replace(/^\/admin\//,''));
   if(!target.startsWith(staticRoot))return res.writeHead(404).end();
   res.writeHead(200,{'content-type':({'.html':'text/html','.css':'text/css','.js':'text/javascript'})[extname(target)] || 'application/octet-stream'}).end(readFileSync(target));
  }catch(error){send({message:error.message},500)}
 });
 server.listen(0,'127.0.0.1');await once(server,'listening');t.after(()=>new Promise(r=>server.close(r)));
 const browser=await chromium.launch({channel:'chrome',headless:true});t.after(()=>browser.close());
 const page=await browser.newPage({viewport:{width:1440,height:1100}}),errors=[];
 page.on('pageerror',e=>errors.push(e.message));
 const origin=`http://127.0.0.1:${server.address().port}`;
 await page.goto(`${origin}/admin/`);await page.locator('#login-gate').waitFor({state:'hidden'});
 assert.equal(await page.title(),'MX Launcher');
 await page.locator('#tab-internal').click();await page.locator('#tab-members').click();
 await page.locator('[data-user-open="usr_root"]').click();
 const form=page.locator('[data-user-editor]');
 for(const id of ['mx-user','mx-release-publisher','retained-custom-role'])assert.equal(await form.locator(`[data-user-role][value="${id}"]`).isChecked(),true);
 await form.locator('[data-user-role][value="mx-hub-admin"]').check();
 await form.locator('[data-user-role][value="mx-pay-admin"]').check();
 await form.getByRole('button',{name:'Save User',exact:true}).click();
 await form.locator('.feedback').filter({hasText:'Saved root'}).waitFor();
 assert.equal(saves,1);assert.deepEqual(new Set(user.roleIds),new Set(['mx-user','mx-release-publisher','retained-custom-role','mx-hub-admin','mx-pay-admin']));
 if(process.env.MX_ROLE_SCREENSHOTS)await page.screenshot({path:join(process.env.MX_ROLE_SCREENSHOTS,'launcher-application-roles.png')});
 await form.locator('[data-user-editor-close]').click();await page.locator('[data-user-open="usr_root"]').click();
 await form.locator('[data-user-role][value="mx-pay-admin"]').uncheck();
 await form.getByRole('button',{name:'Save User',exact:true}).click();await page.waitForFunction(()=>document.querySelector('[data-user-editor] .feedback')?.textContent.includes('Saved root'));
 assert.equal(saves,2);assert.ok(!user.roleIds.includes('mx-pay-admin'));assert.ok(user.roleIds.includes('mx-hub-admin'));assert.ok(user.roleIds.includes('retained-custom-role'));
 await page.setViewportSize({width:390,height:844});
 assert.ok(await form.evaluate(el=>el.scrollWidth<=el.clientWidth+1),'mobile drawer does not overflow');
 await form.locator('fieldset').scrollIntoViewIfNeeded();
 if(process.env.MX_ROLE_SCREENSHOTS)await page.screenshot({path:join(process.env.MX_ROLE_SCREENSHOTS,'launcher-application-roles-mobile.png')});
 assert.deepEqual(errors,[]);
});
