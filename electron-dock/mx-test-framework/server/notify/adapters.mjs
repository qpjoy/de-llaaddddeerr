import { createHmac } from 'node:crypto'

import { AppError } from '../core/errors.mjs'

// How a composed message reaches a person.
//
// Every adapter is the same shape:
//
//   { kind, validate(config), build(message, config) -> {url, headers, body} }
//
// `build` is pure — it returns the request rather than performing it — so every
// adapter is testable without a network, and so delivery, retries and the
// outbox live in exactly one place (dispatch.mjs) instead of once per adapter.
//
// Adding a channel type (email, Slack, PagerDuty, a ticket system) means adding
// one entry here. Nothing else in the platform changes.

/** Plain text, for adapters whose rendering is a single string. */
function asText(message) {
  const lines = [message.title]
  if (message.taskName) lines.push(`任务：${message.taskName}`)

  const { tests, passed, failed, notRun } = message.totals
  if (message.event !== 'blocked') {
    lines.push(`结果：${passed}/${tests} 通过${failed ? `，${failed} 失败` : ''}${notRun ? `，${notRun} 未执行` : ''}`)
  }
  if (message.blockedReason) lines.push(`原因：${message.blockedReason}`)

  for (const entry of message.failedCases) {
    lines.push(`  · ${entry.caseId} ${entry.title}`)
    if (entry.error) lines.push(`    ${entry.error}`)
  }
  if (message.failedCasesOmitted > 0) {
    lines.push(`  · 还有 ${message.failedCasesOmitted} 条失败未列出`)
  }

  if (message.sourceRef) lines.push(`本次：${message.sourceRef.gitSha}`)
  if (message.lastGood) lines.push(`上次通过：${message.lastGood.gitSha}`)
  if (message.runUrl) lines.push(message.runUrl)
  return lines.join('\n')
}

function requireUrl(config, kind) {
  const url = typeof config?.url === 'string' ? config.url.trim() : ''
  let parsed
  try {
    parsed = new URL(url)
  } catch {
    throw new AppError(400, 'invalid_request', `${kind} 渠道需要一个合法的 url`)
  }
  if (!['http:', 'https:'].includes(parsed.protocol)) {
    throw new AppError(400, 'invalid_request', `${kind} 渠道的 url 必须是 http 或 https`)
  }
  return url
}

const adapters = {
  /**
   * Generic JSON POST. The escape hatch that makes this list non-exhaustive:
   * anything with an HTTP endpoint — an internal relay, a mail gateway, a
   * ticket system, a bespoke bot — is reachable without touching this file.
   */
  webhook: {
    kind: 'webhook',
    validate(config) {
      return { url: requireUrl(config, 'webhook'), secret: config?.secret?.trim() || null }
    },
    build(message, config) {
      const body = JSON.stringify(message)
      const headers = { 'content-type': 'application/json' }
      if (config.secret) {
        // Lets the receiver prove the call came from this platform. Same shape
        // GitHub uses, so most relays already understand it.
        headers['x-mxt-signature'] = `sha256=${createHmac('sha256', config.secret).update(body).digest('hex')}`
      }
      return { url: config.url, headers, body }
    },
  },

  /** 飞书 custom group bot. */
  feishu: {
    kind: 'feishu',
    validate(config) {
      const url = requireUrl(config, 'feishu')
      if (!/open\.(feishu|larksuite)\.[a-z.]+\/open-apis\/bot\//u.test(url)) {
        throw new AppError(400, 'invalid_request', '飞书渠道的 url 应当是机器人 webhook 地址')
      }
      return { url, secret: config?.secret?.trim() || null }
    },
    build(message, config) {
      const payload = {
        msg_type: 'text',
        content: { text: asText(message) },
      }
      if (config.secret) {
        // 飞书 signs `<timestamp>\n<secret>` with an empty body and sends the
        // timestamp alongside — an unusual scheme, so it is spelled out rather
        // than assumed to look like everyone else's.
        const timestamp = Math.floor(Date.now() / 1000)
        payload.timestamp = String(timestamp)
        payload.sign = createHmac('sha256', `${timestamp}\n${config.secret}`).digest('base64')
      }
      return {
        url: config.url,
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(payload),
      }
    },
  },

  /** 企业微信 group bot. */
  wecom: {
    kind: 'wecom',
    validate(config) {
      const url = requireUrl(config, 'wecom')
      if (!/qyapi\.weixin\.qq\.com\/cgi-bin\/webhook\/send/u.test(url)) {
        throw new AppError(400, 'invalid_request', '企业微信渠道的 url 应当是群机器人 webhook 地址')
      }
      return { url, secret: null }
    },
    build(message) {
      return {
        url: this.url,
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ msgtype: 'text', text: { content: asText(message) } }),
      }
    },
  },
}

// wecom's build needs the url from config like the others; bind it explicitly
// rather than relying on `this`, which is a footgun when the adapter is
// destructured or passed around.
adapters.wecom.build = (message, config) => ({
  url: config.url,
  headers: { 'content-type': 'application/json' },
  body: JSON.stringify({ msgtype: 'text', text: { content: asText(message) } }),
})

export const NOTIFY_KINDS = Object.keys(adapters)

export function adapterFor(kind) {
  const adapter = adapters[kind]
  if (!adapter) {
    throw new AppError(400, 'invalid_request', `不支持的通知渠道类型：${kind}`)
  }
  return adapter
}

/**
 * Strip credentials before a channel is shown to anyone.
 *
 * A 飞书 bot URL *is* the credential — the token is a path segment — so the
 * whole URL is a secret, not just the `secret` field. Anyone who can read the
 * channel list could otherwise post into the group.
 */
export function redactChannel(channel) {
  const { config, ...rest } = channel
  let host = null
  try {
    host = new URL(config?.url ?? '').host
  } catch {
    host = null
  }
  return {
    ...rest,
    config: {
      // Enough to tell two channels apart, not enough to post to either.
      urlHost: host,
      // Named `signed` rather than `hasSecret` on purpose: the audit scrubber
      // redacts any key matching /secret/, and a boolean that only says whether
      // signing is configured is worth keeping legible in the trail.
      signed: Boolean(config?.secret),
    },
  }
}

export { asText }
