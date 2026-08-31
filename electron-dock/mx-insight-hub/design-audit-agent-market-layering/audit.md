# Agent Market graph / inspector layering audit

- Date: 2026-08-31
- Route: `http://127.0.0.1:5173/#/agent/market`
- Scope: graph canvas paint boundary versus the right stage inspector

## Evidence

- User reference: `/var/folders/n2/kk2sxv7103z_fj_mmyp2rllc0000gn/T/codex-clipboard-909dbac9-8fca-418e-9015-76e48523bbda.png`
- Verified responsive capture: [02-graph-boundary-after.png](02-graph-boundary-after.png)

## Finding and resolution

The graph's nodes, arrows and retry decoration created positioned descendants without a containing paint boundary. At a wide desktop layout they could paint across the grid column boundary and appear above the stage inspector.

The middle workbench now owns an isolated `z-index: 0` stacking context, the graph uses `contain: paint`, and both the expanded inspector and collapsed rail own an isolated `z-index: 2` layer. The inspector remains non-sticky and follows the document scroll behavior established by the earlier layout correction.

## Verification

| Check | Result |
| --- | --- |
| `.mih-market-main` | `position: relative; z-index: 0; isolation: isolate` |
| `.mih-market-flow` | `contain: paint`; computed overflow remains clipped |
| `.mih-market-inspector` | `z-index: 2; isolation: isolate` |
| Responsive rendering | Graph decoration is clipped at the workbench boundary |
| Source contract | Regression test asserts the three layer invariants |
| Focused tests / typecheck / build | Passed |

The in-app browser pane available for this verification was narrow, so the captured page used the stacked responsive layout. The original wide-screen failure mode is additionally guarded by the CSS stacking contract and its source regression test.
