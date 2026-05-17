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
 * The "open chat" action spawns a separate child BrowserWindow loading
 * `https://www.notyet.chat`, sized to fully cover the parent. "Return" just
 * closes that window — the underlying app's state was never touched, so it
 * reappears exactly as the user left it.
 *
 * Visibility (show/hide ball) is persisted to `<userDataDir>/settings.json`
 * so the choice survives across restarts. The admin panel can flip it via
 * the exposed `setVisible(bool)` RPC.
 */
import path from 'node:path';
import { promises as fs } from 'node:fs';
import {
  BrowserWindow,
  WebContentsView,
  screen,
  session as electronSession,
  type App,
  type IpcMain,
  type Session,
  type WebContents
} from 'electron';

const SETTINGS_FILENAME = 'settings.json';

export interface CreateOverlayManagerOptions {
  app: App;
  ipcMain: IpcMain;
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
    ? '检测到 host 设置了代理但代理无法连接。NotYet 咨询窗口已配置为直连，但底层 OS 代理仍可能影响。请检查系统代理或停用 tunnel 插件后重试。'
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

const DEFAULT_SETTINGS: PersistedSettings = { visible: true, positions: {} };

export function createOverlayManager(opts: CreateOverlayManagerOptions): OverlayManagerHandle {
  // parent BrowserWindow id → its associated overlay window
  const overlays = new Map<number, BrowserWindow>();
  // parent BrowserWindow id → cover window currently showing notyet.chat
  /**
   * Active "cover" views per parent. We use `WebContentsView` rather than a
   * separate BrowserWindow so the chat is **embedded inside the parent's
   * content area** — the parent's main webContents is never navigated, so
   * "return" simply removes the view and the underlying page reappears in
   * its exact prior state (scroll, form values, in-progress xhrs all intact).
   *
   * Bookkeeping stored alongside so close() can clean up the resize/move
   * listeners we registered on the parent specifically for this cover.
   */
  interface CoverEntry {
    view: WebContentsView;
    onParentResize: () => void;
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
    if (win.isDestroyed()) return;

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

    // Keep the overlay bounds glued to the parent's. Cheap to call.
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
      parentListeners.delete(win.id);
    };

    const events: Array<{ event: string; fn: () => void }> = [
      { event: 'move', fn: syncBounds },
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

  // Dedicated session for the chat cover. Two reasons it can't share the
  // host's default session:
  //   1. The host might have a system proxy / tunnel set (e.g. via
  //      `@qpjoy/electron-plugin-tunnel`). If notyet.chat isn't in that proxy's
  //      route, the cover fails with `ERR_PROXY_CONNECTION_FAILED`.
  //   2. We want notyet.chat's cookies / localStorage isolated from anything
  //      else the host loads — both for cleanliness and to keep the chat
  //      login state stable across host upgrades.
  //
  // `persist:` prefix on the partition makes cookies survive restarts.
  // `setProxy({ mode: 'direct' })` forces direct routing irrespective of
  // what the OS / other plugins configured.
  let chatSession: Session | null = null;
  async function getChatSession(): Promise<Session> {
    if (chatSession) return chatSession;
    chatSession = electronSession.fromPartition('persist:qpjoy-notyet-chat');
    try {
      await chatSession.setProxy({ mode: 'direct' });
    } catch (err) {
      opts.log.error('failed to set direct proxy on chat session', {
        error: err instanceof Error ? err.message : String(err)
      });
    }
    return chatSession;
  }

  async function openChatForParent(parent: BrowserWindow): Promise<void> {
    if (parent.isDestroyed()) return;
    if (covers.has(parent.id)) {
      // Already open — just bring focus to it.
      const entry = covers.get(parent.id)!;
      entry.view.webContents.focus();
      return;
    }

    // Resolve the dedicated chat session first (sets `direct` proxy).
    const ses = await getChatSession();

    // The chat lives in a child WebContentsView attached to the parent
    // window's contentView. The parent's main webContents is NEVER
    // navigated, so closing the chat (= removing this view) brings the
    // original page back exactly as the user left it.
    const view = new WebContentsView({
      webPreferences: {
        contextIsolation: true,
        sandbox: true,
        nodeIntegration: false,
        session: ses
      }
    });
    view.setBackgroundColor('#0c0e16');

    // Stack the chat view on top of the parent's existing content.
    parent.contentView.addChildView(view);

    const fitToParent = (): void => {
      if (parent.isDestroyed()) return;
      const cb = parent.getContentBounds();
      // Bounds are window-relative for child views of contentView.
      view.setBounds({ x: 0, y: 0, width: cb.width, height: cb.height });
    };
    fitToParent();
    parent.on('resize', fitToParent);

    covers.set(parent.id, { view, onParentResize: fitToParent });

    // Surface load failures (proxy unreachable, DNS, offline, …) so the
    // user sees a styled error page instead of a blank embedded view.
    view.webContents.on('did-fail-load', (_e, errorCode, errorDescription, validatedURL, isMainFrame) => {
      if (!isMainFrame) return;
      if (parent.isDestroyed()) return;
      const html = renderLoadErrorPage(validatedURL || opts.chatUrl, errorCode, errorDescription);
      void view.webContents.loadURL('data:text/html;charset=utf-8,' + encodeURIComponent(html));
      opts.log.error('chat cover failed to load', {
        url: validatedURL,
        errorCode,
        errorDescription
      });
    });

    try {
      await view.webContents.loadURL(opts.chatUrl);
      view.webContents.focus();
    } catch (err) {
      opts.log.error('failed to load chat URL', {
        url: opts.chatUrl,
        error: err instanceof Error ? err.message : String(err)
      });
    }
  }

  function closeChatForParent(parent: BrowserWindow): void {
    const entry = covers.get(parent.id);
    if (!entry) return;
    covers.delete(parent.id);
    parent.off('resize', entry.onParentResize);
    if (!parent.isDestroyed()) {
      // Detach the view and release its webContents. The parent's main
      // webContents — which was never touched — becomes the topmost view
      // again, with all its prior state intact.
      try { parent.contentView.removeChildView(entry.view); } catch { /* already detached */ }
    }
    // Destroy the chat webContents so we don't leak background pages.
    try {
      const wc = entry.view.webContents as WebContents & { destroy?: () => void };
      if (typeof wc.destroy === 'function') wc.destroy();
      else if (typeof wc.close === 'function') wc.close();
    } catch {
      /* already torn down */
    }
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
    const coverOpen = parent ? covers.has(parent.id) : false;
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
    // The chat view is now an embedded WebContentsView — it only goes away
    // when we explicitly call closeChatForParentWithNotify, which already
    // fires `notifyCoverState(parent, false)`. We do additionally listen
    // for the case where the parent window itself is closed, so the
    // observer-state Set stays clean.
    const entry = covers.get(parent.id);
    if (entry) {
      const onParentClosed = (): void => {
        covers.delete(parent.id);
        notifyCoverState(parent, false);
      };
      parent.once('closed', onParentClosed);
    }
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
    for (const w of BrowserWindow.getAllWindows()) attach(w);
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
      // Tear down active chat covers: detach from their parents' contentView
      // and destroy the webContents to release the renderer process.
      for (const [parentId, entry] of covers) {
        const parent = BrowserWindow.fromId(parentId);
        if (parent && !parent.isDestroyed()) {
          try { parent.contentView.removeChildView(entry.view); } catch { /* */ }
          parent.off('resize', entry.onParentResize);
        }
        try {
          const wc = entry.view.webContents as WebContents & { destroy?: () => void };
          if (typeof wc.destroy === 'function') wc.destroy();
          else if (typeof wc.close === 'function') wc.close();
        } catch { /* */ }
      }
      covers.clear();
    }
  };
}
