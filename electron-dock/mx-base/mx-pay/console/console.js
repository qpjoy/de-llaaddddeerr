const $ = id => document.getElementById(id)
let csrf = null, grants = [], page = 1, busy = false
const statuses = { pending: '待付款', submitted: '待核实', paid: '已确认付款', cancelled: '已取消' }
const message = text => { $('message').textContent = text }
async function api(path, options) {
  const response = await fetch(path, { credentials: 'same-origin', redirect: 'error', ...options })
  if (response.status === 204) return null
  const result = await response.json()
  if (!response.ok) throw new Error(result.error?.message || '请求失败，请稍后再试')
  return result.data ?? result
}
async function load() {
  if (busy) return
  busy = true
  for (const control of $('filters').elements) control.disabled = true
  $('previous').disabled = true; $('next').disabled = true
  $('orders').replaceChildren(); message('正在查询…')
  try {
    const grant = grants[Number($('scope').value)]
    const query = new URLSearchParams({ appId: grant.appId, environment: grant.environment, page: String(page), pageSize: '20', status: $('status').value })
    if ($('businessOrderId').value.trim()) query.set('businessOrderId', $('businessOrderId').value.trim())
    const result = await api(`/console/v1/orders?${query}`)
    for (const order of result.items) {
      const row = document.createElement('tr'), identity = document.createElement('td'), secondary = document.createElement('small')
      identity.textContent = order.businessOrderId; secondary.textContent = order.id; identity.append(secondary); row.append(identity)
      for (const value of [new Intl.NumberFormat('zh-CN', { style: 'currency', currency: order.currency }).format(order.amountMinor / 100), statuses[order.status] || order.status, order.provider, new Date(order.createdAt).toLocaleString('zh-CN')]) {
        const cell = document.createElement('td'); cell.textContent = value; row.append(cell)
      }
      $('orders').append(row)
    }
    $('page').textContent = `第 ${page} 页`
    $('previous').disabled = page <= 1; $('next').disabled = !result.hasMore
    message(result.items.length ? `${grant.appId} · ${grant.environment === 'test' ? '测试环境' : '正式环境'} · 本页 ${result.items.length} 条` : '当前筛选条件下没有支付记录。')
  } catch (error) { message(error.message) }
  finally { busy = false; for (const control of $('filters').elements) control.disabled = false }
}
async function initialize() {
  try {
    const session = await api('/auth/sso/session')
    if (!session.active) { message('请使用统一账号登录。登录后仅显示单独授予的支付查看范围。'); return }
    csrf = session.csrf
    $('login').hidden = true; $('switch').hidden = false; $('logout').hidden = false
    // securityUrl is constructed by the trusted SSO server, never from a query parameter.
    $('security').href = session.securityUrl; $('security').hidden = false
    const principal = await api('/console/v1/me'); grants = principal.grants
    $('account').textContent = principal.displayName
    if (!grants.length) { message(`当前账号尚未获得支付查看权限。账号标识：${principal.subject}。请联系支付中心管理员。`); return }
    grants.forEach((grant, index) => {
      const option = document.createElement('option'); option.value = String(index)
      option.textContent = `${grant.appId} · ${grant.environment === 'test' ? '测试' : '正式'}`; $('scope').append(option)
    })
    $('workspace').hidden = false; await load()
  } catch (error) { message(error.message) }
}
$('filters').addEventListener('submit', event => { event.preventDefault(); if (!busy) { page = 1; void load() } })
$('previous').addEventListener('click', () => { if (!busy && page > 1) { page--; void load() } })
$('next').addEventListener('click', () => { if (!busy) { page++; void load() } })
$('scope').addEventListener('change', () => { if (!busy) { page = 1; void load() } })
$('logout').addEventListener('click', async () => {
  try { await api('/auth/sso/logout', { method: 'POST', headers: { 'x-mx-csrf': csrf } }); location.assign('/') }
  catch (error) { message(error.message) }
})
void initialize()
