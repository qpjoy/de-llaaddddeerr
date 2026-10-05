import test from 'node:test'
import assert from 'node:assert/strict'
import { alipayReturnTrade, restorePaymentReturn, clearPaymentReturn } from '../../shared/payment-return.mjs'
import { landingPathFor } from '../../src/tenant-scope.js'
const trade='MXP1234567812344123a123123456789abc'
const search=`?method=alipay.trade.page.pay.return&out_trade_no=${trade}&sign=UNTRUSTED&total_amount=99999`
function browser(path='/admin/') {
  const storage=new Map(),location=new URL(`https://hub.example.test${path}`)
  const b={location,sessionStorage:{setItem:(k,v)=>storage.set(k,v),getItem:k=>storage.get(k),removeItem:k=>storage.delete(k)}}
  b.history={replaceState:(_,__,url)=>{b.location=new URL(url,b.location)}}
  return b
}
test('payment return selects recharge instead of dashboard, strips all provider fields and survives SSO login',()=>{
  for(const path of ['/admin/','/']) {
    const b=browser(`${path}${search}#/dashboard?range=24h`)
    assert.equal(alipayReturnTrade(b.location.search),trade)
    restorePaymentReturn(b)
    assert.equal(b.location.search,'')
    assert.equal(b.location.hash,`#/payments?paymentReturn=${trade}`)
    b.location=new URL(`https://hub.example.test${path}?sso=ready`)
    restorePaymentReturn(b)
    assert.equal(b.location.hash,`#/payments?paymentReturn=${trade}`)
    clearPaymentReturn(b)
    b.location=new URL(`https://hub.example.test${path}`)
    restorePaymentReturn(b)
    assert.equal(b.location.hash,'')
  }
})
test('malformed returns and arbitrary targets cannot determine payment or navigation',()=>{
  for(const s of ['?out_trade_no='+trade,search+'&out_trade_no='+trade,'?method=alipay.trade.page.pay.return&out_trade_no=https://evil.test'])assert.equal(alipayReturnTrade(s),null)
  const b=browser('/?method=alipay.trade.page.pay.return&sign=secret&out_trade_no=bad')
  restorePaymentReturn(b)
  assert.equal(b.location.search,'');assert.equal(b.location.hash,'#/payments')
  assert.equal(landingPathFor({platformAdmin:false,memberships:[],capabilities:[],canOpenPersonalAccount:true}),'/payments')
  assert.equal(landingPathFor({platformAdmin:true,canOpenPersonalAccount:true}),'/dashboard')
})
