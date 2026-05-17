/**
 * NotYet floating-ball overlay manager (main process).
 *
 * Per host BrowserWindow we spawn a transparent, frameless, click-through
 * **child window** ("overlay") that renders the ball UI from a bundled
 * HTML/CSS/JS asset. The overlay's bounds track the parent's; mouse events
 * fall through by default (`setIgnoreMouseEvents(true, { forward: true })`)
 * and the renderer flips us to capturing mode via IPC when the mouse enters
 * the ball/petal hot zone — that's how "non-ball clicks reach the underlying
 * app" works.
 *
 * The "open chat" action shows a prewarmed child BrowserWindow and navigates
 * it to `https://www.notyet.chat`, sized to fully cover the parent. "Return"
 * just hides that window — the underlying app's state was never touched, so
 * it reappears exactly as the user left it.
 *
 * Visibility (show/hide ball) is persisted to `<userDataDir>/settings.json`
 * so the choice survives across restarts. The admin panel can flip it via
 * the exposed `setVisible(bool)` RPC.
 */
import path from 'node:path';
import { promises as fs } from 'node:fs';
import {
  BrowserWindow,
  screen,
  type App,
  type IpcMain,
  type Session,
  type WebContents
} from 'electron';

const SETTINGS_FILENAME = 'settings.json';

export interface CreateOverlayManagerOptions {
  app: App;
  ipcMain: IpcMain;
  /** Host session, already configured by tunnel/system proxy plugins. */
  session: Session;
  /** Where to navigate when the user taps "咨询". */
  chatUrl: string;
  /**
   * Absolute path to the bundled UI assets directory (containing
   * `ball.html`, `ball.css`, `ball.js`, `ball-preload.js`). Resolved by
   * `plugin.ts` against `__dirname`.
   */
  assetsDir: string;
  /** Plugin's persistent storage directory (provided by host as `ctx.userDataDir`). */
  userDataDir: string;
  log: {
    info(m: string, meta?: Record<string, unknown>): void;
    error(m: string, meta?: Record<string, unknown>): void;
  };
}

export interface OverlayManagerHandle {
  isVisible(): boolean;
  setVisible(v: boolean): Promise<void>;
  openChat(): Promise<void>;
  closeChat(): Promise<void>;
  close(): Promise<void>;
}

interface BallPosition {
  /** Normalised x position of the ball *center* (0..1 of window width). */
  fx: number;
  /** Normalised y position of the ball *center* (0..1 of window height). */
  fy: number;
}

interface PersistedSettings {
  visible: boolean;
  /**
   * Per-window ball positions. Key is a stable-ish identifier for the parent
   * window (its loaded URL by default — see `windowKeyFor`). Normalised so
   * resizes don't strand the ball off-screen.
   */
  positions: Record<string, BallPosition>;
}

/**
 * In-line error page rendered into the cover window when the chat URL fails
 * to load (proxy unreachable, offline, DNS, …). Kept simple and self-
 * contained — no external assets so it works exactly when networking is
 * the problem.
 */
function renderLoadErrorPage(url: string, errorCode: number, errorDescription: string): string {
  const esc = (s: string) => s.replace(/[&<>"]/g, (c) =>
    ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c] as string));
  const hint = errorDescription.includes('PROXY')
    ? '检测到代理无法连接。NotYet 会跟随当前应用的 tunnel/代理设置，请检查 tunnel 是否正在运行，或切换到可用的代理模式后重试。'
    : '网络连接失败。请检查互联网连接后再点击「重试」。';
  return `<!doctype html>
<html lang="zh-CN"><head><meta charset="utf-8"><title>NotYet - 无法连接</title>
<style>
  :root { color-scheme: dark; }
  html, body { margin: 0; height: 100%; background: #0c0e16; color: #e8eef7;
    font-family: -apple-system, BlinkMacSystemFont, "PingFang SC", "Source Han Serif SC", serif; }
  .wrap { display: flex; flex-direction: column; align-items: center; justify-content: center;
    height: 100%; padding: 40px; text-align: center; }
  .planet { width: 96px; height: 96px; border-radius: 50%;
    background: radial-gradient(circle at 32% 28%, #a8d4f0, #3a8bce 28%, #15407a 68%, #0a2540);
    box-shadow: 0 0 28px rgba(58,139,206,0.45), 0 12px 28px rgba(0,0,0,0.5);
    margin-bottom: 28px; opacity: 0.8; }
  h1 { font-size: 22px; font-weight: 600; margin: 0 0 12px; color: #f3d27a; }
  .url { font-family: ui-monospace, "SF Mono", monospace; font-size: 13px;
    color: #8fb3d9; margin-bottom: 18px; }
  .hint { max-width: 480px; line-height: 1.7; color: #c0ccdc;
    border-left: 2px solid #d4a548; padding: 8px 0 8px 16px; text-align: left; }
  .err { font-family: ui-monospace, "SF Mono", monospace; font-size: 12px;
    color: #6b7991; margin-top: 24px; }
  .btn { margin-top: 28px; display: inline-block; padding: 10px 22px; border: none;
    border-radius: 6px; background: #3a8bce; color: white; font-size: 14px; cursor: pointer;
    font-family: inherit; letter-spacing: 1px; }
  .btn:hover { background: #4aa2e8; }
</style></head>
<body><div class="wrap">
  <div class="planet"></div>
  <h1>无法连接到 NotYet</h1>
  <div class="url">${esc(url)}</div>
  <p class="hint">${esc(hint)}</p>
  <button class="btn" onclick="location.replace(${JSON.stringify(url)})">重试</button>
  <div class="err">${esc(errorDescription)} (${errorCode})</div>
</div></body></html>`;
}

function renderLoadingPage(url: string): string {
  const esc = (s: string) => s.replace(/[&<>"]/g, (c) =>
    ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c] as string));
  return `<!doctype html>
<html lang="zh-CN"><head><meta charset="utf-8"><title>NotYet - 正在连接</title>
<style>
  :root { color-scheme: dark; }
  html, body { margin: 0; height: 100%; background: #0c0e16; color: #e8eef7;
    font-family: -apple-system, BlinkMacSystemFont, "PingFang SC", "Source Han Serif SC", serif; }
  .wrap { display: flex; flex-direction: column; align-items: center; justify-content: center;
    height: 100%; padding: 40px; text-align: center; }
  .planet { width: 92px; height: 92px; border-radius: 50%;
    background: radial-gradient(circle at 32% 28%, #a8d4f0, #3a8bce 28%, #15407a 68%, #0a2540);
    box-shadow: 0 0 28px rgba(58,139,206,0.45), 0 12px 28px rgba(0,0,0,0.5);
    margin-bottom: 26px; animation: pulse 1.4s ease-in-out infinite; }
  h1 { font-size: 20px; font-weight: 600; margin: 0 0 12px; color: #f3d27a; }
  .url { font-family: ui-monospace, "SF Mono", monospace; font-size: 13px; color: #8fb3d9; }
  @keyframes pulse { 0%, 100% { transform: scale(1); opacity: 0.72; }
    50% { transform: scale(1.05); opacity: 1; } }
</style></head>
<body><div class="wrap">
  <div class="planet"></div>
  <h1>正在连接 NotYet</h1>
  <div class="url">${esc(url)}</div>
</div></body></html>`;
}

const DEFAULT_SETTINGS: PersistedSettings = { visible: true, positions: {} };

export function createOverlayManager(opts: CreateOverlayManagerOptions): OverlayManagerHandle {
  // parent BrowserWindow id → its associated overlay window
  const overlays = new Map<number, BrowserWindow>();
  // parent BrowserWindow id → hidden/prewarmed cover window for notyet.chat.
  interface CoverEntry {
    window: BrowserWindow;
    onParentGeometry: () => void;
    onParentClosed: () => void;
    warmPromise: Promise<void> | null;
    loadPromise: Promise<void> | null;
    loadedOk: boolean;
    loadFailed: boolean;
    open: boolean;
  }
  const covers = new Map<number, CoverEntry>();
  // Our own windows — `app.on('browser-window-created')` fires for them too,
  // so we tag at construction time and skip them in `attach()`.
  const ourWindows = new WeakSet<BrowserWindow>();
  // `new BrowserWindow(...)` synchronously fires `browser-window-created`
  // *during* the constructor — before we can add the reference to `ourWindows`.
  // That used to cause infinite recursion (overlay's constructor → event →
  // attach(overlay) → new overlay → …). Set this flag around any window we
  // create and the event handler short-circuits.
  let creatingOurWindow = 0;
  function withOurConstruction<T>(make: () => T): T {
    creatingOurWindow++;
    try {
      return make();
    } finally {
      creatingOurWindow--;
    }
  }

  let settings: PersistedSettings = { ...DEFAULT_SETTINGS };
  const settingsPath = path.join(opts.userDataDir, SETTINGS_FILENAME);
  let disposed = false;
  // Hold strong refs to per-parent listener fns so we can remove them on
  // close() without ripping unrelated listeners off the parent.
  const parentListeners = new Map<number, Array<{ event: string; fn: () => void }>>();
  // NotYet is an app-level assistant surface, not a BrowserWindow decorator.
  // Keep it on the primary host window; login popups, tunnel test windows,
  // and other transient windows should not receive their own ball.
  let primaryParentId: number | null = null;

  /**
   * Hot-zone state for cursor polling.
   *
   * The renderer reports the current orbit rect (in window-relative coords)
   * via `notyet:set-hot-rect`. The cursor-polling loop reads the OS cursor
   * via `screen.getCursorScreenPoint()` and flips `setIgnoreMouseEvents`
   * based on whether the cursor is inside that rect — independent of the
   * unreliable forwarded-mousemove path.
   *
   * `dragLocked` overrides polling: while a renderer reports an active drag
   * we keep capture mode on regardless of cursor position, so the cursor
   * can leave the orbit area mid-drag without dropping the gesture.
   */
  interface HotRect { x: number; y: number; w: number; h: number; }
  const hotRects = new Map<number, HotRect>();           // overlay id → rect
  const dragLocked = new Set<number>();                  // overlay ids
  // Track current capture state so we don't spam `setIgnoreMouseEvents` —
  // some platforms (gtk) re-render the window on every flip.
  const capturing = new Set<number>();
  const CURSOR_POLL_MS = 50;
  const HOT_PADDING_PX = 12;
  let cursorPollTimer: NodeJS.Timeout | null = null;

  function applyMouseCapture(overlay: BrowserWindow, shouldCapture: boolean): void {
    if (overlay.isDestroyed()) return;
    const id = overlay.id;
    if (capturing.has(id) === shouldCapture) return;     // no change
    if (shouldCapture) capturing.add(id); else capturing.delete(id);
    overlay.setIgnoreMouseEvents(!shouldCapture, { forward: true });
  }

  function pollCursor(): void {
    if (disposed || overlays.size === 0) return;
    let cursor: Electron.Point;
    try {
      cursor = screen.getCursorScreenPoint();
    } catch {
      return;  // screen not ready yet
    }
    for (const overlay of overlays.values()) {
      if (overlay.isDestroyed()) continue;
      const id = overlay.id;
      if (dragLocked.has(id)) {
        applyMouseCapture(overlay, true);
        continue;
      }
      const rect = hotRects.get(id);
      if (!rect) {
        applyMouseCapture(overlay, false);
        continue;
      }
      // Translate the cursor (screen coords) into the overlay's local coords.
      const ob = overlay.getBounds();
      const cx = cursor.x - ob.x;
      const cy = cursor.y - ob.y;
      const inside =
        cx >= rect.x - HOT_PADDING_PX &&
        cx <= rect.x + rect.w + HOT_PADDING_PX &&
        cy >= rect.y - HOT_PADDING_PX &&
        cy <= rect.y + rect.h + HOT_PADDING_PX;
      applyMouseCapture(overlay, inside);
    }
  }

  function startCursorPolling(): void {
    if (cursorPollTimer) return;
    cursorPollTimer = setInterval(pollCursor, CURSOR_POLL_MS);
    // Run immediately so we don't wait CURSOR_POLL_MS for the first poll.
    pollCursor();
  }
  function stopCursorPolling(): void {
    if (cursorPollTimer) clearInterval(cursorPollTimer);
    cursorPollTimer = null;
  }

  async function loadSettings(): Promise<void> {
    try {
      const raw = await fs.readFile(settingsPath, 'utf8');
      const parsed = JSON.parse(raw) as Partial<PersistedSettings>;
      settings = {
        visible: typeof parsed.visible === 'boolean' ? parsed.visible : DEFAULT_SETTINGS.visible,
        positions: parsed.positions && typeof parsed.positions === 'object'
          ? sanitisePositions(parsed.positions as Record<string, unknown>)
          : {}
      };
    } catch {
      settings = { visible: DEFAULT_SETTINGS.visible, positions: {} };
    }
  }

  /** Drop anything malformed in the loaded positions map. */
  function sanitisePositions(raw: Record<string, unknown>): Record<string, BallPosition> {
    const out: Record<string, BallPosition> = {};
    for (const [k, v] of Object.entries(raw)) {
      if (!v || typeof v !== 'object') continue;
      const r = v as Record<string, unknown>;
      if (typeof r.fx !== 'number' || typeof r.fy !== 'number') continue;
      if (!isFinite(r.fx) || !isFinite(r.fy)) continue;
      out[k] = {
        fx: Math.min(Math.max(r.fx, 0), 1),
        fy: Math.min(Math.max(r.fy, 0), 1)
      };
    }
    return out;
  }

  /**
   * Stable-ish key for a parent window. URL is the most reliable signal —
   * apps typically navigate the main window to a stable host URL on boot.
   * Empty / `about:blank` falls back to the window title; if both are
   * unavailable we use `default` (everyone shares one slot).
   */
  function windowKeyFor(parent: BrowserWindow): string {
    try {
      const url = parent.webContents.getURL();
      if (url && !url.startsWith('about:')) {
        const u = new URL(url);
        return `${u.host}${u.pathname}`.replace(/\/$/, '') || 'default';
      }
    } catch {
      /* ignore */
    }
    const title = parent.getTitle();
    return title ? `title:${title}` : 'default';
  }

  async function saveSettings(): Promise<void> {
    try {
      await fs.mkdir(opts.userDataDir, { recursive: true });
      await fs.writeFile(settingsPath, JSON.stringify(settings, null, 2), 'utf8');
    } catch (err) {
      opts.log.error('failed to persist notyet settings', {
        error: err instanceof Error ? err.message : String(err)
      });
    }
  }

  function isOurWindow(win: BrowserWindow): boolean {
    return ourWindows.has(win);
  }

  function canAttachToHostWindow(win: BrowserWindow): boolean {
    if (disposed) return false;
    if (creatingOurWindow > 0) return false;
    if (isOurWindow(win)) return false;
    if (win.isDestroyed()) return false;
    if (win.getParentWindow()) return false;
    if (primaryParentId !== null && primaryParentId !== win.id) return false;
    return true;
  }

  /**
   * Create-and-attach the overlay window for a host BrowserWindow.
   * Idempotent: skips if we already attached or if `win` is one of our own.
   */
  function attach(win: BrowserWindow): void {
    if (disposed) return;
    // CRITICAL: skip when we're mid-construction of one of our own windows.
    // The BrowserWindow constructor fires `browser-window-created` *during*
    // the constructor, before we get a chance to tag the new window in
    // `ourWindows`, so `isOurWindow(win)` is still false at this point.
    // Without this guard the attach recurses infinitely (RangeError).
    if (creatingOurWindow > 0) return;
    if (isOurWindow(win)) return;
    if (overlays.has(win.id)) return;
    if (!canAttachToHostWindow(win)) return;
    primaryParentId = win.id;

    const overlay = withOurConstruction(() => new BrowserWindow({
      parent: win,
      transparent: true,
      frame: false,
      hasShadow: false,
      resizable: false,
      movable: false,
      minimizable: false,
      maximizable: false,
      fullscreenable: false,
      skipTaskbar: true,
      alwaysOnTop: true,
      focusable: false,
      acceptFirstMouse: true,
      backgroundColor: '#00000000',
      // Start hidden so we can finish loading + bounds-sync before flashing.
      show: false,
      webPreferences: {
        preload: path.join(opts.assetsDir, 'ball-preload.js'),
        contextIsolation: true,
        sandbox: false,
        // Overlay doesn't need devtools / node — pure presentation surface.
        nodeIntegration: false,
        webSecurity: true
      }
    }));
    ourWindows.add(overlay);

    // Default mode: pointer events fall through to the underlying app.
    // The renderer flips this to `false` via IPC when the mouse enters the
    // hot zone (ball or expanded petal ring), then back to `true` on leave.
    overlay.setIgnoreMouseEvents(true, { forward: true });

    const ballHtml = path.join(opts.assetsDir, 'ball.html');
    overlay
      .loadFile(ballHtml)
      .then(() => {
        if (overlay.isDestroyed()) return;
        if (settings.visible) overlay.show();
      })
      .catch((err) => {
        opts.log.error('failed to load ball.html', {
          error: err instanceof Error ? err.message : String(err),
          ballHtml
        });
      });

    // Keep the overlay size glued to the parent's. Child BrowserWindows move
    // with their parent natively; resyncing on every move makes drag jittery.
    const syncBounds = (): void => {
      if (overlay.isDestroyed() || win.isDestroyed()) return;
      try {
        overlay.setBounds(win.getBounds());
      } catch {
        /* parent in transition; next event re-syncs */
      }
    };
    const onParentClose = (): void => {
      // Clean up cursor-polling state for this overlay's id before we
      // destroy it, so the next poll tick doesn't see a stale entry.
      hotRects.delete(overlay.id);
      dragLocked.delete(overlay.id);
      capturing.delete(overlay.id);
      if (!overlay.isDestroyed()) overlay.destroy();
      overlays.delete(win.id);
      if (primaryParentId === win.id) primaryParentId = null;
      parentListeners.delete(win.id);
    };

    const events: Array<{ event: string; fn: () => void }> = [
      { event: 'resize', fn: syncBounds },
      { event: 'restore', fn: syncBounds },
      { event: 'maximize', fn: syncBounds },
      { event: 'unmaximize', fn: syncBounds },
      { event: 'close', fn: onParentClose }
    ];
    for (const { event, fn } of events) win.on(event as 'move', fn);
    parentListeners.set(win.id, events);

    overlays.set(win.id, overlay);
    syncBounds();
    void ensureCoverForParent(win);
  }

  /** Resolve the host BrowserWindow whose overlay's webContents sent this IPC. */
  function parentForSender(sender: WebContents): BrowserWindow | null {
    const overlayWin = BrowserWindow.fromWebContents(sender);
    if (!overlayWin) return null;
    for (const [parentId, ovr] of overlays) {
      if (ovr === overlayWin) return BrowserWindow.fromId(parentId);
    }
    return null;
  }

  /* ─── Cover window (notyet.chat) ─────────────────────────────────────── */

  // Use the host session so NotYet follows the same app-level proxy/tunnel
  // policy as the rest of the Electron app. A dedicated direct session would
  // bypass `@qpjoy/electron-plugin-tunnel` and fail on networks that require it.
  async function getChatSession(): Promise<Session> {
    return opts.session;
  }

  const COVER_PARENT_EVENTS = ['resize', 'restore', 'maximize', 'unmaximize'] as const;

  function fitCoverToParent(parent: BrowserWindow, cover: BrowserWindow): void {
    if (parent.isDestroyed() || cover.isDestroyed()) return;
    try {
      cover.setBounds(parent.getContentBounds());
    } catch {
      /* parent in transition; next event re-syncs */
    }
  }

  function showLoadingPage(entry: CoverEntry): Promise<void> {
    if (entry.warmPromise) return entry.warmPromise;
    entry.loadedOk = false;
    entry.loadFailed = false;
    const html = renderLoadingPage(opts.chatUrl);
    entry.warmPromise = entry.window.webContents
      .loadURL('data:text/html;charset=utf-8,' + encodeURIComponent(html))
      .catch((err) => {
        opts.log.error('failed to load chat loading page', {
          error: err instanceof Error ? err.message : String(err)
        });
      })
      .finally(() => {
        entry.warmPromise = null;
      });
    return entry.warmPromise;
  }

  function loadCover(entry: CoverEntry, force = false): Promise<void> {
    if (entry.loadPromise && !entry.loadedOk && !entry.loadFailed) return entry.loadPromise;
    if (!force && entry.loadedOk && !entry.loadFailed) return Promise.resolve();
    entry.loadedOk = false;
    entry.loadFailed = false;
    entry.loadPromise = (async () => {
      if (entry.warmPromise) await entry.warmPromise;
      await entry.window.webContents.loadURL(opts.chatUrl);
    })()
      .then(() => {
        entry.loadedOk = true;
      })
      .catch((err) => {
        entry.loadFailed = true;
        const message = err instanceof Error ? err.message : String(err);
        if (message.includes('ERR_ABORTED')) return;
        opts.log.error('failed to load chat URL', {
          url: opts.chatUrl,
          error: message
        });
      })
      .finally(() => {
        entry.loadPromise = null;
      });
    return entry.loadPromise;
  }

  async function ensureCoverForParent(parent: BrowserWindow): Promise<CoverEntry | null> {
    if (parent.isDestroyed() || isOurWindow(parent)) return null;
    const existing = covers.get(parent.id);
    if (existing && !existing.window.isDestroyed()) return existing;

    const ses = await getChatSession();
    const cover = withOurConstruction(() => new BrowserWindow({
      parent,
      frame: false,
      show: false,
      resizable: false,
      movable: false,
      minimizable: false,
      maximizable: false,
      fullscreenable: false,
      skipTaskbar: true,
      backgroundColor: '#0c0e16',
      webPreferences: {
        contextIsolation: true,
        sandbox: true,
        nodeIntegration: false,
        session: ses
      }
    }));
    ourWindows.add(cover);

    const onParentGeometry = (): void => fitCoverToParent(parent, cover);
    const onParentClosed = (): void => {
      covers.delete(parent.id);
      if (!cover.isDestroyed()) cover.destroy();
    };
    const entry: CoverEntry = {
      window: cover,
      onParentGeometry,
      onParentClosed,
      warmPromise: null,
      loadPromise: null,
      loadedOk: false,
      loadFailed: false,
      open: false
    };
    covers.set(parent.id, entry);

    cover.webContents.on('did-fail-load', (_e, errorCode, errorDescription, validatedURL, isMainFrame) => {
      if (!isMainFrame) return;
      if (parent.isDestroyed() || cover.isDestroyed()) return;
      entry.loadFailed = true;
      entry.loadedOk = false;
      const html = renderLoadErrorPage(validatedURL || opts.chatUrl, errorCode, errorDescription);
      void cover.webContents.loadURL('data:text/html;charset=utf-8,' + encodeURIComponent(html));
      opts.log.error('chat cover failed to load', {
        url: validatedURL,
        errorCode,
        errorDescription
      });
    });

    cover.on('closed', () => {
      covers.delete(parent.id);
    });
    for (const event of COVER_PARENT_EVENTS) {
      parent.on(event as 'move', onParentGeometry);
    }
    parent.once('closed', onParentClosed);

    fitCoverToParent(parent, cover);
    void showLoadingPage(entry);
    return entry;
  }

  async function openChatForParent(parent: BrowserWindow): Promise<void> {
    if (parent.isDestroyed()) return;
    const entry = await ensureCoverForParent(parent);
    if (!entry || entry.window.isDestroyed()) return;

    entry.open = true;
    fitCoverToParent(parent, entry.window);
    await showLoadingPage(entry);
    void loadCover(entry, true);
    entry.window.show();
    entry.window.focus();

    const overlay = overlays.get(parent.id);
    if (overlay && !overlay.isDestroyed() && settings.visible) {
      overlay.showInactive();
      overlay.setAlwaysOnTop(true);
    }
  }

  function closeChatForParent(parent: BrowserWindow): void {
    const entry = covers.get(parent.id);
    if (!entry) return;
    entry.open = false;
    if (!entry.window.isDestroyed()) entry.window.hide();
  }

  function destroyCoverForParent(parentId: number): void {
    const entry = covers.get(parentId);
    if (!entry) return;
    covers.delete(parentId);
    const parent = BrowserWindow.fromId(parentId);
    if (parent && !parent.isDestroyed()) {
      for (const event of COVER_PARENT_EVENTS) {
        parent.off(event as 'move', entry.onParentGeometry);
      }
      parent.off('closed', entry.onParentClosed);
    }
    if (!entry.window.isDestroyed()) entry.window.destroy();
  }

  /* ─── IPC wiring ─────────────────────────────────────────────────────── */

  const IPC_OPEN = 'notyet:open-chat';
  const IPC_CLOSE = 'notyet:close-chat';
  const IPC_HIDE = 'notyet:hide-ball';
  const IPC_HOT_RECT = 'notyet:set-hot-rect';
  const IPC_DRAG = 'notyet:set-drag';
  const IPC_STATE = 'notyet:query-state';
  const IPC_LOAD_POS = 'notyet:load-position';
  const IPC_SAVE_POS = 'notyet:save-position';

  opts.ipcMain.handle(IPC_OPEN, async (ev) => {
    const parent = parentForSender(ev.sender);
    if (!parent) return { ok: false, reason: 'no parent for sender' };
    await openChatForParent(parent);
    return { ok: true };
  });

  opts.ipcMain.handle(IPC_CLOSE, async (ev) => {
    const parent = parentForSender(ev.sender);
    if (!parent) return { ok: false };
    closeChatForParent(parent);
    return { ok: true };
  });

  opts.ipcMain.handle(IPC_HIDE, async () => {
    settings.visible = false;
    await saveSettings();
    for (const ovr of overlays.values()) {
      if (!ovr.isDestroyed()) ovr.hide();
    }
    return { ok: true };
  });

  // Renderer reports its current orbit rect. The cursor-polling loop uses
  // this to decide capture vs passthrough — replacing the unreliable
  // `forward: true` mousemove path we used in phase 1/2.0.
  opts.ipcMain.on(IPC_HOT_RECT, (ev, rect: unknown) => {
    const overlay = BrowserWindow.fromWebContents(ev.sender);
    if (!overlay || overlay.isDestroyed()) return;
    if (!rect || typeof rect !== 'object') {
      hotRects.delete(overlay.id);
      return;
    }
    const r = rect as Record<string, unknown>;
    if (typeof r.x !== 'number' || typeof r.y !== 'number'
        || typeof r.w !== 'number' || typeof r.h !== 'number') {
      hotRects.delete(overlay.id);
      return;
    }
    hotRects.set(overlay.id, { x: r.x, y: r.y, w: r.w, h: r.h });
    // Re-poll immediately so the capture state reflects the new rect.
    pollCursor();
  });

  // Renderer signals drag start/end. While dragging we force capture on
  // so the cursor can stray outside the orbit rect without dropping the
  // pointer stream.
  opts.ipcMain.on(IPC_DRAG, (ev, dragging: boolean) => {
    const overlay = BrowserWindow.fromWebContents(ev.sender);
    if (!overlay || overlay.isDestroyed()) return;
    if (dragging) dragLocked.add(overlay.id);
    else dragLocked.delete(overlay.id);
    pollCursor();
  });

  // Renderer asks for state on init (e.g. is there a cover window open right
  // now? — affects whether "返回" petal is enabled).
  opts.ipcMain.handle(IPC_STATE, (ev) => {
    const parent = parentForSender(ev.sender);
    const coverOpen = parent ? covers.get(parent.id)?.open === true : false;
    return { visible: settings.visible, coverOpen };
  });

  // Per-window ball position: load on overlay init, save on drag end.
  opts.ipcMain.handle(IPC_LOAD_POS, (ev): BallPosition | null => {
    const parent = parentForSender(ev.sender);
    if (!parent) return null;
    return settings.positions[windowKeyFor(parent)] ?? null;
  });

  opts.ipcMain.handle(IPC_SAVE_POS, async (ev, pos: unknown) => {
    const parent = parentForSender(ev.sender);
    if (!parent) return { ok: false, reason: 'no parent' };
    const r = pos as Record<string, unknown> | null;
    if (!r || typeof r.fx !== 'number' || typeof r.fy !== 'number'
        || !isFinite(r.fx) || !isFinite(r.fy)) {
      return { ok: false, reason: 'invalid position payload' };
    }
    settings.positions[windowKeyFor(parent)] = {
      fx: Math.min(Math.max(r.fx, 0), 1),
      fy: Math.min(Math.max(r.fy, 0), 1)
    };
    await saveSettings();
    return { ok: true };
  });

  // Broadcast "cover state changed" to each overlay so its "返回" button can
  // toggle enabled/disabled in real time.
  function notifyCoverState(parent: BrowserWindow, coverOpen: boolean): void {
    const overlay = overlays.get(parent.id);
    if (!overlay || overlay.isDestroyed()) return;
    overlay.webContents.send('notyet:cover-state', { coverOpen });
  }

  // Wire cover-state notifications into open/close — recreate the inner
  // helpers to add the broadcast without restructuring the IPC handlers.
  const openChatOrig = openChatForParent;
  const closeChatOrig = closeChatForParent;
  // (Re-define using shadowed names so handlers above still call into us
  //  via the closure — TS-friendly: we just wrap with side effect.)
  async function openChatForParentWithNotify(parent: BrowserWindow): Promise<void> {
    await openChatOrig(parent);
    notifyCoverState(parent, true);
  }
  function closeChatForParentWithNotify(parent: BrowserWindow): void {
    closeChatOrig(parent);
    notifyCoverState(parent, false);
  }

  // Rebind the IPC handlers to the notifying variants.
  opts.ipcMain.removeHandler(IPC_OPEN);
  opts.ipcMain.removeHandler(IPC_CLOSE);
  opts.ipcMain.handle(IPC_OPEN, async (ev) => {
    const parent = parentForSender(ev.sender);
    if (!parent) return { ok: false, reason: 'no parent for sender' };
    await openChatForParentWithNotify(parent);
    return { ok: true };
  });
  opts.ipcMain.handle(IPC_CLOSE, async (ev) => {
    const parent = parentForSender(ev.sender);
    if (!parent) return { ok: false };
    closeChatForParentWithNotify(parent);
    return { ok: true };
  });

  /* ─── Boot ───────────────────────────────────────────────────────────── */

  void loadSettings().then(() => {
    opts.app.on('browser-window-created', (_event, win) => attach(win));
    const focused = BrowserWindow.getFocusedWindow();
    const windows = BrowserWindow.getAllWindows();
    if (focused) attach(focused);
    for (const w of windows) attach(w);
    startCursorPolling();
  });

  /* ─── Public handle ──────────────────────────────────────────────────── */

  return {
    isVisible: () => settings.visible,

    async setVisible(v: boolean) {
      if (settings.visible === v) return;
      settings.visible = v;
      await saveSettings();
      for (const ovr of overlays.values()) {
        if (ovr.isDestroyed()) continue;
        if (v) ovr.show();
        else ovr.hide();
      }
    },

    async openChat() {
      const focused = BrowserWindow.getFocusedWindow();
      if (focused && !isOurWindow(focused)) await openChatForParentWithNotify(focused);
    },

    async closeChat() {
      const focused = BrowserWindow.getFocusedWindow();
      if (focused) closeChatForParentWithNotify(focused);
    },

    async close() {
      disposed = true;
      stopCursorPolling();
      opts.ipcMain.removeHandler(IPC_OPEN);
      opts.ipcMain.removeHandler(IPC_CLOSE);
      opts.ipcMain.removeHandler(IPC_HIDE);
      opts.ipcMain.removeHandler(IPC_STATE);
      opts.ipcMain.removeHandler(IPC_LOAD_POS);
      opts.ipcMain.removeHandler(IPC_SAVE_POS);
      opts.ipcMain.removeAllListeners(IPC_HOT_RECT);
      opts.ipcMain.removeAllListeners(IPC_DRAG);

      // Detach parent listeners we registered. Other code on those parents
      // is untouched.
      for (const [parentId, listeners] of parentListeners) {
        const parent = BrowserWindow.fromId(parentId);
        if (!parent || parent.isDestroyed()) continue;
        for (const { event, fn } of listeners) {
          parent.off(event as 'move', fn);
        }
      }
      parentListeners.clear();

      for (const ovr of overlays.values()) {
        if (!ovr.isDestroyed()) ovr.destroy();
      }
      overlays.clear();
      // Tear down hidden/prewarmed chat covers.
      for (const parentId of Array.from(covers.keys())) {
        destroyCoverForParent(parentId);
      }
      covers.clear();
    }
  };
}
