import test from 'node:test'
import assert from 'node:assert/strict'
import {commerceOrderView,CommerceService} from '../../server/commerce/service.mjs'
import {paymentExpiry,paymentTimedOut} from '../../server/commerce/order-state.mjs'
const created='2026-10-21T00:00:00.123Z',expires=Date.parse('2026-10-21T00:30:00.000Z')
const row=()=>({id:'original-order',tenant_id:'original-tenant',created_at:'2026-10-01T00:00:00Z',intent:{product:{name:'Fixture'}},payment:{provider:'alipay',status:'pending',createdAt:created}})
test('checkout timeout follows the original Pay clock and one-minute guard without changing payment facts',t=>{
  const original=row(),before=structuredClone(original)
  assert.equal(paymentExpiry(original.payment),expires)
  assert.equal(paymentTimedOut(original,expires-60000),false)
  assert.equal(paymentTimedOut(original,expires-59999),true)
  t.mock.method(Date,'now',()=>expires-59999)
  const view=commerceOrderView(original)
  assert.equal(view.status,'payment_timeout');assert.equal(view.checkoutAvailable,false)
  assert.equal(view.paymentStatus,'pending');assert.equal(view.paymentExpiresAt,'2026-10-21T00:30:00.000Z')
  assert.deepEqual(original,before)
  assert.equal(paymentTimedOut({...original,payment:{...original.payment,createdAt:'2026-10-21T00:29:00Z'}},expires),false,'old business creation time is not the Pay deadline')
})
test('paid/delivered receipts take priority over timeouts; unknown timestamps and other channels are not guessed',t=>{
  t.mock.method(Date,'now',()=>expires+86400000)
  const original=row()
  assert.equal(commerceOrderView({...original,payment:{...original.payment,status:'paid'}}).status,'delivering')
  assert.equal(commerceOrderView({...original,delivered_at:created}).status,'active')
  for(const payment of [null,{...original.payment,provider:'mock'},{...original.payment,status:'submitted'},{...original.payment,status:'cancelled'},
    {...original.payment,createdAt:undefined},{...original.payment,createdAt:'invalid'},{...original.payment,createdAt:'2026-02-31T00:00:00.000Z'}])
    assert.equal(paymentTimedOut({...original,payment}),false)
})
test('checkout expiry races retain the original error code with a fixed Chinese message',async()=>{
  const original=row(),service=new CommerceService({}, {network:work=>work()})
  service.row=async()=>original
  service.prepare=async()=>({source:{identity:{features:[]},client:{checkout:async()=>{throw Object.assign(Error('Checkout requires at least one minute remaining; retain and query this order'),{code:'payment_checkout_expired',status:409})}}},payment:{...original.payment,createdAt:new Date().toISOString(),id:'original-payment'}})
  await assert.rejects(service.action('original-tenant','original-order','checkout'),error=>error.code==='payment_checkout_expired'&&error.status===409&&error.message==='支付超时，请查询原订单的付款状态。')
  assert.equal(original.payment.status,'pending')
})
test('timed-out checkout cannot reopen a cashier but can refresh the original payment and accept a paid receipt',async t=>{
  t.mock.method(Date,'now',()=>expires+86400000)
  const original=row(),service=new CommerceService({}, {network:work=>work()})
  let checkoutCalls=0,refreshCalls=0
  service.row=async()=>original
  service.prepare=async()=>({source:{identity:{features:[]},client:{
    checkout:async()=>{checkoutCalls++},
    refresh:async()=>{refreshCalls++;return {order:{...original.payment,status:'paid'}}},
  }},payment:original.payment})
  service.attach=async(_row,payment)=>{original.payment=payment}
  await assert.rejects(service.action('original-tenant','original-order','checkout'),{code:'payment_checkout_expired',status:409})
  assert.equal(checkoutCalls,0);assert.equal(original.payment.status,'pending')
  const refreshed=await service.action('original-tenant','original-order','refresh')
  assert.equal(refreshCalls,1);assert.equal(refreshed.status,'delivering');assert.equal(refreshed.paymentStatus,'paid')
})
