import { loadConfig } from '../src/config.js';
import { MemoryStore } from '../src/store/memory.js';

const store = new MemoryStore(loadConfig());
const result = store.runPlatformKernelSmoke();

for (const check of result.checks) {
  console.log(check);
}

console.log(JSON.stringify({
  ok: result.ok,
  appId: result.app.appId,
  installId: result.enrollment.installId,
  principalKind: result.principalContext.principal.kind,
  sdkTokenActive: result.sdkIntrospection.active,
  sdkGatewayRoutes: result.sdkGateway.routes.map((route) => route.routeId),
  guestCidr: result.networkSnapshot.overlayPolicy.cidr,
  permissionDecision: result.permissionGrant.decision,
  gateVerdict: result.gate.verdict,
  launcherUpdateMode: result.launcherUpdate.updateMode,
  h2oCanSkip: result.h2oUpdate.canSkip,
  dnsPolicyId: result.dnsPolicy.policyId,
  dnsRoute: result.dnsDecision.route,
  dnsResolver: result.dnsDecision.resolver,
  reverseProxyHost: result.dnsDecision.reverseProxyRoute?.host ?? null
}, null, 2));
