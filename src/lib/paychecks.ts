// Client-side batching for the pay-engine server fns — chunked under their
// 300-id input cap so a large roster can never fail whole. Unauthorized ids
// are silently dropped server-side, so results may be shorter than the input.
import {
  getWeeklyPaychecks,
  getMonthlyPaychecks,
  type PaycheckResult,
  type MonthlyPaycheckResult,
} from "@/lib/fleet.functions";

const CHUNK = 300;

/** Batched weekly paychecks. Default: a failed chunk throws (the caller's
 *  query lands in isError). "absorb" records the failure per id instead —
 *  each id in the failed chunk yields { canvasser_id, paycheck: null, error }
 *  and the remaining chunks still run. */
export async function fetchWeeklyPaychecksChunked(
  weekStart: string,
  canvasserIds: readonly string[],
  opts?: { onChunkError?: "throw" | "absorb" },
): Promise<PaycheckResult[]> {
  const out: PaycheckResult[] = [];
  for (let i = 0; i < canvasserIds.length; i += CHUNK) {
    const chunk = canvasserIds.slice(i, i + CHUNK);
    try {
      const { results } = await getWeeklyPaychecks({
        data: { week_start: weekStart, canvasser_ids: chunk },
      });
      out.push(...results);
    } catch (e) {
      if (opts?.onChunkError !== "absorb") throw e;
      const error = e instanceof Error ? e.message : String(e);
      out.push(...chunk.map((canvasser_id) => ({ canvasser_id, paycheck: null, error })));
    }
  }
  return out;
}

/** Batched monthly paychecks (volume bonus engine). A failed chunk throws. */
export async function fetchMonthlyPaychecksChunked(
  monthStart: string,
  canvasserIds: readonly string[],
): Promise<MonthlyPaycheckResult[]> {
  const out: MonthlyPaycheckResult[] = [];
  for (let i = 0; i < canvasserIds.length; i += CHUNK) {
    const { results } = await getMonthlyPaychecks({
      data: { month_start: monthStart, canvasser_ids: canvasserIds.slice(i, i + CHUNK) },
    });
    out.push(...results);
  }
  return out;
}
