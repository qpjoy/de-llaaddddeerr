/**
 * @qpjoy/electron-plugin-sdk
 *
 * Public surface for plugin authors. Importing anything else from
 * `@qpjoy/electron-market` directly is **not** part of the contract and may
 * break across host versions.
 */

export const PLUGIN_SPEC_VERSION = 1 as const;

/* ────────────────────────────────────────────────────────────────────────── */
/* Permission catalogue                                                       */
/* ────────────────────────────────────────────────────────────────────────── */

/**
 * Static permission strings. Anything that needs a parameter uses the
 * `category:scope[:detail]` form so it can be parsed without changing the
 * type for every new resource.
 */
export type Permission =
  | 'fs:userData'
  | 'fs:any'
  | `net:listen:${number}`
  | `net:listen:${number}-${number}`
  | `net:fetch:${string}`
  | 'system:proxy'
  | `system:exec:${string}`
  | `ipc:${string}`
  | 'ipc:cross'
  | 'ui:adminPanel';

export type ActivationEvent =
  | 'onStartup'
  | `onCommand:${string}`
  | `onSetting:${string}`;

/* ────────────────────────────────────────────────────────────────────────── */
/* Manifest                                                                   */
/* ────────────────────────────────────────────────────────────────────────── */

export interface PluginManifest {
  /** Stable id, reverse-DNS style. NOT the npm name. */
  id: string;
  name: string;
  version: string;
  author?: string;
  description?: string;
  homepage?: string;
  engines: {
    /** semver range against @qpjoy/electron-market (the host runtime). */
    electronMarket?: string;
    /**
     * Legacy alias for `electronMarket`. Accepted by hosts >= 0.2.0 so
     * plugins published against the pre-rename spec still load.
     * New plugins should use `electronMarket`.
     * @deprecated Use `electronMarket`.
     */
    electronPlugin?: string;
    /** semver range against electron itself */
    electron?: string;
  };
  permissions: Permission[];
  activationEvents: ActivationEvent[];
  contributes?: {
    adminPanel?: { url: string; label?: string };
    settings?: { schema: string };
    commands?: Array<{ id: string; title: string }>;
  };
}

/* ────────────────────────────────────────────────────────────────────────── */
/* Plugin context (what `activate()` receives)                                */
/* ────────────────────────────────────────────────────────────────────────── */

export interface PluginHostBridge {
  /** A reduced electron triple. The full one is gated behind permissions. */
  app: import('electron').App;
  ipcMain: import('electron').IpcMain;
  session: import('electron').Session;
  /** Ask the host to re-apply session proxy. Requires `system:proxy`. */
  applyProxy(): Promise<void>;
}

export interface PluginContext<S = unknown> {
  readonly manifest: PluginManifest;
  readonly host: PluginHostBridge;

  /** Sandbox dir, always inside `userData/plugins/<id>/`. */
  readonly userDataDir: string;

  /** Persistent settings store. Schema is whatever the plugin wants. */
  readonly settings: {
    get(): S;
    set(next: Partial<S>): void;
    onChange(listener: (next: S) => void): () => void;
  };

  /** Convenience wrapper around `settings.onChange`. */
  onConfigChange(listener: (next: S) => void): () => void;

  /**
   * Cross-plugin RPC. Requires `ipc:cross` on both sides.
   *
   * The function parameter type uses `any[]` rather than `unknown[]` so that
   * authors can pass concretely-typed methods (e.g. `(id: number) => Promise<void>`)
   * without casts. The runtime never inspects the signature; only the method
   * names are dispatched.
   */
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  expose(api: Record<string, (...args: any[]) => any>): void;
  call<T = unknown>(pluginId: string, method: string, ...args: unknown[]): Promise<T>;

  /** Permission-gated helpers — throw `PermissionDeniedError` if not granted. */
  spawn(bin: string, args: string[], opts?: { cwd?: string }): import('child_process').ChildProcess;
  fetch(url: string, init?: RequestInit): Promise<Response>;

  /** Structured logger that surfaces in the 23455 admin panel. */
  readonly log: {
    info(msg: string, meta?: Record<string, unknown>): void;
    warn(msg: string, meta?: Record<string, unknown>): void;
    error(msg: string, meta?: Record<string, unknown>): void;
  };
}

export class PermissionDeniedError extends Error {
  constructor(public readonly permission: Permission) {
    super(`Permission denied: ${permission}`);
    this.name = 'PermissionDeniedError';
  }
}

/* ────────────────────────────────────────────────────────────────────────── */
/* The author surface: definePlugin                                           */
/* ────────────────────────────────────────────────────────────────────────── */

/** A plugin returns a disposer; the host calls it on deactivate / uninstall. */
export type PluginDispose = () => void | Promise<void>;

export interface PluginModule<S = unknown> {
  activate(ctx: PluginContext<S>): Promise<PluginDispose | void> | PluginDispose | void;
  /** Optional; defaults to invoking the disposer returned by `activate`. */
  deactivate?(ctx: PluginContext<S>): Promise<void> | void;
}

/** Identity function. Exists for typing and future codegen / static analysis. */
export function definePlugin<S = unknown>(mod: PluginModule<S>): PluginModule<S> {
  return mod;
}
