import { portraitState } from "./commerce-state.ts";
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
        state = portraitState(result);
      next[n] = {
        ...next[n],
        result,
        status: (
          {
            success: "成功",
            partial: "部分数据",
            no_data: "暂无数据",
            unknown: "待确认",
            error: "失败",
          } as Record<string, string>
        )[state],
      };
      halt =
        result.status === 401 ||
        result.status === 403 ||
        result.status === 429 ||
        state === "unknown";
    } catch (error) {
      next[n] = {
        ...next[n],
        status: "待确认",
        error: (error as Error).message,
      };
      halt = true;
    }
    onUpdate([...next]);
    if (halt) break;
  }
  return next;
}
