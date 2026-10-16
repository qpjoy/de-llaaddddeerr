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

/**
 * The plan: each registration with its state — `ok` (already as needed),
 * `create` / `update` (the command can do it, with Launcher's ops token), or
 * `manual` (only Launcher Admin can, and the plan says exactly what to enter).
 */
export function launcherPlan({ products = [], app = null, routes = [], rigUrl = null }) {
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
  const appState = !app ? 'create' : app.launcherMode === 'standalone' && app.productNetworkId === PRODUCT_ID ? 'ok' : 'update'
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
        id: 'release-center',
        state: 'later',
        title: `Release Center components ${MANIFEST.releaseComponents.join(' / ')}`,
        detail: 'needed for automatic updates (docs/25 P2); not for connecting'
      }
    ]
  }
}
