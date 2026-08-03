# Admin console design

Status: implemented and visually verified on 2026-08-03.

## Sources

- Product structure: the supplied Sub2API dashboard reference informed the sidebar, KPI, time-control, chart/evidence and administration hierarchy.
- Visual language: `../mx-launcher/demos/ui-design-neon-void` and the shared `../mx-launcher/ui-design` package are authoritative for color, typography, density, radius, borders and interaction states.
- Icons: `@phosphor-icons/react`; no emoji, text-symbol or handcrafted SVG substitutes.

The console intentionally keeps Sub2API-like operational clarity while using the requested MX Neon Void identity. It is not a pixel clone of the reference palette.

## Information architecture

| Group | Page | Primary job |
| --- | --- | --- |
| Business governance | Dashboard | Observe callers, active keys, request outcomes, units and upstream latency. |
| Business governance | Consumers | Manage tenant-scoped business/application identities. |
| Business governance | API Keys | Issue one-time secrets, filter keys and perform explicit revocation. |
| Policy control | Plans and quotas | Explain and edit product-limit semantics. |
| Policy control | Platforms | Grant concrete platforms and configure consumer-specific windows/page size. |
| Observability | Usage | Inspect request evidence without exposing provider details. |
| Observability | Runtime | Separate liveness, store readiness and Night-All readiness. |

Admin authentication is a session-only bootstrap surface. The token is kept in browser session storage, never written to the URL, and automatically cleared on authorization failure or explicit logout.

## Generated brand asset

The visible mark is `public/assets/mx-insight-logo-mark.png`. It was created with the built-in ImageGen workflow from this art direction:

> Original M-shaped data gateway/prism emblem; Neon Void cyan and violet light; subtle magenta key/access accent; dark transparent-ready background; geometric, technical, compact, no text, no copied trademark.

The generated source was cropped into a standalone mark for the 42–64 px sidebar/auth slots. `mx-insight-logo.png` and `mx-insight-logo-chroma.png` retain higher-resolution source variants for future release assets.

## Responsive and accessibility behavior

- At desktop widths, navigation remains persistent and metrics use four columns before collapsing to two.
- Below 900 px, navigation becomes an explicit drawer; below 640 px, metrics/forms become single-column.
- Tables remain horizontally scrollable instead of squeezing action labels into unusable widths.
- Navigation, dialogs, forms, tables, status regions and primary controls have semantic accessible names.
- Empty, loading and error states are first-class components rather than blank panels.

See the repository-root `design-qa.md` for the reference/implementation comparison, tested interactions, console review and final QA status.
