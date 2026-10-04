/** Server-only client. Never bundle clientSecret, access tokens or flow handles into a browser. */
export function createIdentityAccountClient({ issuer, clientId, clientSecret, fetch: transport = fetch }) {
  const endpoint = new URL(`${issuer.replace(/\/$/, '')}/app-account`)
  if (endpoint.protocol !== 'https:' || endpoint.username || endpoint.password) throw new Error('HTTPS identity issuer required')
  return async function account(action, input = {}) {
    const response = await transport(endpoint, {
      method: 'POST', redirect: 'error', signal: AbortSignal.timeout(15000),
      headers: { 'content-type': 'application/json', authorization: `Basic ${Buffer.from(`${clientId}:${clientSecret}`).toString('base64')}` },
      body: JSON.stringify({ action, input }),
    })
    const result = await response.json()
    if (!response.ok) {
      const error = new Error(result.message || '账号服务暂不可用，请稍后重试。')
      error.status = response.status; error.code = result.code || 'account_unavailable'
      throw error
    }
    return result
  }
}
