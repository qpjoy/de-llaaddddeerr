/**
 * `qp-tunnel-cli open` - OpenVPN reverse access.
 *
 * Two roles share one verb because they are two ends of the same link:
 *
 *   server  an Oversea host that accepts spokes and can reach back into them
 *   client  a spoke, typically a restricted internal server, that dials out and
 *           receives one stable address without letting anything else about its
 *           networking change
 *
 * This module only resolves the role, validates the shape of the invocation and
 * re-runs itself through sudo. Every privileged action lives in the bundled
 * shell scripts so the exact same code path runs whether it was reached through
 * npm, through a site-slot artifact, or by hand on a host with no Node.
 */
export interface OpenCliContext {
    isRoot: () => boolean;
    sudoSelf: (cliArgs: string[]) => never;
}
export declare function runOpenCli(args: string[], ctx: OpenCliContext): Promise<void>;
