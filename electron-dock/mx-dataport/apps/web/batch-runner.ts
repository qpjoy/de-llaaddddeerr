import { portraitState, queryStatus } from "./commerce-state.ts";
export type BatchRow = {
  ip: string;
  intent: string;
  status: string;
  result?: any;
  error?: string;
};
/** A stop never cancels the accepted request. Only untouched rows may run on
 * a later explicit start; failed/unknown paid outcomes are never retried here. */
export async function runBatchRows(
  rows: BatchRow[],
  send: (row: BatchRow) => Promise<any>,
  shouldStop: () => boolean,
  onUpdate: (rows: BatchRow[]) => void,
) {
  const next = rows.map((row) => ({ ...row }));
  for (let n = 0; n < next.length; n++) {
    if (shouldStop()) break;
    if (next[n].status !== "待查询") continue;
    next[n] = { ...next[n], status: "查询中" };
    onUpdate([...next]);
    let halt = false;
    try {
      const result = await send(next[n]),
        state = portraitState(result),
        presentation = queryStatus(result);
      next[n] = {
        ...next[n],
        result,
        status: presentation.label,
        error: presentation.description || undefined,
      };
      halt =
        result.status === 401 ||
        result.status === 403 ||
        result.status === 429 ||
        presentation.kind === "rate_limited" ||
        presentation.kind === "duplicate_protected" ||
        state === "unknown";
    } catch (error) {
      const issue = error as Error & { code?: string; status?: number };
      const reason = queryStatus(issue);
      const presentation = ["rate_limited", "duplicate_protected"].includes(reason.kind)
        ? reason
        : queryStatus({ error: { code: "query_outcome_unknown" } });
      next[n] = {
        ...next[n],
        status: presentation.label,
        error: presentation.description || issue.message,
      };
      halt = true;
    }
    onUpdate([...next]);
    if (halt) break;
  }
  return next;
}
