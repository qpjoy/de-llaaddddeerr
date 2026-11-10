export interface CatalogApp {
  id: string;
  name: string;
  description: string;
  category: string;
  url?: string;
  icon?: import('./Icon').IconName;
  color?: string;
  installed: boolean;
  running: boolean;
  error?: string | null;
  action: { action: string; label: string; disabled: boolean };
}

export interface UpdateState {
  currentVersion?: string;
  latestVersion?: string;
  status?: string;
  updateAvailable?: boolean;
  summary: string;
  actionLabel: string;
  canApply: boolean;
  artifactKind?: string;
  componentKind?: string;
  activation?: string;
  restartRequired?: boolean;
  restartPrompt?: boolean;
  stagedPath?: string;
  reason?: string;
  installerOpenError?: string;
  deliveryMode?: string;
  notesHtml: string;
  historyHtml: string;
  downloadProgress?: {
    percent?: number | null;
    bytes?: number;
    totalBytes?: number;
    state?: string;
  };
}

export interface MinCaveAccess {
  status: 'checking' | 'allowed' | 'denied' | 'unavailable';
  allowed: boolean;
  canManage: boolean;
  role: 'admin' | 'employee' | null;
  code?: string;
  message?: string;
}
export interface Snapshot {
  access: MinCaveAccess;
  error?: string;
  runtime: {
    identity?: { kind?: string; displayName?: string; account?: string; provider?: string };
    installation?: { deviceLabel?: string; deviceId?: string; installId?: string; siteId?: string };
    connection?: { state?: string; mode?: string; localIp?: string; connectedAt?: string };
    apps?: { appcenter?: { installed?: boolean } };
  };
  busyAction: string;
  screen: string;
  h2oOpen: boolean;
  showLogin: boolean;
  connected: boolean;
  pending: boolean;
  paused: boolean;
  mutating: boolean;
  retainedEmployee: boolean;
  guestActive: boolean;
  anonymousBlocked: boolean;
  guestCanRenew: boolean;
  caption: string;
  apps: CatalogApp[];
  loginHtml: string;
  loginError: string;
  networkControl: { id: string; cancelable: boolean; stopping: boolean } | null;
  feedbackHtml: string;
  advancedHtml: string;
  overseasSubscription: { url: string; status: string; loading: boolean; canRefresh: boolean };
  releasePrompt: boolean;
  update: UpdateState;
}

declare global {
  interface Window {
    MxH2iView: {
      getSnapshot(): Snapshot | null;
      subscribe(listener: () => void): () => void;
      navigate(target: string): void;
      dismissRelease(): void;
      admin(input: import('./admin').AdminRequest): Promise<import('./admin').AdminResult>;
    };
  }
}

export const view = window.MxH2iView;
