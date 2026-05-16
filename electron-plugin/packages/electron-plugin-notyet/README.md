# @qpjoy/electron-plugin-notyet

A QPJoy marketplace plugin that drops a 古风 + 科技 3D-style floating
consultation ball onto every BrowserWindow of the host app. One tap opens
https://www.notyet.chat as a **cover BrowserWindow** that fully overlays the
parent — closing the cover returns the user to the exact app state they
left, because the underlying window was never touched.

## Features (phase 1)

- Transparent click-through overlay per host window. Clicks outside the ball
  pass through to the underlying app; clicks on the ball / its petals are
  captured. Mouse-region tracking flips this automatically.
- Click ball → 4 cardinal "petal" menu items expand:
  - **咨** open https://www.notyet.chat as a cover window
  - **隐** hide the ball entirely (persists across restarts)
  - **返** close the chat cover (disabled when nothing to return from)
  - **⌘** placeholder for phase-2 actions
- 4 diagonal corner ornaments — decorative only, give the mandala look.
- Auto-collapse 3 s after the mouse leaves the orbit hot zone.
- Show/hide toggle via the marketplace admin panel (calls `setVisible`).

## How it shows up in the marketplace

This package's name matches `@qpjoy/electron-*` so it passes the marketplace
sync prefix filter automatically. Its `package.json` carries a `qpjoyPlugin`
field pointing at `dist/plugin.manifest.json` — that's the authoritative
signal the server uses to mark it `verified: true` and list the card.

## Standalone usage

For apps that don't run the marketplace host but still want the ball:

```ts
import { createOverlayManager } from '@qpjoy/electron-plugin-notyet';

app.whenReady().then(() => {
  createOverlayManager({
    app, ipcMain,
    chatUrl: 'https://www.notyet.chat',
    assetsDir: require.resolve('@qpjoy/electron-plugin-notyet/dist/assets/ball.html')
                .replace(/ball\.html$/, ''),
    userDataDir: path.join(app.getPath('userData'), 'plugins', 'notyet'),
    log: console
  });
});
```

## Phase 2 roadmap

- Animated rim light + particle trail around the ball
- Brushstroke SVG rune in the ball center (replaces the dotted ring)
- Drag-to-reposition the ball
- Per-window position memory
- Better mapping of petal directions when the ball is at extreme corners
- Optional sound cue on expand (off by default)
