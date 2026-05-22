type WireGuardCore = typeof import('@qpjoy/electron-core-wireguard');

function loadWireGuardCore(): WireGuardCore {
  try {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    return require('@qpjoy/electron-core-wireguard') as WireGuardCore;
  } catch (primaryErr) {
    try {
      // Compatibility for older marketplace installers that unpack HDO's
      // tarball without installing its npm dependency tree.
      // eslint-disable-next-line @typescript-eslint/no-require-imports
      return require('./vendor/electron-core-wireguard') as WireGuardCore;
    } catch {
      throw primaryErr;
    }
  }
}

const core = loadWireGuardCore();

export const buildHdoRouteProbe: WireGuardCore['buildHdoRouteProbe'] = core.buildHdoRouteProbe;
export const excludeLocalRoutesFromAllowedIps: WireGuardCore['excludeLocalRoutesFromAllowedIps'] =
  core.excludeLocalRoutesFromAllowedIps;
export const generateWireGuardKeyPairWithCli: WireGuardCore['generateWireGuardKeyPairWithCli'] =
  core.generateWireGuardKeyPairWithCli;
export const getDarwinWireGuardLaunchDaemonStatus: WireGuardCore['getDarwinWireGuardLaunchDaemonStatus'] =
  core.getDarwinWireGuardLaunchDaemonStatus;
export const getWireGuardTunnelStatus: WireGuardCore['getWireGuardTunnelStatus'] = core.getWireGuardTunnelStatus;
export const HDO_MESH_DEFAULTS: WireGuardCore['HDO_MESH_DEFAULTS'] = core.HDO_MESH_DEFAULTS;
export const HDO_MESH_ROUTE_CIDRS: WireGuardCore['HDO_MESH_ROUTE_CIDRS'] = core.HDO_MESH_ROUTE_CIDRS;
export const installDarwinWireGuardLaunchDaemon: WireGuardCore['installDarwinWireGuardLaunchDaemon'] =
  core.installDarwinWireGuardLaunchDaemon;
export const localCidrsForAllowedIpExclusion: WireGuardCore['localCidrsForAllowedIpExclusion'] =
  core.localCidrsForAllowedIpExclusion;
export const normalizeCidr: WireGuardCore['normalizeCidr'] = core.normalizeCidr;
export const repairWireGuardTunnelRoutes: WireGuardCore['repairWireGuardTunnelRoutes'] =
  core.repairWireGuardTunnelRoutes;
export const renderHdoClientWireGuardConfig: WireGuardCore['renderHdoClientWireGuardConfig'] =
  core.renderHdoClientWireGuardConfig;
export const resolveWireGuardConnectionRuntime: WireGuardCore['resolveWireGuardConnectionRuntime'] =
  core.resolveWireGuardConnectionRuntime;
export const resolveWireGuardRuntime: WireGuardCore['resolveWireGuardRuntime'] = core.resolveWireGuardRuntime;
export const setWireGuardTunnelState: WireGuardCore['setWireGuardTunnelState'] = core.setWireGuardTunnelState;
export const shellQuote: WireGuardCore['shellQuote'] = core.shellQuote;
export const uninstallDarwinWireGuardLaunchDaemon: WireGuardCore['uninstallDarwinWireGuardLaunchDaemon'] =
  core.uninstallDarwinWireGuardLaunchDaemon;
