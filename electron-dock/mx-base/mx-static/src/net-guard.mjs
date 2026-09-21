import { BlockList, isIP } from 'node:net'

// Addresses an outbound media fetch must never reach. Kept as explicit CIDRs so
// each entry is reviewable; net.BlockList matches IPv4-mapped IPv6 against the
// IPv4 rules, but ONLY when the address type is passed explicitly -- check()
// without a type silently returns false for every IPv6 input.
const V4 = [
  ['0.0.0.0', 8], ['10.0.0.0', 8], ['100.64.0.0', 10], ['127.0.0.0', 8],
  ['169.254.0.0', 16], ['172.16.0.0', 12], ['192.0.0.0', 24], ['192.0.2.0', 24],
  ['192.88.99.0', 24], ['192.168.0.0', 16], ['198.18.0.0', 15], ['198.51.100.0', 24],
  ['203.0.113.0', 24], ['224.0.0.0', 4], ['240.0.0.0', 4],
]
const V6 = [
  ['::', 128], ['::1', 128], ['64:ff9b::', 96], ['100::', 64],
  ['2001:db8::', 32], ['fc00::', 7], ['fe80::', 10], ['ff00::', 8],
]
const blocked = new BlockList()
for (const [net, prefix] of V4) blocked.addSubnet(net, prefix, 'ipv4')
for (const [net, prefix] of V6) prefix === 128 ? blocked.addAddress(net, 'ipv6') : blocked.addSubnet(net, prefix, 'ipv6')

export function isPublicAddress(address) {
  const version = isIP(address)
  if (!version) return false
  return !blocked.check(address, version === 4 ? 'ipv4' : 'ipv6')
}

// Hostnames that resolve to a literal are checked directly; everything else is
// checked after resolution, and the resolved address is what we connect to.
// allowHosts exempts specific hostnames and exists only so tests can point at a
// loopback origin; it names hosts one by one and never disables the rule.
export function assertPublicUrl(value, allowHosts = []) {
  let target
  try { target = new URL(value) } catch { throw Object.assign(new Error('media_url_rejected'), { status: 422, code: 'media_url_rejected' }) }
  const reject = () => { throw Object.assign(new Error('media_url_rejected'), { status: 422, code: 'media_url_rejected' }) }
  if (target.protocol !== 'https:') reject()
  if (target.username || target.password) reject()
  const host = target.hostname.replace(/^\[|\]$/g, '')
  if (!host) reject()
  const exempt = allowHosts.includes(host)
  if (!exempt && (host === 'localhost' || host.endsWith('.localhost') || host.endsWith('.local') || host.endsWith('.internal'))) reject()
  if (!exempt && isIP(host) && !isPublicAddress(host)) reject()
  return target
}
