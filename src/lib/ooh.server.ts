// Server-only Monday reads/writes for the OOH admin tools (Node runtime).
// Push lead = the manager override that issues the rep's NEXT not-issued lead;
// missing-reports = the read-only list of issued leads whose appointment has
// passed with no report. The automatic write-back lives in the edge fn; these
// back the UI.
import { monday } from "@/lib/monday.server";
import { laWallToUtcISO, laDateTimeLabel } from "@/lib/dates";
import {
  oohIsOpenLead,
  planNextLeadToIssue,
  type MissingReport,
  type OohNextLeadItem,
} from "@/lib/ooh";

const BLOCK_ISS_COL = "status";
const BLOCK_APPT_COL = "date9";
const BLOCK_REPS_COL = "people6";
// Disposition columns (status_1/_2/_3/4/9) — needed so a reported lead (which
// KEEPS its Iss label) is recognised as closed, not "missing".
const BLOCK_DISPO_COLS = {
  pm: "status_1",
  rs: "status_2",
  ol: "status_3",
  bo: "status4",
  sale: "status9",
} as const;
const READ_COLS = [
  BLOCK_ISS_COL,
  BLOCK_APPT_COL,
  BLOCK_REPS_COL,
  ...Object.values(BLOCK_DISPO_COLS),
];

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

/** Post a free-text Update (activity-feed note) on a block item WITHOUT
 *  touching any disposition column — backs the admin "Add note to card" rescue
 *  for reports the auto-writeback skipped (already dispositioned by office, a
 *  non-allow-listed board, …). Idempotent per key so a double-tap can't
 *  double-post. */
export async function postCardUpdate(
  token: string,
  itemId: string,
  body: string,
  idempotencyKey: string,
): Promise<void> {
  await monday(
    token,
    `mutation ($i:ID!,$b:String!) { create_update(item_id:$i, body:$b) { id } }`,
    { i: itemId, b: body },
    { idempotencyKey },
  );
}

type RawItem = {
  id: string;
  name: string;
  column_values: Array<{ id: string; text: string | null; value: string | null }>;
};

function apptMsOf(cv: RawItem["column_values"][number] | undefined): number | null {
  if (cv?.value) {
    try {
      const v = JSON.parse(cv.value) as { date?: string; time?: string | null };
      if (!v.date) return null;
      // Monday stores date columns in UTC in `value` — parse it as UTC directly
      // (treating the wall time as Pacific double-shifted the clock a day).
      const [y, mo, d] = v.date.split("-").map(Number);
      const [hh, mm] = (v.time ?? "00:00").split(":").map(Number);
      return Date.UTC(y, mo - 1, d, hh || 0, mm || 0);
    } catch {
      return null;
    }
  }
  // No value → `text` is already rendered in the account's timezone (Pacific).
  const m = (cv?.text ?? "").match(/(\d{4}-\d{2}-\d{2})(?:[ T](\d{2}:\d{2}))?/);
  if (!m) return null;
  const iso = laWallToUtcISO(`${m[1]}T${m[2] ?? "00:00"}`);
  return iso ? Date.parse(iso) : null;
}

function dispoLabelsOf(byId: Map<string, RawItem["column_values"][number]>) {
  const l = (id: string) => (byId.get(id)?.text ?? "").trim() || null;
  return {
    iss: l(BLOCK_ISS_COL),
    pm: l(BLOCK_DISPO_COLS.pm),
    rs: l(BLOCK_DISPO_COLS.rs),
    ol: l(BLOCK_DISPO_COLS.ol),
    bo: l(BLOCK_DISPO_COLS.bo),
    sale: l(BLOCK_DISPO_COLS.sale),
  };
}

function repsOf(byId: Map<string, RawItem["column_values"][number]>): string[] {
  return (byId.get(BLOCK_REPS_COL)?.text ?? "")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
}

/** Issued leads on one current block board whose appointment time has already
 *  passed and that are still OPEN (no disposition yet — a reported lead keeps
 *  its Iss label, so the Iss check alone counted reported leads as missing).
 *  Read-only. */
export async function fetchMissingReportsForBoard(
  token: string,
  boardId: string,
  office: "SD" | "OC",
  sinceMs: number | null,
  nowMs: number = Date.now(),
): Promise<MissingReport[]> {
  const data = await monday(
    token,
    `query ($b:ID!,$cols:[String!]) { boards(ids:[$b]) { items_page(limit:300) { items { id name created_at column_values(ids:$cols) { id text value } } } } }`,
    { b: boardId, cols: READ_COLS },
  );
  const boards =
    (data.boards as Array<{ items_page?: { items?: Array<RawItem & { created_at?: string }> } }>) ??
    [];
  const items = boards[0]?.items_page?.items ?? [];
  const out: MissingReport[] = [];
  for (const it of items) {
    const byId = new Map(it.column_values.map((c) => [c.id, c]));
    // Open = Iss with no disposition yet; anything else (reported, or never
    // issued) is not a missing report.
    if (!oohIsOpenLead(dispoLabelsOf(byId))) continue;
    const apptMs = apptMsOf(byId.get(BLOCK_APPT_COL));
    if (apptMs == null || apptMs > nowMs) continue; // appointment not yet passed
    // Only leads issued from go-live onward (never back-fill older leads).
    if (sinceMs != null && it.created_at && Date.parse(it.created_at) < sinceMs) continue;
    out.push({
      itemId: it.id,
      boardId,
      name: it.name,
      office,
      reps: repsOf(byId),
      apptLabel: byId.get(BLOCK_APPT_COL)?.text ? laDateTimeLabel(new Date(apptMs)) : null,
    });
  }
  return out;
}

/** The rep's NEXT not-issued lead on one block board, earliest appointment
 *  after `nowMs` (#12). Used by "Push lead" so it hands the rep their next
 *  lead instead of re-pressing Iss on the already-issued missing one. */
export async function fetchNextLeadForRep(
  token: string,
  boardId: string,
  repName: string,
  nowMs: number = Date.now(),
): Promise<{
  itemId: string;
  name: string;
  apptLabel: string | null;
  apptMs: number | null;
} | null> {
  const data = await monday(
    token,
    `query ($b:ID!,$cols:[String!]) { boards(ids:[$b]) { items_page(limit:300) { items { id name column_values(ids:$cols) { id text value } } } } }`,
    { b: boardId, cols: READ_COLS },
  );
  const boards = (data.boards as Array<{ items_page?: { items?: Array<RawItem> } }>) ?? [];
  const items = boards[0]?.items_page?.items ?? [];
  const candidates: OohNextLeadItem[] = items.map((it) => {
    const byId = new Map(it.column_values.map((c) => [c.id, c]));
    return {
      itemId: it.id,
      name: it.name,
      reps: repsOf(byId),
      iss: (byId.get(BLOCK_ISS_COL)?.text ?? "").trim() || null,
      apptMs: apptMsOf(byId.get(BLOCK_APPT_COL)),
    };
  });
  const next = planNextLeadToIssue(candidates, repName, nowMs);
  if (!next) return null;
  return {
    itemId: next.itemId,
    name: next.name,
    apptMs: next.apptMs,
    apptLabel: next.apptMs != null ? laDateTimeLabel(new Date(next.apptMs)) : null,
  };
}
