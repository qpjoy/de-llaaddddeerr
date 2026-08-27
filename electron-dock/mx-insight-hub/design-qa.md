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
