// A channel this desktop adds for its own test browser (docs/25 P3): the
// overseas proxy on its loopback, which the service cannot know about.
//
// It enters where every other channel does — the policy the Runtime re-reads
// before each action — so nothing downstream learns a second mechanism:
//   - the browser reopens on it (BrowserTools.channelOf keys on the proxy),
//     because Chromium resolves its proxy at launch;
//   - the policy revision changes with it, so a confirmation given for one
//     network path is not spent on another (docs/09: 切换的语义).
// Without a local channel the service's policy passes through untouched.

export const EXECUTION_CONFIG = '/api/rig/v1/execution-config'

/** The service's policy, with this desktop's channel for the browser. */
export function withLocalEgress(policy, local) {
  if (!policy || !local?.server) return policy
  return {
    ...policy,
    revision: `${policy.revision}+${local.id}`,
    egress: {
      ...policy.egress,
      browser: local.id,
      browserProxy: { id: local.id, server: local.server, ...(local.bypass ? { bypass: local.bypass } : {}) }
    }
  }
}

/** Every execution-config read through `client` carries the local channel `current()` names. */
export function decorateClient(client, current) {
  const request = client.request.bind(client)
  client.request = async (path, body, signal) => {
    const answer = await request(path, body, signal)
    return path === EXECUTION_CONFIG && answer?.policy ? { ...answer, policy: withLocalEgress(answer.policy, current()) } : answer
  }
  return client
}

/** Only a loopback HTTP proxy is accepted from the desktop: never a remote one. */
export function localChannel(input) {
  if (!input) return null
  const url = new URL(String(input.server ?? ''))
  if (url.protocol !== 'http:' || url.hostname !== '127.0.0.1' || !url.port || url.username || url.pathname !== '/')
    throw new Error('local egress must be a loopback HTTP proxy')
  if (!/^[a-z][a-z0-9-]{1,40}$/.test(String(input.id ?? ''))) throw new Error('local egress needs an id')
  return { id: input.id, server: `http://127.0.0.1:${url.port}`, ...(typeof input.bypass === 'string' && input.bypass ? { bypass: input.bypass.slice(0, 500) } : {}) }
}
