import test from 'node:test'
import assert from 'node:assert/strict'
import { checkoutLocation, paymentQueryMessage, paymentActionError } from '../../shared/payment-checkout.mjs'

test('checkout navigation only accepts the correct Alipay environment over HTTPS', () => {
  for (const [env, host] of [['live','openapi.alipay.com'],['test','openapi-sandbox.dl.alipaydev.com']]) {
    const url=`https://${host}/gateway.do?biz_content=fixture&sign=synthetic`
    assert.equal(checkoutLocation(url,env),url)
    assert.throws(()=>checkoutLocation(url,env==='live'?'test':'live'))
  }
  for (const url of [undefined, '', 'javascript:alert(1)', 'https://evil.test/gateway.do', 'http://openapi.alipay.com/gateway.do',
    'https://openapi.alipay.com:8443/gateway.do', 'https://secret@openapi.alipay.com/gateway.do', 'https://openapi.alipay.com/other']) {
    assert.throws(()=>checkoutLocation(url,'live'),{code:'payment_checkout_url_invalid'})
  }
})

test('query feedback distinguishes missing trades, review and confirmed payment without regressing money state', () => {
  const order={status:'pending',paymentStatus:'pending',paymentQuery:{status:'not_found'}}
  assert.match(paymentQueryMessage(order),/暂未查到/)
  assert.match(paymentQueryMessage({...order,paymentQuery:{status:'pending'}}),/等待付款/)
  assert.match(paymentQueryMessage({...order,paymentQuery:{status:'review'}}),/管理员核对/)
  assert.match(paymentQueryMessage({...order,paymentStatus:'paid'}),/付款已确认/)
  assert.equal(paymentQueryMessage({...order,status:'paid'}),'')
  const error=paymentActionError({code:'payment_channel_query_unknown',status:503,requestId:'trace'})
  assert.match(error.message,/原订单已保留/)
  assert.equal(error.status,503);assert.equal(error.requestId,'trace')
})
