import test from 'node:test';
import assert from 'node:assert/strict';
import {createServer} from 'node:http';
import {canCheckoutOrder,orderStatusLabel,commerceErrorMessage} from '../apps/web/commerce-state.ts';
import {createHarborApp} from '../apps/server/app.mjs';
test('timed-out orders share Chinese list/detail/export labels and cannot expose stale checkout links',()=>{
  const expired={status:'payment_timeout',paymentStatus:'pending'};
  assert.equal(orderStatusLabel(expired),'支付超时');assert.equal(canCheckoutOrder(expired),false);
  assert.equal(canCheckoutOrder({status:'pending',paymentStatus:'pending',checkoutAvailable:false}),false);
  assert.equal(canCheckoutOrder({status:'pending',paymentStatus:'pending'}),true);
  assert.equal(canCheckoutOrder({status:'delivering',paymentStatus:'paid'}),false);
  assert.equal(canCheckoutOrder({status:'active',deliveredAt:'2026-10-21'}),false);
  assert.equal(orderStatusLabel({status:'active'}),'已开通');
  assert.equal(orderStatusLabel({status:'delivering'}),'正在开通');
  assert.equal(commerceErrorMessage({code:'payment_checkout_expired',message:'Checkout requires at least one minute remaining; retain and query this order'}),'支付超时，请查询原订单的付款状态。');
});
test('BFF never exposes the upstream English checkout-expired error on an old or mixed Hub deployment',async t=>{
  const server=createServer(createHarborApp({config:{upstream:'http://hub.test',gatewayToken:'server-only',sso:{origin:'https://dataport.example.test'}},
    sso:{sessionFor:async()=>({csrf:'csrf',accessToken:'private',subject:'subject'}),verifySession:async()=>{},checkOrigin:()=>{}},
    fetch:async()=>Response.json({error:{code:'payment_checkout_expired',message:'Checkout requires at least one minute remaining; retain and query this order'}},{status:409})}));
  await new Promise(r=>server.listen(0,'127.0.0.1',r));t.after(()=>new Promise(r=>{server.close(r);server.closeAllConnections()}));
  const response=await fetch(`http://127.0.0.1:${server.address().port}/bff/v1/enterprises/11111111-1111-4111-8111-111111111111/orders/22222222-2222-4222-8222-222222222222/checkout`,{method:'POST',headers:{'content-type':'application/json','x-mx-csrf':'csrf'},body:'{}'});
  assert.equal(response.status,409);const body=await response.json();assert.equal(body.code,'payment_checkout_expired');assert.match(body.message,/支付超时/);assert.doesNotMatch(body.message,/Checkout|minute|retain/);
});
