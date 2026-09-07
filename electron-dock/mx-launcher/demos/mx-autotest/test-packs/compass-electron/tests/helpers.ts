import { mkdirSync, mkdtempSync } from 'node:fs';
import { copyFile, rename, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

import {
  _electron as electron,
  type ElectronApplication,
  type Page,
  type Video
} from 'playwright';

import {
  artifactRoot,
  markBlocked,
  redactDiagnostic,
  writeJsonArtifact,
  type ElectronRuntimeMetadata
} from './evidence.js';

const SAFE_HOST_ENVIRONMENT = new Set([
  'COMSPEC',
  'DBUS_SESSION_BUS_ADDRESS',
  'DESKTOP_SESSION',
  'DISPLAY',
  'LANG',
  'LANGUAGE',
  'LC_ALL',
  'LC_CTYPE',
  'PATH',
  'PATHEXT',
  'SESSIONNAME',
  'SYSTEMROOT',
  'WINDIR',
  'WAYLAND_DISPLAY',
  'XDG_RUNTIME_DIR',
  'XDG_SESSION_TYPE'
]);

export type RendererSurface = 'login' | 'home';

export interface LaunchedCompass {
  application: ElectronApplication;
  window: Page;
  pageErrors: string[];
  severeConsole: string[];
  mainProcessStdout: string[];
  mainProcessStderr: string[];
  profileDir: string;
  tracePath: string | null;
  video: Video | null;
  videoTargetPath: string | null;
  rendererSurface: RendererSurface;
  runtime: ElectronRuntimeMetadata;
}

async function finalizeVideo(video: Video | null, targetPath: string | null): Promise<void> {
  if (!video || !targetPath) return;
  const generatedPath = await video.path();
  if (generatedPath !== targetPath) {
    await rm(targetPath, { force: true });
    try {
      await rename(generatedPath, targetPath);
    } catch (error) {
      if (!(error instanceof Error && 'code' in error && error.code === 'EXDEV')) throw error;
      await copyFile(generatedPath, targetPath);
      await rm(generatedPath, { force: true });
    }
  }
}

function isolatedElectronEnvironment(profileDir: string): Record<string, string> {
  const environment: Record<string, string> = {};
  for (const [key, value] of Object.entries(process.env)) {
    if (value !== undefined && SAFE_HOST_ENVIRONMENT.has(key.toUpperCase())) environment[key] = value;
  }

  const isolatedTemp = join(profileDir, 'tmp');
  const roaming = join(profileDir, 'AppData', 'Roaming');
  const local = join(profileDir, 'AppData', 'Local');
  for (const directory of [isolatedTemp, roaming, local]) mkdirSync(directory, { recursive: true });
  const isolatedEnvironment = {
    ...environment,
    HOME: profileDir,
    USERPROFILE: profileDir,
    APPDATA: roaming,
    LOCALAPPDATA: local,
    TEMP: isolatedTemp,
    TMP: isolatedTemp,
    TMPDIR: isolatedTemp,
    XDG_CONFIG_HOME: join(profileDir, '.config'),
    XDG_CACHE_HOME: join(profileDir, '.cache'),
    XDG_DATA_HOME: join(profileDir, '.local', 'share')
  };
  const forbidden = Object.keys(isolatedEnvironment).filter((key) =>
    /(ACCOUNT|AUTH|COOKIE|CREDENTIAL|PASSWORD|PROXY|SECRET|TOKEN|NODE_OPTIONS)/iu.test(key)
  );
  if (forbidden.length > 0) {
    throw new Error(`Unsafe environment keys reached the Electron launch boundary: ${forbidden.join(', ')}`);
  }
  return isolatedEnvironment;
}

function appendDiagnostic(target: string[], chunk: unknown): void {
  for (const line of String(chunk).split(/\r?\n/u)) {
    if (line.trim() && target.length < 200) target.push(redactDiagnostic(line));
  }
}

async function waitForRealRenderer(window: Page, timeoutMs = 90_000): Promise<RendererSurface> {
  const deadline = Date.now() + timeoutMs;
  let lastState = 'waiting for the Compass renderer';

  while (Date.now() < deadline) {
    if (window.isClosed()) {
      const reason = 'Compass closed before a login or authenticated renderer became ready.';
      await markBlocked('renderer-readiness', reason);
      throw new Error(`[blocked] ${reason}`);
    }
    try {
      const state = await window.evaluate(() => {
        const visible = (element: Element | null) =>
          Boolean(element && element.getClientRects().length > 0 && getComputedStyle(element).visibility !== 'hidden');
        const startupPanel = document.querySelector('.panel');
        if (visible(startupPanel) && startupPanel?.classList.contains('failed')) {
          return { kind: 'failed', detail: startupPanel.textContent?.trim() || 'startup network failed' };
        }
        const loginReady =
          visible(document.querySelector('#account')) &&
          visible(document.querySelector('#password')) &&
          visible(document.querySelector('.login-button'));
        if (loginReady) return { kind: 'login', detail: 'login renderer' };
        if (visible(document.querySelector('.ai-home-page')) || visible(document.querySelector('.arco-main-layout'))) {
          return { kind: 'home', detail: 'authenticated renderer' };
        }
        if (visible(startupPanel) || visible(document.querySelector('.spinner'))) {
          return { kind: 'loading', detail: startupPanel?.textContent?.trim() || 'startup loading page' };
        }
        return { kind: 'waiting', detail: document.title || globalThis.location.href };
      });
      lastState = redactDiagnostic(state.detail);
      if (state.kind === 'login' || state.kind === 'home') return state.kind;
      if (state.kind === 'failed') {
        const reason = `Compass startup reported failure before the real renderer loaded: ${lastState}`;
        await markBlocked('renderer-readiness', reason);
        throw new Error(`[blocked] ${reason}`);
      }
    } catch (error) {
      if (error instanceof Error && error.message.startsWith('[blocked]')) throw error;
      // The startup page replaces its execution context while loading the real renderer.
    }
    await new Promise((resolvePromise) => setTimeout(resolvePromise, 250));
  }

  const reason = `Compass did not expose a login or authenticated renderer within ${timeoutMs} ms (last state: ${lastState}).`;
  await markBlocked('renderer-readiness', reason);
  throw new Error(`[blocked] ${reason}`);
}

async function runtimeMetadata(application: ElectronApplication): Promise<ElectronRuntimeMetadata> {
  const applicationRuntime = await application.evaluate(({ app }) => ({
    applicationVersion: app.getVersion(),
    isPackaged: app.isPackaged,
    os: process.platform,
    platform: process.platform,
    arch: process.arch,
    electronVersion: process.versions.electron || 'unknown',
    chromiumVersion: process.versions.chrome || 'unknown',
    nodeVersion: process.versions.node || 'unknown'
  }));
  const { readFile } = await import('node:fs/promises');
  const packageJson = JSON.parse(await readFile(resolve('package.json'), 'utf8')) as {
    devDependencies?: { playwright?: string };
  };
  return {
    ...applicationRuntime,
    playwrightVersion: packageJson.devDependencies?.playwright || 'unknown'
  };
}

export async function launchCompass(options: {
  videoCaseId?: string;
  traceName?: string;
} = {}): Promise<LaunchedCompass> {
  const appPath = process.env.MX_AUTO_APP_PATH || process.env.MXT_APP_PATH;
  if (!appPath) throw new Error('The run wrapper did not validate a packaged Compass executable.');

  const videoDir = resolve(artifactRoot(), 'videos');
  if (options.videoCaseId) mkdirSync(videoDir, { recursive: true });
  const tracePath = options.traceName
    ? resolve(artifactRoot(), 'traces', `${options.traceName}.zip`)
    : null;
  if (tracePath) mkdirSync(resolve(tracePath, '..'), { recursive: true });
  const profileDir = mkdtempSync(join(tmpdir(), 'mx-auto-compass-'));
  const rawVideoDir = join(profileDir, 'recordings');
  if (options.videoCaseId) mkdirSync(rawVideoDir, { recursive: true });
  const mainProcessStdout: string[] = [];
  const mainProcessStderr: string[] = [];
  const severeConsole: string[] = [];
  const pageErrors: string[] = [];

  let application: ElectronApplication;
  try {
    application = await electron.launch({
      executablePath: appPath,
      args: [`--user-data-dir=${profileDir}`],
      env: isolatedElectronEnvironment(profileDir),
      artifactsDir: resolve(artifactRoot(), 'logs', 'native'),
      ...(options.videoCaseId
        ? {
            recordVideo: {
              // Keep Playwright's random filename outside the upload root. Only
              // the Case-ID filename enters artifacts after successful finalization.
              dir: rawVideoDir,
              size: { width: 1440, height: 900 },
              showActions: { duration: 700, position: 'bottom-right' as const }
            }
          }
        : {})
    });
  } catch (error) {
    await rm(profileDir, { recursive: true, force: true });
    const reason = `Playwright could not launch the packaged Compass application: ${redactDiagnostic(
      error instanceof Error ? error.message : String(error)
    )}`;
    await markBlocked('electron-launch', reason);
    throw new Error(`[blocked] ${reason}`);
  }

  application.process().stdout?.on('data', (chunk) => appendDiagnostic(mainProcessStdout, chunk));
  application.process().stderr?.on('data', (chunk) => appendDiagnostic(mainProcessStderr, chunk));
  const observedPages = new WeakSet<Page>();
  const observeRenderer = (page: Page) => {
    if (observedPages.has(page)) return;
    observedPages.add(page);
    page.on('console', (message) => {
      if (message.type() === 'error') severeConsole.push(redactDiagnostic(message.text()));
    });
    page.on('pageerror', (error) => pageErrors.push(redactDiagnostic(error.message)));
  };
  application.on('window', observeRenderer);
  for (const page of application.context().pages()) observeRenderer(page);
  let capturedVideo: Video | null = null;
  const videoTargetPath = options.videoCaseId
    ? resolve(videoDir, `${options.videoCaseId}.webm`)
    : null;

  try {
    if (tracePath) {
      await application.context().tracing.start({ screenshots: true, snapshots: true, sources: true });
    }

    const window = await application.firstWindow();
    observeRenderer(window);
    capturedVideo = options.videoCaseId ? window.video() : null;
    const rendererSurface = await waitForRealRenderer(window);
    const runtime = await runtimeMetadata(application);
    if (!runtime.isPackaged) {
      const reason = 'The configured Compass target is a development process, not a packaged application.';
      await markBlocked('artifact', reason);
      throw new Error(`[blocked] ${reason}`);
    }
    await writeJsonArtifact('logs/electron-metadata.json', runtime);
    return {
      application,
      window,
      pageErrors,
      severeConsole,
      mainProcessStdout,
      mainProcessStderr,
      profileDir,
      tracePath,
      video: capturedVideo,
      videoTargetPath,
      rendererSurface,
      runtime
    };
  } catch (error) {
    const cleanupWarnings: string[] = [];
    if (tracePath) {
      await application.context().tracing.stop({ path: tracePath }).catch(() => {
        cleanupWarnings.push('Trace finalization failed during blocked startup.');
      });
    }
    await application.close().catch(() => {
      cleanupWarnings.push('Electron close failed during blocked startup; a force-stop was requested.');
      try {
        application.process().kill();
      } catch {
        cleanupWarnings.push('Electron force-stop request failed during blocked startup.');
      }
    });
    if (capturedVideo) {
      cleanupWarnings.push('Startup video was discarded because the Case never reached readiness.');
    }
    await rm(profileDir, { recursive: true, force: true }).catch(() => {
      cleanupWarnings.push('The isolated profile could not be removed after blocked startup.');
    });
    if (process.env.MX_AUTO_ELECTRON_LANE !== 'auth') {
      await writeJsonArtifact('logs/preflight-main-process.json', {
        stdout: mainProcessStdout,
        stderr: mainProcessStderr,
        renderer: { pageErrors, severeConsole },
        cleanupWarnings
      }).catch(() => undefined);
    }
    if (!(error instanceof Error && error.message.startsWith('[blocked]'))) {
      const reason = `Compass preflight could not establish a usable renderer: ${redactDiagnostic(
        error instanceof Error ? error.message : String(error)
      )}`;
      await markBlocked('electron-bootstrap', reason);
      throw new Error(`[blocked] ${reason}`);
    }
    throw error;
  }
}

export async function writeDiagnostics(instance: LaunchedCompass, caseId: string): Promise<string> {
  const relativePath = `logs/${caseId}-diagnostics.json`;
  await writeJsonArtifact(relativePath, {
    caseId,
    rendererSurface: instance.rendererSurface,
    renderer: {
      pageErrors: instance.pageErrors,
      severeConsole: instance.severeConsole
    },
    mainProcess: {
      stdout: instance.mainProcessStdout,
      stderr: instance.mainProcessStderr
    }
  });
  return relativePath;
}

export async function closeCompass(instance: LaunchedCompass | null): Promise<string[]> {
  if (!instance) return [];
  const warnings: string[] = [];
  try {
    if (instance.tracePath) {
      await instance.application.context().tracing.stop({ path: instance.tracePath }).catch(() => {
        warnings.push('Trace finalization failed.');
      });
    }
    await instance.application.close().catch(() => {
      warnings.push('Electron close failed; a force-stop was requested.');
      try {
        instance.application.process().kill();
      } catch {
        warnings.push('Electron force-stop request failed.');
      }
    });
    if (instance.video && instance.videoTargetPath) {
      try {
        await finalizeVideo(instance.video, instance.videoTargetPath);
      } catch {
        warnings.push('Video finalization failed.');
      }
    }
  } finally {
    if (
      instance.application.process().exitCode === null &&
      instance.application.process().signalCode === null
    ) {
      warnings.push('Electron process exit could not be confirmed after cleanup.');
    }
    await rm(instance.profileDir, { recursive: true, force: true }).catch(() => {
      warnings.push('The isolated profile could not be removed after cleanup.');
    });
  }
  return warnings;
}
