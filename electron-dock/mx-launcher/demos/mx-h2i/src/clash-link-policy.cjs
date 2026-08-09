'use strict';

/**
 * 决定水合订阅时要不要签发那条给 Clash 用的 token 链接。
 *
 * 唯一真正危险的动作是「签发」：它会立即吊销上一条，已经配进 Clash 的订阅当场失效。
 * 所以这段逻辑单独拆出来测——判断错了不是显示问题，是把用户的订阅弄断了。
 *
 * - reuse       本机有还没过期的明文链接，直接用。
 * - remote-only 服务端有活跃链接，但本机没有明文（明文只在签发响应里出现一次）。
 *               **不签发**，交给用户显式「重新生成」。
 * - issue       两边都没有，可以安全签发。
 */
function decideClashLinkAction(input = {}) {
  const now = Number.isFinite(input.now) ? input.now : Date.now();
  if (isUsableLink(input.local, now)) return 'reuse';
  if (isActiveRemoteLink(input.remote, now)) return 'remote-only';
  return 'issue';
}

/** 本机副本可用 = 有明文 URL 且没过期。没写过期时间的当作长期有效。 */
function isUsableLink(link, now) {
  if (!link || typeof link !== 'object') return false;
  if (!link.url) return false;
  return !isExpired(link.expiresAt, now);
}

/** 服务端元数据只有时间，没有明文；过期的等于不存在，可以放心签发新的。 */
function isActiveRemoteLink(link, now) {
  if (!link || typeof link !== 'object') return false;
  if (!link.issuedAt && !link.expiresAt) return false;
  return !isExpired(link.expiresAt, now);
}

function isExpired(expiresAt, now) {
  const parsed = Date.parse(expiresAt || '');
  return Number.isFinite(parsed) && parsed <= now;
}

/**
 * 顺着 mihomo 的 group -> now 一路找到真正出流量的那个节点。
 *
 * 用户选中的是 select 组里的 `Oversea-Auto` 时，实际节点由 fallback 组的健康探测决定，
 * 可能已经顺延到列表后面去了；只看用户的选择会显示成还在用那台挂掉的机器。
 *
 * 组可以套组，配置写错就可能成环，所以限制跳数——UI 刷新路径上不能有死循环。
 */
function resolveEffectiveProxyNode(proxies, entryName, maxHops = 8) {
  if (!proxies || typeof proxies !== 'object') return null;
  let name = entryName;
  for (let hop = 0; hop < maxHops; hop += 1) {
    const node = proxies[name];
    if (!node || typeof node !== 'object') return null;
    const next = typeof node.now === 'string' && node.now.trim() ? node.now.trim() : null;
    if (!next || next === name) return name;
    name = next;
  }
  return name;
}

module.exports = { decideClashLinkAction, isUsableLink, isActiveRemoteLink, resolveEffectiveProxyNode };
