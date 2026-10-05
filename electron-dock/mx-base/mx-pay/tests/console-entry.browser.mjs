import assert from 'node:assert/strict'

// Run within console-sso.test.mjs against its real Launcher OIDC and disposable PG.
export async function verifyConsoleEntry({origin,setScopes}){
 const {chromium}=await import(process.env.MX_SSO_BROWSER_MODULE)
 const browser=await chromium.launch({channel:'chrome',headless:true})
 const errors=[],consoleErrors=[]
 async function tab(){
  const context=await browser.newContext({ignoreHTTPSErrors:true,viewport:{width:1440,height:960}})
  await context.route('**/favicon.ico',route=>route.fulfill({status:204}))
  const page=await context.newPage(),state={logins:0}
  page.on('pageerror',error=>errors.push(error.message))
  page.on('console',entry=>{if(entry.type()==='error')consoleErrors.push(entry.text())})
  page.on('request',request=>{if(new URL(request.url()).pathname==='/auth/sso/login')state.logins++})
  return {context,page,state}
 }
 const waitMessage=(page,text)=>page.locator('#message').filter({hasText:text}).waitFor()
 const ready=async page=>{
  await page.locator('#navigation').waitFor()
  await page.locator('#message').filter({hasText:/已加载|当前没有记录/}).waitFor()
  assert.equal(await page.title(),'MX Pay · 支付中心')
  assert.equal(new URL(page.url()).origin,origin)
  assert.equal(new URL(page.url()).pathname,'/')
  assert.equal(new URL(page.url()).searchParams.has('sso'),false)
  assert.equal(await page.locator('#account').textContent(),'Payment viewer')
 }
 const signIn=async page=>{
  await page.locator('#login').fill('person')
  await page.locator('#password').fill('test-password')
  await page.getByRole('button',{name:'登录并继续',exact:true}).click()
  await ready(page)
 }
 const noOverflow=async page=>assert.equal(await page.locator('body').evaluate(el=>el.scrollWidth>innerWidth),false)
 try{
  const {context,page,state}=await tab()
  // First entry goes directly to real Auth. There is no extra Pay login click.
  await page.goto(origin)
  await page.locator('#password').waitFor()
  assert.equal(state.logins,1)
  await signIn(page)
  await page.getByRole('button',{name:'支付渠道',exact:true}).click()
  await page.locator('#title').filter({hasText:'支付渠道'}).waitFor()
  await page.getByRole('button',{name:'新增渠道',exact:true}).waitFor()
  await noOverflow(page)
  await page.screenshot({path:'/tmp/mx-pay-entry-admin-desktop.png'})
  await page.reload();await ready(page)
  assert.equal(state.logins,1,'Pay session restores without another authorization request')

  // Remove just the Pay cookie: the retained Launcher session is reused automatically.
  await context.clearCookies({name:'__Host-mx-pay_sso'})
  await page.goto(origin);await ready(page)
  assert.equal(state.logins,2)
  // Failed logout must leave the authenticated page and session intact.
  await page.route('**/auth/sso/logout',route=>route.fulfill({status:503,json:{error:{message:'fixture logout unavailable'}}}))
  await page.getByRole('button',{name:'退出',exact:true}).click()
  await waitMessage(page,'fixture logout unavailable')
  assert.equal(await page.locator('#workspace').isVisible(),true)
  await page.unroute('**/auth/sso/logout')
  await page.getByRole('button',{name:'退出',exact:true}).click()
  await waitMessage(page,'你已退出支付中心')
  await page.reload();await waitMessage(page,'你已退出支付中心')
  await page.locator('.brand').click();await waitMessage(page,'你已退出支付中心')
  assert.equal(state.logins,2,'refresh/brand navigation after logout cannot silently sign back in')
  assert.ok((await page.locator('main').boundingBox()).width>1100,'hidden sidebar must not constrain the landing page')
  await page.screenshot({path:'/tmp/mx-pay-entry-signed-out-desktop.png'})
  await page.getByRole('link',{name:'统一登录',exact:true}).click();await ready(page)
  assert.equal(state.logins,3,'manual login after logout reuses Auth')

  const invitation='a'.repeat(43)
  await context.clearCookies({name:'__Host-mx-pay_sso'})
  await page.goto(`${origin}/?entry=invite#invite=${invitation}`);await ready(page)
  await page.getByRole('button',{name:'接受支付邀请',exact:true}).waitFor()
  assert.equal(await page.evaluate(()=>sessionStorage.getItem('mx-pay-invitation')),invitation)
  assert.equal(new URL(page.url()).hash,'','invitation stays out of Auth URLs')
  assert.equal(state.logins,4)
  await page.getByRole('button',{name:'忽略邀请',exact:true}).click()

  // Generic Launcher admin without a Pay grant sees a full-width authorization message.
  setScopes(['mx:admin'])
  await page.reload();await waitMessage(page,'尚未获得支付权限')
  assert.equal(state.logins,4,'lack of permissions must not trigger another login')
  assert.equal(await page.locator('#workspace').isVisible(),false)
  assert.ok((await page.locator('main').boundingBox()).width>1100)
  await page.setViewportSize({width:390,height:844});await noOverflow(page)
  await page.screenshot({path:'/tmp/mx-pay-entry-no-permission-mobile.png'})
  setScopes(['mx:pay:admin'])
  await page.reload();await ready(page);await noOverflow(page)
  await page.screenshot({path:'/tmp/mx-pay-entry-admin-mobile.png'})

  const failed=await tab()
  await failed.page.goto(`${origin}/?sso=ready`)
  await waitMessage(failed.page,'登录状态未能保存')
  await failed.page.reload();await waitMessage(failed.page,'登录状态未能保存')
  assert.equal(failed.state.logins,0,'a callback without a cookie must stop')

  const cancelled=await tab()
  await cancelled.page.route('**/auth/sso/login',route=>route.fulfill({status:303,headers:{location:'/'}}))
  await cancelled.page.goto(origin);await waitMessage(cancelled.page,'统一登录尚未完成')
  await cancelled.page.reload();await waitMessage(cancelled.page,'统一登录尚未完成')
  assert.equal(cancelled.state.logins,1,'returning without a completed login must not loop')

  const unavailable=await tab()
  await unavailable.page.route('**/auth/sso/session',route=>route.fulfill({status:503,json:{error:{message:'fixture session unavailable'}}}))
  await unavailable.page.goto(origin);await waitMessage(unavailable.page,'fixture session unavailable')
  assert.equal(unavailable.state.logins,0,'session failure must not be mistaken for signed out')
  await unavailable.page.unroute('**/auth/sso/session')
  await unavailable.page.reload();await unavailable.page.locator('#password').waitFor()
  assert.equal(unavailable.state.logins,1,'recovery can start a fresh login')

  const noStorage=await tab()
  await noStorage.page.addInitScript(()=>Object.defineProperty(window,'sessionStorage',{get(){throw new DOMException('Blocked','SecurityError')}}))
  await noStorage.page.goto(origin);await waitMessage(noStorage.page,'浏览器无法保存登录跳转状态')
  assert.equal(noStorage.state.logins,0)
  await noStorage.page.getByRole('link',{name:'统一登录',exact:true}).click()
  await signIn(noStorage.page)
  assert.deepEqual(errors,[])
  assert.deepEqual(consoleErrors.filter(message=>!message.includes('503 (Service Unavailable)')),[],'only the two injected outage responses may log errors')
  console.log('Pay browser entry passed: real OIDC, automatic Auth reuse, explicit logout/retry, invitation retention, denied role, callback/cancellation/outage guards, blocked storage, desktop 1440px/mobile 390px')
 }finally{
  setScopes(['mx:pay:admin'])
  await browser.close()
 }
}
