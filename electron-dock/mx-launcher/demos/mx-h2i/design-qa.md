# MX-H2I Brand Refresh — Design QA

- Source visual truth:
  - `/Users/qpjoy/workspace/mingxi/de-mingxi/company/明悉科技Logo.png`
  - `/var/folders/n2/kk2sxv7103z_fj_mmyp2rllc0000gn/T/codex-clipboard-29cd3c8e-a9de-4396-a216-52228caba6f6.png`
- Implementation screenshot: `/private/tmp/mx-h2i-brand-connected-v2.png`
- Full-view comparison: `/private/tmp/mx-h2i-brand-comparison.png`
- Focused logo comparison: `/private/tmp/mx-h2i-brand-logo-comparison.png`
- Viewport: source normalized from 924×1520 @2x to 462×760 CSS px; implementation captured at 462×760 CSS px.
- State: connected guest session.

## Findings

- The official black-and-white Mingxi mark replaces the former teal `H2I` placeholder without changing the 58×58 hero footprint.
- The logo keeps its original neutral palette. MX-H2I teal remains reserved for connection state and the primary action.
- Logo, product name, heading, CTA, and status cards preserve the existing hierarchy and alignment.
- The source screenshot contains a runtime WireGuard feedback banner that is absent from the static mock state; this is state-data variance, not layout drift.
- The same brand asset is wired into the app shell, ownership card, browser/window icon, tray, and platform packaging icons.
- Browser console errors: none.
- P0/P1/P2 visual issues: none.

## Iteration history

1. Replaced the text placeholder with the optimized official mark and retained the existing layout footprint.
2. Removed teal from the brand mark and added only a restrained neutral outline plus a low-opacity teal ambient glow.
3. Re-captured idle and connected states at the target viewport and compared the connected state side by side with the supplied screenshot.

Final result: passed
