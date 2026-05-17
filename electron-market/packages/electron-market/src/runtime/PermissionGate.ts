import type { Permission } from '@qpjoy/electron-plugin-sdk';
import { PermissionDeniedError } from '@qpjoy/electron-plugin-sdk';

/**
 * Static check: are the requested permissions a subset of the granted ones?
 * Supports literal equality plus a few wildcard shapes:
 *   - `net:listen:23456` is satisfied by `net:listen:23456`
 *     OR by a granted range `net:listen:23000-24000`
 *   - `net:fetch:plugins.qpjoy.dev` is satisfied by `net:fetch:plugins.qpjoy.dev`
 *     OR by `net:fetch:*` (explicit wildcard grant; not auto-issued)
 */
export class PermissionGate {
  constructor(private readonly granted: ReadonlySet<Permission>) {}

  has(permission: Permission): boolean {
    if (this.granted.has(permission)) return true;
    if (permission.startsWith('net:listen:')) {
      const port = Number(permission.slice('net:listen:'.length));
      for (const g of this.granted) {
        if (!g.startsWith('net:listen:')) continue;
        const rest = g.slice('net:listen:'.length);
        const [lo, hi] = rest.split('-').map(Number);
        if (hi !== undefined && port >= lo && port <= hi) return true;
      }
    }
    if (permission.startsWith('net:fetch:') && this.granted.has('net:fetch:*' as Permission)) {
      return true;
    }
    if (permission.startsWith('system:exec:') && this.granted.has('system:exec:*' as Permission)) {
      return true;
    }
    return false;
  }

  require(permission: Permission): void {
    if (!this.has(permission)) {
      throw new PermissionDeniedError(permission);
    }
  }

  /** Diff against a manifest's declared permission list. */
  static missing(declared: Permission[], granted: Permission[]): Permission[] {
    const g = new PermissionGate(new Set(granted));
    return declared.filter((p) => !g.has(p));
  }
}
