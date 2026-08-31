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

# Agent Studio P1 design QA — 2026-08-31

## Comparison target and evidence

- Portfolio source visual: `/Users/qpjoy/.codex/generated_images/01a05606-8728-79d3-b070-45d33126717a/exec-6900b2fd-275f-47f4-a6f3-5c0bc6f432c3.png`, `1487x1058` pixels.
- Draft workbench source visual: `/Users/qpjoy/.codex/generated_images/01a05606-8728-79d3-b070-45d33126717a/exec-38cbc327-c4f5-43cb-801e-444d68a2a9f6.png`, `1487x1058` pixels.
- Browser-rendered Portfolio: `/private/tmp/mx-agent-studio-portfolio-final.jpg`, `1487x1041` capture from a `1487x1058` CSS viewport at device scale factor `2`.
- Browser-rendered Draft workbench: `/private/tmp/mx-agent-studio-detail-final.jpg`, same viewport and capture dimensions.
- Same-input full-view comparisons: `/private/tmp/mx-agent-studio-portfolio-compare.png` and `/private/tmp/mx-agent-studio-detail-compare.png`. Each source was top-cropped to `1487x1041` without rescaling, then placed beside the implementation.
- Same-input focused comparisons: `/private/tmp/mx-agent-studio-portfolio-focus-compare.png` and `/private/tmp/mx-agent-studio-detail-focus-compare.png`, native-density `1237x984` workspace crops.
- Theme and responsive evidence: `/private/tmp/mx-agent-studio-detail-dark.jpg`, `/private/tmp/mx-agent-studio-detail-1280.jpg`; additional live inspection used `1024x768`.
- State: local Admin Token session backed by the real PostgreSQL migration. The Portfolio contained four server-owned projects and four CAS drafts; the nationwide public-opinion project retained one immutable compiled Artifact and no fabricated run, evaluation, release or deployment.

## Findings

No actionable P0, P1 or P2 finding remains.

The Portfolio preserves the confirmed authoring IA: `Agent 中心` remains the one first-level group, `Agent Studio` is a second-level entry, the Studio landing route lists all author assets, and a project opens a separate Draft route. The final Portfolio adds the requested governance notice, asset tabs, search, five governed dimensions, dense lifecycle columns, real metadata management and soft archive.

The workbench preserves the confirmed compiler layout: code-owned palette, typed-port React Flow canvas, clickable nodes, Prompt-first inspector, LLM Sequence reference, read-only resolved proxy/model evidence, compile diagnostics and immutable Artifact facts. Build edges stay neutral. The Run Path state shows zero events and zero animated edges because P1 has no Sandbox runtime.

## Required fidelity surfaces

- Typography and layout: the implementation uses the existing Poppins/system-CJK stack and `--qp-font-*` scale, the same 252px global sidebar, compact 58px top bar, one-pixel separators and dense control-plane rhythm. Portfolio columns fit the `1487px` review viewport without document or table overflow; `1280px` remains a three-column workbench and `1024px` moves the inspector below the canvas with no horizontal document overflow.
- Colors and tokens: cool-light is the default and uses the existing white/blue-gray surfaces with deep teal primary. Dark parity resolves through the same Neon Void variables. Status always combines icon and text; color alone is not the state carrier.
- Image and icon quality: the real MX Insight Hub logo is reused. Functional icons come from Phosphor and the graph is rendered by React Flow with its attribution visible. No placeholder image, emoji, CSS illustration or handcrafted decorative SVG was introduced.
- Copy and content: all Portfolio values come from the Studio API. `尚未编译`, `尚未评测`, `无 Release`, `未部署`, `Market 不可见` and `P1/P2/P4` labels are explicit rather than inferred as zero or healthy. Source-catalog coverage is not presented as an executable connector. The concrete public-opinion draft produces only a reviewable mapping proposal.
- Prompt and model routing: selecting the mapping node exposes editable System Prompt and Task Template fields plus governed variables. The Draft stores only a Sequence key; effective model, egress, proxy and route proof remain read-only. In the local state no matching approved Sequence exists, so the UI truthfully shows unresolved routing instead of silently choosing a Provider or Proxy.
- Accessibility and interaction: Portfolio rows, tabs, comboboxes, graph nodes, inspector tabs, modals and confirmation actions expose named semantics and focusable controls. Nodes can be selected from the graph and refresh the Inspector. The shared Modal and ConfirmDialog retain keyboard/focus behavior.

## Interaction and regression evidence

1. Search reduced four projects to one. The business-domain combobox exposed only dimensions derived from real tags (`enterprise`, `news`, `public-opinion`, `search`), and combined search/facet filtering returned the expected row.
2. The server-backed Templates tab displayed the two approved compile-only templates and did not substitute browser fixtures.
3. The Manage dialog saved a same-value metadata update through project CAS and advanced only the project revision. Soft archive reduced the active list from four to three and exposed the project under `已归档`; its Restore control returned the project to the active list through the same CAS API, leaving all four deliverable products active.
4. Selecting `Validate Mapping Contract` and `舆情字段映射建议` changed the Node Inspector. The Prompt tab rendered two editable text areas and retained the previously saved guarded prompt.
5. The compiled project reloaded with Artifact `f09283ad-d97f-47b5-8ba8-39d4dd8a49d2`, hash `8d76390f4822b42a5354af8876363d2c8517e5af908ec4af836586ae26d7b1bc`, zero errors and zero warnings. Its Run Path showed `暂无运行事件`, zero animated edges and compile-only explanatory copy.
6. A fresh browser navigation after the final React Flow fixes produced zero console warnings or errors. Cool-light, dark, `1487x1058`, `1280x720` and `1024x768` states were inspected.
7. Validation gates passed: TypeScript, production build, focused Studio/auth boundary tests `16/16`, full Hub suite `866` tests (`864` pass, `2` environment skips, `0` fail), and the complete MX-H2I login/network safety check including password/Feishu/bootstrap-domain/split-DNS/reconnect/ASAR coverage.

## Intentional P1 differences from the concept visuals

- The concept workbench depicts a live Debug run with colored paths and a populated event timeline. P1 has no general runtime, so the implementation stops at Build and Compile and does not simulate success, failure, latency or health.
- The concept Portfolio contains illustrative products, category labels and lifecycle objects. The implementation displays the four migrated server records and only their real Draft/Artifact objects; Release, Deployment and Market visibility remain empty until those models exist.
- Import, quarantine, dataset publication, Eval, approval, deployment and Market publishing remain visibly future capabilities. They were not implemented by extending the fixed Agent Market dry-run adapter.

## Comparison history

1. The first implementation pass used a summary strip and omitted the confirmed governance notice, asset tabs and multidimensional filters. It also exposed management actions without a real metadata endpoint. The Portfolio was rebuilt around the confirmed seven-column matrix and the actions were connected to a strict CAS/soft-archive API.
2. The first workbench capture compressed the graph because it honored wide seed coordinates and showed stale `尚未编译` copy after an Artifact reload. Display-only compact positions and Artifact-derived evidence fixed both issues without changing the saved graph or artifact hash.
3. The first final Portfolio pass used a `1240px` minimum row width, clipping the Operations column at the `1487px` review viewport. The column contract was reduced to a truthful `1096px` minimum; the final page has `scrollWidth === innerWidth` and all operations remain visible.
4. Migration review found that soft archive had been inserted into already-applied migration 046. Migration 046 was restored byte-for-byte to its recorded checksum and the additive column moved to migration 047; the live PostgreSQL upgrade preserved four projects, four drafts and the existing Artifact.
5. Final truth review found that Portfolio lookup could retain an Artifact compiled for an older Draft revision after a new Draft save. The server query now exposes an Artifact only when `compiled.draft_revision = current_draft.current_revision`; a dedicated regression test prevents stale compile state from returning.
6. Final full-view and focused comparisons found no remaining actionable mismatch. Differences from the running-state concept are deliberate capability boundaries, not missing visual polish.

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

---

# Agent Market design QA

- Source visual truth: `/Users/qpjoy/.codex/generated_images/01a0532a-6f93-7761-8c1d-c41aed4566f5/exec-bc51c042-8147-4492-9e85-245f4f9906b1.png`
- Browser-rendered implementation: `/Users/qpjoy/workspace/qpjoy/de/de-llaaddddeerr/electron-dock/mx-insight-hub/design-qa-final-run.jpg`
- Additional states: `design-qa-catalog.jpg`, `design-qa-light.jpg`
- Route: `http://127.0.0.1:5173/#/agent/market`
- Viewport: 1280 × 720 CSS px, desktop in-app browser
- Source pixels: 1536 × 1024. For the equal-size comparison it was normalized to 1280 × 853 and top-cropped to 1280 × 720 at 1× density in `/private/tmp/agent-market-reference-1280x720.png`.
- Implementation pixels: 1280 × 720 at 1× density.
- State: dark theme, protected Admin Token session, `advanced-search` selected, completed real local dry-run. The source contains illustrative benchmark data; the implementation intentionally shows only values returned by the running service.

## Full-view comparison evidence

The normalized source and final implementation were opened together in one comparison pass. The implementation preserves the source hierarchy and Neon Void language: global navigation, Agent catalog rail, selected Agent identity, bounded run composer, luminous directed stage graph, semantic status colors, and evidence-oriented comparison areas. At this 1280px breakpoint the Inspector moves below the graph rather than compressing into an unreadable third column; the three-column layout is retained above the 1500px breakpoint.

The source presents hypothetical persisted benchmarks, dataset selectors and rich evidence scores. Those values were not copied as fixtures. The implementation instead displays `—`, `暂无运行`, `n=1`, or the actual dry-run trace so that the product does not claim accuracy, route performance or health that it has not measured.

## Focused-region evidence

No separate pixel crop was required after the equal-size comparison because the catalog cards, run composer, graph nodes and state labels remain legible in the 1280 × 720 captures. Additional browser captures verified two important focused states:

- `design-qa-catalog.jpg`: Knowledge Q&A is visibly `Catalog Only · 未配置执行器`, has no stale graph or result, and its run action is disabled.
- `design-qa-light.jpg`: the same catalog and graph remain readable in the light theme without lost borders or semantic state colors.

## Findings

No actionable P0, P1 or P2 findings remain.

- Typography: Poppins/system CJK fallbacks, heading weights, code text and compact metadata retain the source hierarchy. Small metadata contrast is now raised locally inside the workbench.
- Spacing and layout: the catalog/main/inspector hierarchy is preserved; at 1280px the responsive two-column arrangement avoids squeezing the main graph. Horizontal graph overflow remains deliberately scrollable.
- Colors and tokens: Neon Void tokens, cyan selection, green success, amber degradation and red failure are consistently applied in both themes. State is also expressed with text/icons.
- Image and icon quality: the existing MX logo asset and Phosphor icon family are reused; no placeholder imagery, emoji, handcrafted SVG illustration or CSS substitute was introduced. SVG is limited to semantic graph edges.
- Copy and content: catalog/run language distinguishes real records, unavailable execution, dry-run safety and single-sample diagnostics. Synthetic accuracy and health claims are absent.
- Accessibility: semantic buttons, labeled fields, `tablist`/`tabpanel`, focus styles, text state labels and `prefers-reduced-motion` are present. The graph has keyboard-operable DOM nodes in addition to decorative SVG edges.

## Comparison history

1. Initial browser pass found a P2 accessibility issue: numerous 9–11px metadata labels inherited the global extra-faint `text-3`/`text-4` opacity tokens and were visibly harder to read than the source.
2. Fix: `src/agent-market.css` now scopes stronger theme-aware muted text tokens to `.mih-market-workbench`, preserving the Neon palette while improving dark/light contrast.
3. Post-fix evidence: `design-qa-final.jpg`, `design-qa-light.jpg`, and the final completed-run capture `design-qa-final-run.jpg`. The normalized source and final run capture were compared together; no further P0/P1/P2 issue was found.

## Primary interactions tested

- One Hub Admin Token login followed by direct Agent Market navigation; no Market-specific credential or second prompt.
- Real catalog load with two seeded Agents and two categories.
- Search filtering (`知识` reduced the list to 1 of 2 Agents).
- Advanced-search dry-run, graph status propagation and real trace/evaluation rendering.
- Prompt modification followed by a second run, with current-versus-previous input/output and metric comparison.
- Switching to Knowledge Q&A clears the previous Agent trace and exposes the non-runnable Catalog Only state.
- New Category and New Agent dialogs, labels, defaults and executor warning.
- Dark/light theme switching.
- Browser console after all interactions: 0 errors, 0 warnings.

## Follow-up polish

- P3: when persisted run ledgers and governed evaluation suites are implemented, the source's denser benchmark/timeline treatment can replace the current truthful empty states without changing the catalog or graph hierarchy.
- P3: a wider-browser capture can be added to the visual regression set to exercise the three-column Inspector layout directly.

final result: passed
