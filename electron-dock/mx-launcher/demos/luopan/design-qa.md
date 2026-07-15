# Luopan embedded Oversea design QA

- Source: `/var/folders/n2/kk2sxv7103z_fj_mmyp2rllc0000gn/T/codex-clipboard-1bf427ea-ce92-4813-8428-aab0d2ce9671.png`
- Local preview: `http://127.0.0.1:9031/#/`
- Primary viewport/state: 1240 × 820, Luopan default Electron window, anonymous user, Internal idle, Oversea waiting for login
- Full-view evidence: `design-qa/luopan-oversea-window-1240x820.png`
- Focused test-tab evidence: `design-qa/luopan-oversea-final-1240x820.png`
- Source/implementation comparison: `design-qa/source-vs-luopan-final-1240.png`
- Security/runtime regression screenshot: `design-qa/luopan-oversea-security-final-1240x820.png`
- Latest side-by-side comparison: `design-qa/luopan-oversea-reference-comparison-final.png`

## Comparison and iteration history

1. Matched the H2O hierarchy inside Luopan instead of creating another application: subscription hero, readiness state, six functional tabs, local proxy summary, and test shortcuts.
2. Preserved Luopan's own navigation, Internal controls, Release Center, User Center, and configuration surfaces. This shell difference from AppCenter is intentional.
3. The first runtime pass exposed a P1 Electron-main failure: Quasar bundled the CommonJS tunnel package into its ESM output and generated unsupported dynamic `require("http")`. The tunnel package is now explicitly externalized in `quasar.config.ts`; the Electron process starts successfully.
4. Removed a duplicate local Quasar dev instance during QA so only one process writes `.quasar/dev-electron` and owns the Luopan runtime/ports.
5. Rechecked the default 1240 × 820 Electron window. Toolbar actions wrap, all four KPI cards stay inside the viewport, the Oversea hero controls remain visible, and the six tabs fit without horizontal page overflow.
6. The final Electron pass exposed a native ABI mismatch (`better-sqlite3` Node ABI 127 versus Electron ABI 132). Luopan now prepares and packages an isolated Electron-native copy while preserving the shared Node copy; both ABIs execute real SQLite queries in the same workspace.
7. Rechecked the login boundary after configuration hardening: packaged builds pin the registered VIP, development channel changes clear identity/subscription/session/data-plane state, and password login requires the connected service VIP plus a fresh `/healthz` check.
8. Repeated the 1240 × 820 side-by-side comparison after these runtime changes. The visual hierarchy remains aligned with the H2O source; no new clipping, overflow, spacing, border, or typography regression was introduced.

## Interaction checks

- 首页: mode, mixed port, runtime, identity, Internal, subscription, and engine readiness are present.
- 代理: application-global/rule modes and the no-system-TUN boundary are present.
- 订阅: entitlement/subscription state is present and the renderer security boundary is stated.
- 规则: Google, YouTube, X/Twitter, and Telegram allowlist entries are present.
- 测试: URL input, isolated test-window action, four shortcuts, mode/port/proxy decision are present.
- 日志: sanitized runtime-event empty state is present.
- Disabled actions correctly reflect the anonymous/not-connected state.
- Browser console warnings/errors after the interaction pass: none.
- All six tabs were clicked again in the latest in-app-browser pass and each became the unique selected tab.
- The browser-only preview intentionally reports a missing engine because Electron IPC is absent there; the real Electron process separately verified the bundled engine and Oversea database initialization.

## Remaining findings

- P0: none.
- P1: none.
- P2: the AppCenter source uses an H2O side rail while Luopan uses its existing product drawer; this is an intentional product-shell difference, not a missing feature.

Final result: passed
