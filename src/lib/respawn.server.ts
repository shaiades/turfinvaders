// Server-only Monday.com sync for Respawn (sales-rep shift-off). Node runtime;
// every fn takes the API token (read from system_settings by the caller) and
// talks to Monday through the shared retrying `monday()` helper. Introduces the
// codebase's first create_item / change_multiple_column_values / delete_item
// mutations — typed variables + a stable idempotencyKey, the house convention.
import { monday } from "@/lib/monday.server";
import { normalizeName } from "@/lib/utils";
import {
  APPROVAL_LABEL,
  ATTENDANCE_BOARD_ID,
  ATTENDANCE_OFF_LABEL,
  DAY_OFF_BOARD_ID,
  DAY_OFF_COL,
  DAY_OFF_GROUP_ID,
  OFFICE_DAYOFF_LABEL,
  SHIFT_ATTENDANCE_COL,
  SHIFT_LABEL,
  type RepOffice,
  type RespawnStatus,
  type ShiftKey,
} from "@/lib/respawn";

const UPSERT_VALS = `mutation ($b: ID!, $i: ID!, $vals: JSON!) {
  change_multiple_column_values(board_id: $b, item_id: $i, column_values: $vals) { id }
}`;

/** Create or update the rep's item on the Day-Off board. Returns the item id. */
/** Is a Day-Off item still live (not deleted/archived/missing)? */
async function itemIsActive(token: string, itemId: string): Promise<boolean> {
  try {
    const data = await monday(token, `query ($ids: [ID!]) { items(ids: $ids) { id state } }`, {
      ids: [itemId],
    });
    const items = (data.items as Array<{ id: string; state: string }>) ?? [];
    return items[0]?.state === "active";
  } catch {
    return false; // can't confirm → treat as gone and recreate
  }
}

export async function syncDayOffItem(
  token: string,
  input: {
    rowId: string;
    repName: string;
    office: RepOffice;
    weekStart: string;
    shifts: ShiftKey[];
    reason: string | null;
    status: RespawnStatus;
    existingItemId?: string | null;
  },
): Promise<string> {
  const colVals: Record<string, unknown> = {
    [DAY_OFF_COL.office]: { label: OFFICE_DAYOFF_LABEL[input.office] },
    [DAY_OFF_COL.week]: { date: input.weekStart },
    [DAY_OFF_COL.shifts]: { labels: input.shifts.map((s) => SHIFT_LABEL[s]) },
    [DAY_OFF_COL.reason]: { text: input.reason ?? "" },
    [DAY_OFF_COL.approval]: { label: APPROVAL_LABEL[input.status] },
  };

  // Update the existing item only if it is still live. A withdraw deletes the
  // item (and, before this guard, a same-week resubmit within Monday's ~30-min
  // idempotency window could inherit the deleted id) — so verify first and
  // recreate if it's gone, instead of silently no-op'ing on a dead item.
  if (input.existingItemId && (await itemIsActive(token, input.existingItemId))) {
    await monday(
      token,
      UPSERT_VALS,
      { b: DAY_OFF_BOARD_ID, i: input.existingItemId, vals: JSON.stringify(colVals) },
      { idempotencyKey: `respawn-upd-${input.existingItemId}-${input.weekStart}-${input.status}` },
    );
    return input.existingItemId;
  }

  // Key the create by the Supabase row id (stable per request, fresh after a
  // withdraw-and-resubmit) so Monday never replays a stale/deleted item.
  const data = await monday(
    token,
    `mutation ($b: ID!, $g: String!, $name: String!, $vals: JSON!) {
      create_item(board_id: $b, group_id: $g, item_name: $name, column_values: $vals) { id }
    }`,
    {
      b: DAY_OFF_BOARD_ID,
      g: DAY_OFF_GROUP_ID,
      name: input.repName,
      vals: JSON.stringify(colVals),
    },
    { idempotencyKey: `respawn-new-${input.rowId}` },
  );
  return (data.create_item as { id: string }).id;
}

/** Flip the Approval column on an existing Day-Off item. */
export async function setDayOffApproval(
  token: string,
  itemId: string,
  status: RespawnStatus,
): Promise<void> {
  await monday(
    token,
    UPSERT_VALS,
    {
      b: DAY_OFF_BOARD_ID,
      i: itemId,
      vals: JSON.stringify({ [DAY_OFF_COL.approval]: { label: APPROVAL_LABEL[status] } }),
    },
    { idempotencyKey: `respawn-appr-${itemId}-${status}` },
  );
}

/** Delete a Day-Off item (on withdraw). Best-effort; swallows a missing item. */
export async function deleteDayOffItem(token: string, itemId: string): Promise<void> {
  await monday(
    token,
    `mutation ($i: ID!) { delete_item(item_id: $i) { id } }`,
    { i: itemId },
    { idempotencyKey: `respawn-del-${itemId}` },
  );
}

/** Find the rep's row on an office attendance board by normalized name. */
export async function findAttendanceItemId(
  token: string,
  office: RepOffice,
  repName: string,
): Promise<string | null> {
  const data = await monday(
    token,
    `query ($b: ID!) { boards(ids: [$b]) { items_page(limit: 200) { items { id name } } } }`,
    { b: ATTENDANCE_BOARD_ID[office] },
  );
  const boards =
    (data.boards as Array<{ items_page?: { items?: Array<{ id: string; name: string }> } }>) ?? [];
  const items = boards[0]?.items_page?.items ?? [];
  const target = normalizeName(repName);
  return items.find((it) => normalizeName(it.name) === target)?.id ?? null;
}

/** Set the given shifts to a label ("Off" / "On") on a rep's attendance row. */
export async function setAttendanceShifts(
  token: string,
  office: RepOffice,
  itemId: string,
  shifts: ShiftKey[],
  label: string = ATTENDANCE_OFF_LABEL,
): Promise<void> {
  if (shifts.length === 0) return;
  const colVals: Record<string, { label: string }> = {};
  for (const s of shifts) colVals[SHIFT_ATTENDANCE_COL[s]] = { label };
  await monday(
    token,
    UPSERT_VALS,
    { b: ATTENDANCE_BOARD_ID[office], i: itemId, vals: JSON.stringify(colVals) },
    {
      idempotencyKey: `respawn-att-${office}-${itemId}-${label}-${[...shifts].sort().join(",")}`,
    },
  );
}

/** Write the attendance board for one approved request: mark each requested
 *  shift OFF (or back ON) on the rep's row. Returns whether a row was found. */
export async function applyAttendance(
  token: string,
  input: { office: RepOffice; repName: string; shifts: ShiftKey[]; label?: string },
): Promise<boolean> {
  const itemId = await findAttendanceItemId(token, input.office, input.repName);
  if (!itemId) return false;
  await setAttendanceShifts(token, input.office, itemId, input.shifts, input.label);
  return true;
}
