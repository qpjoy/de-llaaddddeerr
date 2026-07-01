# @qpjoy/ui-design-neon-void

Neon Void is the reusable QPJoy dark tool UI style extracted from the MX Launcher design base. It packages the screenshot style as npm-ready tokens plus CSS components: deep blue-black workspaces, cyan primary actions, quiet panel surfaces, purple design frames, and precise status colors.

## Design Language

Neon Void is built for dense product and operations tools, not marketing pages. The first screen should feel like a working console: clear navigation, compact state feedback, direct actions, and enough contrast for repeated daily use.

- Backgrounds step from `BG1 #141417` to `BG4 #292C37`, creating a dark canvas, workspace, panel, and dialog/actionbar elevation system.
- Main interaction color is `M1 #2BF6D2`, with hover `#11CDB5` and pressed `#079987`.
- Status colors are intentionally saturated: danger `#EE6067`, warning `#F8D06C`, success `#48BC77`, info `#5E8EEC`, archetype `#B974FF`.
- Text is a five-step alpha ladder on `#E2E2E2`, so disabled, muted, metadata, and primary text can stay consistent.
- Radius is restrained at 4/6/8px, with pill radius only for tags, avatars, switches, and chips.
- Effects are quiet: a few drop shadows, subtle inner highlights, cyan focus rings, and dashed purple design frames for component specimens.
- Typography follows the screenshot scale: 20/16/14/12/10px with 150% line-height, using Poppins first and system CJK fallbacks.

## Install

```sh
pnpm add @qpjoy/ui-design-neon-void
```

```ts
import '@qpjoy/ui-design-neon-void/styles.css';
import { neonVoidTokens } from '@qpjoy/ui-design-neon-void';
```

```html
<main class="qp-app qp-theme-neon-void qp-density--medium">
  <button class="qp-button qp-button--primary">Publish</button>
  <input class="qp-input" placeholder="Search" />
</main>
```

## Density

The screenshots look compact because of capture scale, so the library does not lock the style to a compact UI. Use one of three densities on any container:

```html
<section class="qp-theme-neon-void qp-density--small">...</section>
<section class="qp-theme-neon-void qp-density--medium">...</section>
<section class="qp-theme-neon-void qp-density--large">...</section>
```

Individual controls also support explicit sizes such as `qp-button--sm`, `qp-button--md`, `qp-button--lg`, `qp-input--sm`, `qp-input--md`, and `qp-input--lg`.

## Exports

- `@qpjoy/ui-design-neon-void/styles.css`: tokens plus component classes.
- `@qpjoy/ui-design-neon-void/tokens.css`: CSS custom properties only.
- `@qpjoy/ui-design-neon-void/tokens.json`: portable design tokens.
- `@qpjoy/ui-design-neon-void`: TypeScript token and class name helpers.

## Component Classes

- Layout: `qp-app`, `qp-shell`, `qp-sidebar`, `qp-main`, `qp-panel`, `qp-card`, `qp-section-title`.
- Actions: `qp-button`, `qp-icon-button`, `qp-button--primary`, `qp-button--outline`, `qp-button--ghost`, `qp-button--transparent`.
- Form: `qp-field`, `qp-input`, `qp-select`, `qp-dropdown`, `qp-textarea`, `qp-input-group`.
- Choice: `qp-choice--radio`, `qp-choice--checkbox`, `qp-switch`, `qp-slider`, `qp-segmented`.
- Feedback: `qp-tag`, `qp-status`, `qp-toast`, `qp-dialog`, `qp-actionbar`.
- App surfaces: `qp-menu`, `qp-list`, `qp-project-card`, `qp-market-layout`, `qp-market-card`, `qp-market-inspector`, `qp-chip-list`, `qp-user-card`, `qp-color-swatch`.
- Settings: `qp-appbar`, `qp-settings-view`, `qp-settings-nav`, `qp-setting-row`, `qp-version-card`, `qp-path-field`.
- Properties: `qp-properties-panel`, `qp-property-section`, `qp-property-row`, `qp-axis-grid`, `qp-axis-field`, `qp-swatch-input`.
- Editor panels: `qp-panel-tabs`, `qp-panel-tab`, `qp-split-panel`, `qp-anchor-grid`, `qp-anchor-preset`.
- Icons: `qp-icon`, `qp-icon-board`, `qp-icon-category`, `qp-icon-grid`, `qp-icon-cell`.

## Demo

From `electron-dock/mx-launcher`:

```sh
bash scripts/manage.sh ui-design demo
```

Then open:

```text
http://127.0.0.1:18130/demos/ui-design-neon-void/
```

## Publish

From the repository root:

```sh
./scripts/manage.sh prepare-design
```

The script bumps, builds, packs a preview tarball, prints the manual `pnpm publish --no-git-checks --otp=...` command, and can publish directly when an OTP is entered.
