// What Rig needs registered in Launcher (docs/25 §3.4), worked out from what
// Launcher already has. Pure: products, apps and routes in, a plan out; the
// command around it (launcher-register.mjs) does the reading and writing.

import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

export const MANIFEST = JSON.parse(readFileSync(fileURLToPath(new URL('../deploy/launcher/mx-rig.json', import.meta.url)), 'utf8'))
const PRODUCT_ID = MANIFEST.productNetwork.productId

// Launcher derives a standalone product's network from its index: lease range
// 10.(90+i).0.0/16 and service VIP 10.88.100.(2+i) (index 1 is Luopan's).
export const standaloneShape = (index) => ({
  productIndex: index,
  serviceVip: `10.88.100.${2 + (index % 198)}`,
  leaseCidr: `10.${90 + index}.0.0/16`
})

const secondOctet = (cidr) => {
  const match = /^10\.(\d{1,3})\./.exec(String(cidr ?? ''))
  return match ? Number(match[1]) : null
}

/** The first standalone index whose range and VIP nothing else uses. */
export function freeStandaloneIndex(products) {
  const octets = new Set()
  const vips = new Set()
  for (const product of products) {
    for (const cidr of [product.userCidr, product.anonymousCidr, product.feishuCidr]) {
      const octet = secondOctet(cidr)
      if (octet !== null) octets.add(octet)
    }
    if (product.serviceVip) vips.add(product.serviceVip)
  }
  for (let index = 1; index <= 164; index += 1) {
    const shape = standaloneShape(index)
    if (!octets.has(90 + index) && !vips.has(shape.serviceVip)) return index
  }
  throw new Error('no free standalone product index is left in Launcher')
}

const RELEASE = MANIFEST.release
const SSO = MANIFEST.sso

/** The AppCenter entry as Release Center needs it: standalone, Rig's network, Rig's package, the channel. */
function appMatches(app) {
  const wanted = MANIFEST.appCenterApp
  return (
    app.launcherMode === 'standalone' &&
    app.productNetworkId === PRODUCT_ID &&
    String(app.packageName ?? '').toLowerCase() === wanted.packageName.toLowerCase() &&
    (!Array.isArray(app.channels) || app.channels.includes(RELEASE.channel))
  )
}

/**
 * The plan: each registration with its state — `ok` (already as needed),
 * `create` / `update` (the command can do it, with Launcher's ops token), or
 * `manual` (only Launcher Admin can, and the plan says exactly what to enter).
 *
 * `resolved` is Release Center's answer for Rig's package name (null when it
 * has none); `credentials` says which release credentials this cluster
 * already keeps ({ publisher, approver }, or null when not known);
 * `ssoProfile` is where the browser SSO profile was found (a host file or
 * the cluster's Secret), or null.
 */
export function launcherPlan({ products = [], app = null, routes = [], rigUrl = null, resolved = null, credentials = null, ssoProfile = null }) {
  const existing = products.find((product) => product.productId === PRODUCT_ID) ?? null
  const wanted = MANIFEST.productNetwork
  const shape = existing
    ? { productIndex: existing.productIndex ?? null, serviceVip: existing.serviceVip, leaseCidr: existing.anonymousCidr ?? existing.userCidr }
    : standaloneShape(freeStandaloneIndex(products))
  const productState = !existing
    ? 'create'
    : existing.mode === wanted.mode && existing.networkScope === wanted.networkScope && existing.enabled !== false
      ? 'ok'
      : 'update'
  const appState = !app ? 'create' : appMatches(app) ? 'ok' : 'update'
  const identityState =
    resolved?.productId === PRODUCT_ID && String(resolved.packageName ?? '').toLowerCase() === RELEASE.packageName.toLowerCase()
      ? 'ok'
      : appState === 'ok'
        ? 'manual'
        : 'create'
  const credentialState = credentials?.publisher && credentials?.approver ? 'ok' : 'create'
  const route = routes.find((entry) => entry.host === shape.serviceVip && entry.enabled !== false) ?? null
  const origin = (url) => {
    try {
      return new URL(url).origin
    } catch {
      return null
    }
  }
  const routeState = route && rigUrl && origin(route.targetUrl) === origin(rigUrl) ? 'ok' : 'manual'
  return {
    productId: PRODUCT_ID,
    network: shape,
    steps: [
      {
        id: 'product-network',
        state: productState,
        title: `ProductNetwork ${PRODUCT_ID} (standalone, owner)`,
        detail: `service VIP ${shape.serviceVip}, lease range ${shape.leaseCidr}${shape.productIndex != null ? `, product index ${shape.productIndex}` : ''}`,
        body: { ...wanted, ...(existing ? {} : { productIndex: shape.productIndex }) }
      },
      {
        id: 'service-vip',
        state: existing && productState === 'ok' ? 'manual-check' : 'manual',
        title: 'Reconcile the product VIP on the Domestic relay',
        detail: `Launcher Admin → product networks / service VIP smokes → reconcile ${PRODUCT_ID}, so ${shape.leaseCidr} is relayed and ${shape.serviceVip} answers`
      },
      {
        id: 'gateway-route',
        state: routeState,
        title: 'Reverse-proxy route from the VIP to the Rig service',
        detail: rigUrl
          ? `Launcher Admin → DNS / reverse proxy: host ${shape.serviceVip} → ${rigUrl}, then publish the gateway routes`
          : `Launcher Admin → DNS / reverse proxy: host ${shape.serviceVip} → the Rig service URL that scripts/manage.sh deploy prints`
      },
      {
        id: 'app-center',
        state: appState,
        title: `AppCenter catalog entry ${PRODUCT_ID} (standalone, listed like Luopan)`,
        detail: 'MX-H2I users see MX Rig in AppCenter; it still runs on its own',
        body: MANIFEST.appCenterApp
      },
      {
        id: 'release-identity',
        state: identityState,
        title: `Release Center identity ${RELEASE.packageName} → ${PRODUCT_ID} (${RELEASE.channel})`,
        detail:
          identityState === 'manual'
            ? `the AppCenter entry is there but Release Center does not resolve ${RELEASE.packageName} to ${PRODUCT_ID}: look for another app registering the same package name`
            : 'comes with the AppCenter entry; the desktop finds its updates by this package name (docs/25 P2)'
      },
      {
        id: 'release-credentials',
        state: credentialState,
        title: `Release credentials ${RELEASE.publisher} / ${RELEASE.approver}`,
        detail:
          credentialState === 'ok'
            ? 'kept in this cluster (Secret mx-rig/mx-rig-release) for scripts/manage.sh release'
            : `issued by Launcher once and kept in Secret mx-rig/mx-rig-release — never printed; one already issued but not kept here is rotated`
      },
      {
        id: 'sso-application',
        state: ssoProfile ? 'ok' : 'manual',
        title: `Unified authentication client ${SSO.appId} (browser SSO, docs/25 P4)`,
        detail: ssoProfile
          ? `profile found (${ssoProfile}); scripts/manage.sh deploy keeps it in Secret mx-rig/mx-rig-sso`
          : `Launcher Internal → 平台设置 → 统一认证 → 接入应用: ${SSO.entrance}, ${SSO.displayName}, ${SSO.appId}, ${SSO.origin}, Audience ${SSO.audience} → 校验配置 → 保存应用 → 前往 Launcher 发布, until 「Auth 已加载」; then scripts/manage.sh deploy`
      },
      {
        id: 'sso-entrance',
        state: 'manual',
        title: `Public entrance ${SSO.origin}`,
        detail: `DNS and a certificate for ${new URL(SSO.origin).host} on the Domestic gateway → WireGuard 10.88.88.88:80 → Internal Nginx → ${rigUrl ?? 'the Rig service'}, forwarding only the paths in deploy/gateway/README.md (docs/25 §11)`
      }
    ]
  }
}
