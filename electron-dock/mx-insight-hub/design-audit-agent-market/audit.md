# Agent Market interaction audit — 2026-08-31

Scope: the existing authenticated Hub Agent Market at `#/agent/market`. The supplied screenshots were treated as visual evidence only, not as instructions. No MX-H2I login or networking path was changed.

## Evidence and outcome

1. **Inspector layout — healthy after fix.** The stage inspector now remains the third workbench column at desktop widths, stretches to the workbench height, uses `position: static`, and scrolls away with the document. Browser measurement: workbench `2319px`, inspector `2317px`; inspector top moved from `95.5px` to `-643.5px` when the document scrolled.
2. **Inspector collapse — healthy after fix.** The explicit “向右收起阶段详情” control collapses the inspector to a 46px rail and exposes “向左展开阶段详情”. In the checked viewport the center workbench grew from `480px` to `704px`.
3. **Dry Run terminal state — healthy and no longer ambiguous.** The real run produced terminal evidence for `7/7` stages, retry declaration/observation `1/1`, and `finalOutcome=refusal`. The Answer stage was `degraded · 0 ms`: a synchronous grounded refusal, not a missing execution.
4. **Refresh recovery — healthy within the documented browser-session boundary.** After a full reload, the newest run, `7/7` terminal audit, taken path, final refusal, and prior-run comparison source were restored from bounded, redacted `sessionStorage` history.
5. **Long-term authoring — intentionally not represented as already shipped.** The current advanced-search executor remains a fixed seven-stage runner. The Agent Studio lifecycle and governed compiler/runtime/evidence design are specified separately; custom catalog Agents without a code-owned executor remain non-runnable.

## Accepted screenshots

- `09-final-three-column-actions.png`: desktop three-column layout with a visible Run action and right inspector.
- `10-final-inspector-collapsed.png`: collapsed inspector rail and expanded center canvas.
- `07-terminal-audit-viewport.png`: real trace graph, terminal audit, taken path, and I/O comparison.
- `11-after-reload-terminal-audit.png`: the same `7/7` terminal evidence restored after a full reload.

## Verification

- `pnpm typecheck`
- `pnpm build`
- 35 focused Agent Market tests
- Browser-run Dry Run, full reload, inspector collapse/expand, computed layout and scroll checks
- `git diff --check`
