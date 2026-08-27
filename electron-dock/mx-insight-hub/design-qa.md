# Source Catalog Design QA

## Comparison target and evidence

- Source visual truth: `/var/folders/n2/kk2sxv7103z_fj_mmyp2rllc0000gn/T/codex-clipboard-fab86061-b5be-4fa4-9a63-f363b8b9b193.png`
- Source pixels: `2710x1312`; normalized to `1415x685` at the same `2.066:1` desktop aspect ratio.
- Browser-rendered implementation: `/private/tmp/mx-source-catalog-overview-final.jpg`
- Implementation pixels and CSS viewport: `1415x685`, device scale factor `1`.
- Same-input full-view comparison: `/private/tmp/mx-source-catalog-dashboard-comparison-final.png`
- Focused multidimensional table: `/private/tmp/mx-source-catalog-table.jpg`
- Focused editor after the sticky-action fix: `/private/tmp/mx-source-catalog-editor-v2.jpg`
- Responsive evidence: `/private/tmp/mx-source-catalog-responsive-760.jpg`, CSS viewport `760x800` (browser capture area `760x780`).
- State: local Admin Token session; `/source-catalog?section=overview` with the deterministic 215-row seed. The source and implementation intentionally show different business metrics: the source is the real Hub gateway dashboard and defines visual grammar, while the implementation is the governed source-catalog dashboard requested for this feature.

## Findings

No actionable P0, P1, or P2 findings remain.

The final side-by-side input confirms the same Hub command-center hierarchy: dark grid canvas, compact page heading, three-panel overview, bordered KPI rail, two-column lower analysis, restrained radii, cyan active state, blue operational charts, and semantic success/warning/danger accents. The additional in-page menu is intentional because the source-catalog brief explicitly requires dashboard, multidimensional table, taxonomy, and plan management under one left-navigation entry.

## Required fidelity surfaces

- Fonts and typography: the implementation reuses the Hub/Neon Void font stack and existing `--qp-font-*` scale. Heading weights, muted explanatory copy, tab labels, KPI numerals, chart labels, table text and monospaced identifiers remain consistent with the source. Long taxonomy and source names truncate or wrap inside bounded controls instead of colliding.
- Spacing and layout rhythm: desktop uses the source's three-panel overview, continuous KPI rail and lower analysis/risk split. The menu adds one deliberate 44px interaction layer; overview density was tightened so meaningful lower-dashboard content remains above the fold. Panel padding, 12–14px section gaps, one-pixel dividers and existing Hub radii/elevation match the source grammar.
- Colors and visual tokens: panels, grid background, borders, copy and state colors all come from existing `--qp-*` tokens. Cyan is reserved for the selected route, selected subpage, focus and primary coverage; blue, green, amber, purple and red retain operational semantics with adequate dark-theme contrast.
- Image and asset quality: the real MX Insight Hub logo is reused. All functional icons use the installed Phosphor family and all charts use Chart.js; there are no emoji, placeholder images, handcrafted SVGs, inline SVG illustrations, CSS-art replacements or stretched assets.
- Copy and content: all visible counts are derived from the 215-row catalog. `29/186`, `doing/exploring/complete`, unassigned owners and review gaps are kept on separate evidence axes. The Telegram completion note is backed by real runbook and pipeline references; no sample alert or fake runtime-health claim is shown.
- Icons and states: selected, hover, focus, disabled, archived, success, warning and destructive-confirmation states use the existing interaction language. Canvas charts expose text alternatives, native inputs retain labels, and keyboard focus is visible.
- Responsiveness and accessibility: at `760px` the document width remains exactly `760px`, the overview becomes one column, the menu remains usable, and KPI tiles become four columns before the narrower two-column breakpoint. Reduced-motion disables catalog transitions. The editor traps focus through the shared Modal component and keeps Save/Archive actions visible while its body scrolls.

## Focused interaction evidence

- Search reduced the 215-row catalog to the two Telegram records.
- The built-in bottom/covered/uncovered/in-progress/P0/unassigned/archive views report real counts.
- Next-page navigation is enabled for page 1 of 8 after the pagination fix.
- A local test record was created using Enter-to-add scenario, region and tag controls, then archived, restored and verified through create/archive/restore audit events. The memory server was restarted afterward, returning the deliverable preview to the clean 215-row seed.
- Telegram exposes eight evidence references and a baseline import event.
- Desktop overview, table, editor and `760px` responsive layout were rendered in the in-app browser.
- Browser console review returned no errors or warnings.

## Comparison history

1. Pass 1 found a P2 layout mismatch: the catalog-specific `1500px` breakpoint moved governance health below the overview at a normalized desktop viewport, unlike the real Hub dashboard. The breakpoint was aligned to `1320px`; the post-fix three-column evidence is `/private/tmp/mx-source-catalog-overview-v2.jpg`.
2. Pass 2 found P2 density drift: source-catalog overview cards were taller than the visual baseline. The panel minimum height changed from `222px` to `200px` and the category chart from `148px` to `126px`. The post-fix evidence is `/private/tmp/mx-source-catalog-overview-final.jpg`.
3. Table interaction review found a P1 functional defect: `Pagination` had eight known pages but Next was disabled because `hasMore` was omitted. The catalog now passes `hasMore={currentPage < totalPages}`; the final table evidence shows 30 rows and an enabled Next control.
4. Editor review found a P2 usability defect: the modal footer fell below a `685px` viewport. The source-catalog xlarge modal now uses a fixed header/footer grid and a scrollable body; `/private/tmp/mx-source-catalog-editor-v2.jpg` shows Save, Cancel and Archive visible without page scrolling.
5. Final comparison found no remaining actionable P0/P1/P2 mismatch. The different charts and copy are required domain content, not visual drift.

## Dropdown repair QA — 2026-08-27

### Comparison target and evidence

- Source visual truth, editor single-select: `/var/folders/n2/kk2sxv7103z_fj_mmyp2rllc0000gn/T/codex-clipboard-84606fcb-1352-4dba-8d80-988c34f9d63d.png`, `1796x1158` pixels.
- Source visual truth, editor multiselect: `/var/folders/n2/kk2sxv7103z_fj_mmyp2rllc0000gn/T/codex-clipboard-7ddb6de1-03c5-4e69-acd8-1fcb48665edf.png`, `1790x1162` pixels.
- Source visual truth, table toolbar: `/var/folders/n2/kk2sxv7103z_fj_mmyp2rllc0000gn/T/codex-clipboard-36814f8e-91e9-43b1-b5a2-5281bc71c7e9.png`, `2292x1258` pixels.
- Browser-rendered editor single-select: `/private/tmp/mx-source-catalog-editor-dropdown-final.png`, `1790x987` capture area from a `1790x1160` viewport override, density `1`.
- Browser-rendered editor multiselect: `/private/tmp/mx-source-catalog-region-dropdown-final.png`, `1790x987` capture area from the same override, density `1`.
- Browser-rendered table toolbar: `/private/tmp/mx-source-catalog-toolbar-final.png`, `2282x1258` capture area from a `2292x1258` viewport override, density `1`; the ten-pixel width delta is the browser scrollbar.
- Same-input full-view comparisons: `/private/tmp/mx-editor-dropdown-comparison.png` and `/private/tmp/mx-toolbar-dropdown-comparison.png`.
- Same-input focused comparison: `/private/tmp/mx-dropdown-focused-comparisons.png`. Source and implementation controls were cropped at native density, then each crop was scaled to the same `720px` inspection width; this removes the source screenshot's modal/page framing difference while keeping typography, borders and menu states readable.
- State: local Admin Token session, `#/source-catalog?section=catalog`; the table “分组” menu, editor “来源类型” menu and editor “区域” multiselect are open. No record was saved during QA.

### Findings

No actionable P0, P1 or P2 findings remain. The source captures demonstrate the defect—OS-controlled white/gray menus, system-blue selection and a narrow detached datalist. The post-fix captures show one Hub-native dark control language across toolbar, filters, bulk actions, editor enum fields, createable category and multivalue tags.

### Required fidelity surfaces

- Fonts and typography: trigger values and options use the existing Neon Void body/caption scales and weights. Labels, long category names and option text remain legible with bounded ellipsis rather than native platform typography.
- Spacing and layout rhythm: menus anchor to the full control width, use a 6px offset, 6px internal padding, 30–32px option rows and the existing Hub radius/elevation tokens. Bottom-edge editor menus flip upward inside the scrollable modal body instead of being clipped.
- Colors and visual tokens: menu background, hover, selected, border, focus ring and text all resolve through `--qp-*` dark-theme tokens. Selected options use the Hub cyan tint and icon rather than system blue.
- Image and asset quality: no new raster assets, CSS drawings or handcrafted SVGs were introduced. Check, caret and plus affordances use the installed Phosphor icon family.
- Copy and content: every existing option and Chinese label is preserved. Createable fields explicitly label new values (`使用新分类` / `新增`) while existing selections display a check.
- States, icons and accessibility: all single-select controls expose combobox/listbox semantics; multiselect exposes `aria-multiselectable` and per-option `aria-selected`. Arrow keys, Enter, Escape, outside-click close, selected checks, focus rings and automatic up/down placement were exercised in the browser.
- Responsiveness: toolbar controls retain compact treatment at the wide reference viewport and wrap through the existing responsive toolbar rules at narrower widths. Popovers are bounded by `min(280px, 42–46vh)` with dark scrollbars.

### Interaction evidence and comparison history

1. The initial source comparison contained P1 visual/interaction defects: native select and datalist popups escaped the Hub theme, the region list was detached from its field, and modal `mousedown` could unmount the editor before a pending tag blur committed.
2. Native controls were replaced with the shared ARIA dropdown plus createable single- and multivalue comboboxes. The modal gained scoped backdrop-close protection and pending tag drafts moved to editor-owned state.
3. First post-fix browser pass confirmed values survived click-away, but found a P2 edge-placement issue: the region menu could be clipped by the editor body's scroll boundary. Menus now measure the modal-body boundary and flip upward when needed; `/private/tmp/mx-source-catalog-region-dropdown-final.png` is the post-fix evidence.
4. Final browser pass selected “按大类”, clicked outside and retained the value; selected “全球”, clicked another field and retained both region chips; typed a new region, clicked elsewhere and retained the committed chip; clicked the modal backdrop and confirmed the editor and unsaved chips remained open. Category focus displayed all ten existing categories and filtering/creation remained available. The explicit caret button closed and reopened the region menu, and Escape closed only the menu while keeping the editor open. Text combobox handlers ignore IME composition events so Chinese candidate confirmation is not mistaken for add/select.
5. Final focused comparison found no remaining actionable P0/P1/P2 mismatch. The intentionally dark implementation is the requested correction to the defective native rendering shown in the sources.

final result: passed

---

# Data products design QA

## Scope

- Product entry: `数据产品`
- Routes: data source catalog, Telegram public channels, Telegram public groups, nationwide public opinion
- Browser viewport: 1280 × 720, in-app Browser
- Visual language: existing MX Insight Hub / Neon Void tokens

## Reference comparison

- Province selector reference: `/var/folders/n2/kk2sxv7103z_fj_mmyp2rllc0000gn/T/codex-clipboard-14ea85c5-ad74-4156-8057-f89792a5d548.jpg`
- Public-opinion list/detail reference: `/var/folders/n2/kk2sxv7103z_fj_mmyp2rllc0000gn/T/codex-clipboard-40227940-85e2-454a-a400-e028b37d8fda.png`
- Side-by-side province selector comparison: `artifacts/design-qa/picker-comparison.jpg`
- Side-by-side public-opinion comparison: `artifacts/design-qa/opinion-comparison.png`

The implementation preserves the reference workflows rather than its light palette: a searchable province grid, selected-region state, ranked news list, active item, detail panel, time range, hot/latest sorting and source facts. It adds coverage counts and explicit data-health diagnostics while staying inside the Hub design system.

## Interaction verification

- Data-product parent navigation expands and collapses; active child auto-expands the branch.
- Sidebar navigation scrolls independently at short viewport heights and no longer overlaps the protected-session card.
- Telegram channel and group directories are server-filtered and searchable.
- Selecting a chat loads its archived message window.
- Message search returns canonical anchors; clicking a hit opens the requested before/after context and shows stored/upstream completeness.
- Province picker lists all 34 regions, supports text search and exposes per-region availability.
- Jiangsu renders list and detail data; Beijing renders an explicit successful zero-data state.
- Coverage, pipeline, scheduling and quality failures remain distinct from an empty feed.
- Demo content is visibly labelled and does not offer a broken external-source link.
- No browser console errors were observed; only Vite development logs were present.

## Accessibility and responsive checks

- Main navigation, dialogs, search fields, regions, pagination and segmented controls expose semantic roles and accessible names.
- Selected/pressed/expanded states are announced through ARIA.
- Keyboard-safe native controls are retained for numeric before/after limits.
- The desktop workbench collapses through existing responsive breakpoints; the nested sidebar remains scrollable instead of covering session controls.

## Captured states

- `artifacts/design-qa/telegram-channels-viewport.jpg`
- `artifacts/design-qa/telegram-context.jpg`
- `artifacts/design-qa/opinion-region-picker.jpg`
- `artifacts/design-qa/opinion-detail.jpg`
- `artifacts/design-qa/opinion-empty.jpg`

## Final result

passed

---

# Hub-wide searchable dropdown and light theme QA — 2026-08-27

## Comparison target and evidence

- Native-popup defect reference: `/var/folders/n2/kk2sxv7103z_fj_mmyp2rllc0000gn/T/codex-clipboard-e25cadea-188c-4b67-bed0-d4b30687e599.png`, `2786x1350` pixels.
- Target dropdown reference: `/var/folders/n2/kk2sxv7103z_fj_mmyp2rllc0000gn/T/codex-clipboard-649693bb-bbba-466d-8136-fee07672dd54.png`, `2790x1342` pixels.
- Repaired caller filter: `/private/tmp/mx-hub-dark-consumer-tenant.jpg`, `1526x985` pixels.
- Desktop dark target state: `/private/tmp/mx-hub-dark-source-group.jpg`, `1526x985` pixels.
- Responsive light target state: `/private/tmp/mx-hub-final-light-source-group.jpg`, `760x800` pixels.
- Light login state: `/private/tmp/mx-hub-light-login.jpg`, `760x800` pixels.
- Modal-boundary state: `/private/tmp/mx-hub-owner-dropdown-boundary.jpg`, `760x800` pixels.
- Same-input desktop comparison: `/private/tmp/mx-dropdown-full-comparison.jpg`. The reference was normalized to `2048x985`, cropped to the implementation's `1526x985` capture width, then placed beside the implementation without changing density.
- Same-state focused comparison: `/private/tmp/mx-dropdown-final-focus-comparison.jpg`. Both sides show the open `分组 / 不分组` state; native-density crops were normalized to the same `440x410` inspection frame.
- State: local Admin Token session with no production credentials or external writes. The source-catalog table, caller tenant filter, Agent modal, login gate and design-system demo were exercised in dark and light themes.

## Findings

No actionable P0, P1 or P2 findings remain. The final focused comparison preserves the target anatomy: compact trigger, attached dark popover, bordered search field, cyan selected row, explicit check, four searchable options, restrained radius and tokenized elevation. The caller page no longer delegates its expanded menu to macOS/Chromium, so the white system popup in the defect reference cannot recur in Hub source code.

## Required fidelity surfaces

- Fonts and typography: triggers, search text, options and group labels use the existing Neon Void font stack and `--qp-font-*` scale. Chinese labels retain the target hierarchy and remain legible at the `760px` responsive breakpoint.
- Spacing and layout: trigger and menu edges share an anchor, search padding and option-row rhythm match the target, menus are viewport bounded, and the responsive toolbar wraps without overlap. The source editor's owner menu remained inside the modal body; because space was available it correctly stayed downward rather than forcing an upward state.
- Colors and tokens: dark values remain the original Neon Void defaults. Light is opt-in through `.qp-theme-neon-void-light`, using cool white/blue-gray surfaces and deep teal `#087f75` instead of low-contrast neon cyan. White-surface contrast is `15.31:1` for primary text, `4.88:1` for teal primary, `7.46:1` for success, `6.99:1` for danger and `7.19:1` for info.
- Image and asset quality: the real Hub logo is unchanged. Caret, check, search, theme and session affordances use the installed Phosphor family in Hub; no placeholder image, emoji, CSS illustration or new handcrafted SVG asset was introduced.
- Copy and content: all existing option values, Chinese labels, query parameters and submitted payload values are preserved. Search adds only contextual placeholders and the explicit `没有匹配项` state.
- Icons and states: closed, open, hover/highlight, selected, disabled, clear-search, no-result, long-list, modal and theme-toggle states were inspected. The shared design demo documents searchable and disabled variants while retaining the legacy native select only as an explicitly documented fallback.
- Accessibility: the trigger exposes combobox/listbox semantics; the separate filter input is a named `searchbox` outside the listbox; options expose `aria-selected` and disabled state. ArrowUp/Down, Home/End, Enter, Escape, Tab, IME guards, focus return and outside-pointer close remain in the shared component.
- Viewport resilience: the desktop comparison retains the target command-center density. At `760x800` the sidebar collapses behind the existing navigation control, the light toolbar wraps, the dropdown remains wholly visible and the page has no control collision.

## Interaction and regression evidence

1. Source scan now finds zero `<select>` or `<option>` elements under `mx-insight-hub/src`; all 19 wrapper-expanded Hub selection sites resolve through the shared searchable dropdown.
2. Search plus ArrowDown/Enter selected `按阶段` and closed the menu with focus restored. Escape closed only the menu. A 12-option classification list filtered to the two `海外` matches, and a non-matching query rendered `没有匹配项` with zero options.
3. Light/dark preference survived reload and sign-out. The local Admin Token login completed again after the theme and dropdown changes, returning to the protected session without changing authentication requests, token storage or server forwarding.
4. The design demo switched dark/light, searched tenants and selected `LCY` by keyboard. Its disabled specimen remained non-interactive.
5. Browser console review returned no errors or warnings for Hub or the design demo.
6. Build/regression gates passed: Hub production build, Sites tests `4/4`, design-system build/typecheck, demo syntax check, Luopan check/build, and the full MX-H2I safety check including anonymous entry, Feishu OAuth, bootstrap domain, split-DNS and Windows reconnect assertions.

## Comparison history

1. Audit found 11 literal native selects, 19 effective page controls, a duplicated page-local searchable implementation, and no light theme. The page-local implementation was consolidated into the shared Hub component and every native Hub site was migrated.
2. First browser pass confirmed dark/light rendering and login persistence, then exposed two implementation risks: filtered grouped options could repeat their heading, and the popup search input duplicated the trigger's combobox role. Group emission is now once per group and the filter is a named searchbox.
3. Compatibility review found that replacing the legacy pseudo-check would remove selected marks from older `qp-dropdown` markup. The original fallback check contract was restored while explicit icon children suppress it, keeping existing dark consumers pixel-stable.
4. Final side-by-side and focused comparisons found no remaining actionable mismatch. Dark retains the reference look; light reads as the same product rather than an inverted or washed-out skin.

final result: passed
