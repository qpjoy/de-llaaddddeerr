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
  guestCidr: result.networkSnapshot.overlayPolicy.cidr,
  permissionDecision: result.permissionGrant.decision,
  gateVerdict: result.gate.verdict,
  launcherUpdateMode: result.launcherUpdate.updateMode,
  h2oCanSkip: result.h2oUpdate.canSkip
}, null, 2));
