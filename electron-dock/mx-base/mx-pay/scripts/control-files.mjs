// Node built-ins only. Private inputs survive redeploy and are excluded from images/Git.
import { existsSync, readFileSync, statSync } from 'node:fs'
import { randomBytes } from 'node:crypto'
import { writePrivate, assert } from './runtime.mjs'
export function prepareControl(root, env, retained = {}, enrolled = false) {
  if (!env.MX_PAY_CONTROL_KEY_SOURCE) return
  const marker = `${root}/.deploy/control-enrolled.json`
  const key = env.MX_PAY_CONTROL_KEY_SOURCE
  if (!existsSync(key)) {
    assert(retained['control.key'] || !enrolled && !existsSync(marker),'Payment control key missing; restore original key, never rotate on redeploy')
    writePrivate(key,retained['control.key'] || randomBytes(32).toString('hex')+'\n',true)
  }
  assert(!(statSync(key).mode & 0o077),'Payment control key must have mode 0600')
  const value = readFileSync(key,'utf8').trim()
  assert(/^[a-f0-9]{64}$/.test(value),'Invalid payment control key (value hidden)')
  assert(!retained['control.key'] || value===retained['control.key'].trim(),'Payment control key differs from retained installation; restore original key')
  if (!existsSync(env.MX_PAY_CHANNEL_DRAFTS_SOURCE)) writePrivate(env.MX_PAY_CHANNEL_DRAFTS_SOURCE,retained['channel-drafts.json'] || '[]\n',true)
  const drafts=JSON.parse(readFileSync(env.MX_PAY_CHANNEL_DRAFTS_SOURCE,'utf8'))
  assert(Array.isArray(drafts) && drafts.length<=32,'Invalid payment channel draft file (values hidden)')
  assert(!(statSync(env.MX_PAY_CHANNEL_DRAFTS_SOURCE).mode & 0o077),'Payment channel drafts must have mode 0600')
  writePrivate(marker,{version:1},true)
}
