// Server-only Monday reads/writes for the OOH admin tools (Node runtime).
// Push lead = the manager override that issues a lead now; missing-reports =
// the read-only list of issued leads whose appointment has passed with no
// report. The automatic write-back lives in the edge fn; these back the UI.
import { monday } from "@/lib/monday.server";
import { laWallToUtcISO, laDateTimeLabel } from "@/lib/dates";
import type { MissingReport } from "@/lib/ooh";

const BLOCK_ISS_COL = "status";
const BLOCK_APPT_COL = "date9";
const BLOCK_REPS_COL = "people6";

/** Press Iss on a block item (manager "Push lead" / release). Idempotent — the
 *  dispatcher treats an already-issued lead as released and never undoes it. */
export async function pushLeadIss(token: string, boardId: string, itemId: string): Promise<void> {
  await monday(
    token,
    `mutation ($b:ID!,$i:ID!,$vals:JSON!) { change_multiple_column_values(board_id:$b, item_id:$i, column_values:$vals) { id } }`,
    { b: boardId, i: itemId, vals: JSON.stringify({ [BLOCK_ISS_COL]: { label: "Iss" } }) },
    { idempotencyKey: `ooh-push-${itemId}` },
  );
}

type RawItem = {
  id: string;
  name: string;
  column_values: Array<{ id: string; text: string | null; value: string | null }>;
};

function apptMsOf(cv: RawItem["column_values"][number] | undefined): number | null {
  if (!cv?.value) {
    const m = (cv?.text ?? "").match(/(\d{4}-\d{2}-\d{2})(?:[ T](\d{2}:\d{2}))?/);
    if (!m) return null;
    const iso = laWallToUtcISO(`${m[1]}T${m[2] ?? "00:00"}`);
    return iso ? Date.parse(iso) : null;
  }
  try {
    const v = JSON.parse(cv.value) as { date?: string; time?: string | null };
    if (!v.date) return null;
    const iso = laWallToUtcISO(`${v.date}T${(v.time ?? "00:00").slice(0, 5)}`);
    return iso ? Date.parse(iso) : null;
  } catch {
    return null;
  }
}

/** Issued leads on one current block board whose appointment time has already
 *  passed and that still sit at "Iss" (i.e. no report came in). Read-only. */
export async function fetchMissingReportsForBoard(
  token: string,
  boardId: string,
  office: "SD" | "OC",
  sinceMs: number | null,
  nowMs: number = Date.now(),
): Promise<MissingReport[]> {
  const data = await monday(
    token,
    `query ($b:ID!) { boards(ids:[$b]) { items_page(limit:300) { items { id name created_at column_values(ids:["status","date9","people6"]) { id text value } } } } }`,
    { b: boardId },
  );
  const boards =
    (data.boards as Array<{ items_page?: { items?: Array<RawItem & { created_at?: string }> } }>) ??
    [];
  const items = boards[0]?.items_page?.items ?? [];
  const out: MissingReport[] = [];
  for (const it of items) {
    const byId = new Map(it.column_values.map((c) => [c.id, c]));
    const iss = (byId.get(BLOCK_ISS_COL)?.text ?? "").trim();
    if (iss !== "Iss") continue;
    const apptMs = apptMsOf(byId.get(BLOCK_APPT_COL));
    if (apptMs == null || apptMs > nowMs) continue; // appointment not yet passed
    // Only leads issued from go-live onward (never back-fill older leads).
    if (sinceMs != null && it.created_at && Date.parse(it.created_at) < sinceMs) continue;
    const reps = (byId.get(BLOCK_REPS_COL)?.text ?? "")
      .split(",")
      .map((s) => s.trim())
      .filter(Boolean);
    out.push({
      itemId: it.id,
      boardId,
      name: it.name,
      office,
      reps,
      apptLabel: byId.get(BLOCK_APPT_COL)?.text ? laDateTimeLabel(new Date(apptMs)) : null,
    });
  }
  return out;
}
