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
  userCenterRoles: result.userCenter.roles.map((role) => role.roleId),
  serviceTokenId: result.issuedServiceToken.record.tokenId,
  sdkAccessAllowed: result.sdkAccess.allowed,
  deniedSdkAccessAllowed: result.deniedSdkAccess.allowed,
  configPolicySnapshotId: result.configPolicySnapshot.snapshotId,
  configPolicyDigest: result.configPolicySnapshot.signatures.digest.slice(0, 16),
  installId: result.enrollment.installId,
  principalKind: result.principalContext.principal.kind,
  sdkTokenActive: result.sdkIntrospection.active,
  sdkGatewayRoutes: result.sdkGateway.routes.map((route) => route.routeId),
  guestCidr: result.networkSnapshot.overlayPolicy.cidr,
  permissionDecision: result.permissionGrant.decision,
  gateVerdict: result.gate.verdict,
  releaseManagementPlanId: result.releaseManagementPlan.planId,
  releaseManagementReady: result.releaseManagementPlan.decisions.readyToPromote,
  releaseManagementGate: result.releaseManagementPlan.test.gate.verdict,
  domesticSlotPlanId: result.domesticSlotPlan.planId,
  domesticSlotNetworkMode: result.domesticSlotPlan.network.mode,
  domesticSlotQpTunnelCliMode: result.domesticSlotPlan.network.qpTunnelCliMode,
  domesticSlotPreflightExecutionStatus: result.domesticSlotPreflightExecution.status,
  domesticSlotApplyExecutionStatus: result.domesticSlotApplyExecution.status,
  domesticSlotPreflightRunnerStatus: result.domesticSlotPreflightRunnerSession.status,
  domesticSlotRemoteRunnerStatus: result.domesticSlotRemoteRunnerSession.status,
  domesticSlotWorkerJobStatus: result.domesticSlotWorkerJob.status,
  domesticSlotWorkerReportStatus: result.domesticSlotWorkerReport.status,
  domesticSlotFailedWorkerJobStatus: result.domesticSlotFailedWorkerJob.status,
  domesticSlotFailedRollbackPlanStatus: result.domesticSlotFailedWorkerReport.rollbackPlan?.status ?? null,
  domesticSlotRollbackExecutionStatus: result.domesticSlotRollbackExecution.status,
  domesticSlotRollbackReportStatus: result.domesticSlotRollbackReport.status,
  overseaSlotPlanId: result.overseaSlotPlan.planId,
  overseaSlotStacks: result.overseaSlotPlan.services.dockerStacks,
  launcherUpdateMode: result.launcherUpdate.updateMode,
  h2oCanSkip: result.h2oUpdate.canSkip,
  dnsPolicyId: result.dnsPolicy.policyId,
  dnsRoute: result.dnsDecision.route,
  dnsResolver: result.dnsDecision.resolver,
  dnsZoneSnapshotId: result.dnsZoneSnapshot.snapshotId,
  dnsZoneDigest: result.dnsZoneSnapshot.signatures.digest.slice(0, 16),
  dnsZones: result.dnsZoneSnapshot.zoneNames,
  coreDnsSyncId: result.coreDnsSync.syncId,
  coreDnsSyncMode: result.coreDnsSync.mode,
  coreDnsSyncApplied: result.coreDnsSync.applied,
  reverseProxyHost: result.dnsDecision.reverseProxyRoute?.host ?? null
}, null, 2));
