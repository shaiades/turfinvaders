// ═══════════════════════════════════════════════════════════════════════════
// NIGHTLY APPROVALS — Deno glue (owner mandate 2026-10-08 night, rules H/I/J).
// Pure decisions live in approvals.ts; this file does the Monday/Supabase IO:
//
//   · runBuildApprovals — build/refresh the FULL-BLOCK view of tomorrow on the
//     "Nightly Lineup – Approvals" board (one row per block item, SD + OC as
//     their own sections, sorted by time, "No change" where nothing is
//     proposed). Invoked by adminAction build_nightly_approvals. Writes ONLY
//     the approvals board — never a block item (rule H5).
//
//   · runApprovalsDecision — the Decision-column webhook
//     (?task=approvals). Approve applies the stored proposal ADD-ONLY after
//     re-reading the block item (rule H5 guard); Don't approve records the
//     rejection; the ⚡ APPROVE ALL control row applies every row still
//     Pending with a change (rule H4). Every outcome is audited (rule J10).
// ═══════════════════════════════════════════════════════════════════════════
import type { Supa } from "./supa.ts";
import { BLOCK_COL, BLOCK_DAY_GROUP, laDate, weekdayOfDate } from "./engine.ts";
import {
  type DispatchDayItem,
  createItem,
  createBoardGroup,
  fetchBlockItem,
  fetchDispatchDayItems,
  fetchGroupItems,
  fetchItemCols,
  fetchMondayUsers,
  fetchPeopleColumnIds,
  listBoardGroups,
  parsePeopleColumnValue,
  resolveUserId,
  resolveUserIdByFirstName,
  setColumns,
  setPeopleColumn,
} from "./monday.ts";
import {
  APPROVALS_BOARD_ID,
  APPROVALS_COL,
  APPROVALS_ISSUED,
  APPROVE_ALL_NAME,
  DECISION,
  NO_CHANGE_TEXT,
  type ApprovalsRowPlan,
  type ProposalInput,
  type ResetOrigin,
  applyGuard,
  applyWriteIds,
  approvalsGroupTitle,
  buildApprovalsRows,
  decisionKind,
  isControlRowName,
  selectApproveAllTargets,
  wouldRemoveRep,
} from "./approvals.ts";
import { logDispatchWrite } from "./history.ts";
import { acquireAll, recentlyTouched, releaseAll, sleep } from "./locks.ts";

const BLOCK_PULSE_URL = (boardId: string, itemId: string) =>
  `https://tidal-remodeling.monday.com/boards/${boardId}/pulses/${itemId}`;

function laClockNow(): string {
  return new Intl.DateTimeFormat("en-US", {
    timeZone: "America/Los_Angeles",
    hour: "numeric",
    minute: "2-digit",
  }).format(new Date());
}

// ── Builder ──────────────────────────────────────────────────────────────────
export type BuildApprovalsSummary = {
  ok: boolean;
  reason?: string;
  dateISO?: string;
  offices?: Record<string, { rows: number; changes: number; created: number; updated: number }>;
};

/**
 * Build (or refresh — idempotent by block item id) tomorrow's full-block view.
 * `proposals` is the nightly plan: add-only after sanitizing (rules I6–I9).
 */
export async function runBuildApprovals(
  supabase: Supa,
  opts: { dateISO?: string; proposals?: ProposalInput[] } = {},
): Promise<BuildApprovalsSummary> {
  const { data: settings } = await supabase.from("system_settings").select("*").maybeSingle();
  const token = ((settings?.monday_api_token as string | null) ?? "").trim();
  if (!token) return { ok: false, reason: "no Monday token" };

  const nowMs = Date.now();
  const dateISO = (opts.dateISO ?? "").trim() || laDate(nowMs + 24 * 3600_000);
  const groupId = BLOCK_DAY_GROUP[weekdayOfDate(dateISO, nowMs)];
  const proposals = opts.proposals ?? [];

  const offices: Array<{ office: "SD" | "OC"; boardId: string | null }> = [
    { office: "SD", boardId: (settings?.active_monday_board_sd as string | null) ?? null },
    { office: "OC", boardId: (settings?.active_monday_board_oc as string | null) ?? null },
  ];

  const boardGroups = await listBoardGroups(token, APPROVALS_BOARD_ID);
  const summary: BuildApprovalsSummary = { ok: true, dateISO, offices: {} };

  for (const { office, boardId } of offices) {
    if (!boardId) continue;
    const items = await fetchDispatchDayItems(token, boardId, groupId).catch(() => []);
    const resetOrigins = await lookupResetOrigins(supabase, items);
    const rows = buildApprovalsRows({ office, items, proposals, resetOrigins });

    // Find or create this office's section for the date.
    const title = approvalsGroupTitle(office, dateISO);
    let targetGroup = boardGroups.find((g) => g.title === title)?.id ?? null;
    if (!targetGroup) {
      targetGroup = await createBoardGroup(token, APPROVALS_BOARD_ID, title);
      if (targetGroup) boardGroups.push({ id: targetGroup, title });
    }
    if (!targetGroup) {
      summary.offices![office] = { rows: rows.length, changes: 0, created: 0, updated: 0 };
      continue;
    }

    // Existing rows in the section → upsert by block item id.
    const existing = await fetchGroupItems(token, APPROVALS_BOARD_ID, [targetGroup], [
      APPROVALS_COL.blockItem,
    ]).catch(() => []);
    const byBlockId = new Map(
      existing
        .filter((e) => !isControlRowName(e.name))
        .map((e) => [(e.cols[APPROVALS_COL.blockItem]?.text ?? "").trim(), e.id]),
    );
    const hasControlRow = existing.some((e) => isControlRowName(e.name));

    // One "Approve all" control row at the top of the section (rule H4).
    if (!hasControlRow) {
      await createItem(
        token,
        APPROVALS_BOARD_ID,
        targetGroup,
        `${APPROVE_ALL_NAME} (${office}) — set Decision → Approve`,
        {
          [APPROVALS_COL.office]: { label: office },
          [APPROVALS_COL.decision]: { label: DECISION.pending },
          [APPROVALS_COL.leadDate]: { date: dateISO },
          [APPROVALS_COL.why]: "Approves every row below still Pending with a change.",
        },
        `nightly-approvals-ctl-${dateISO}-${office}`,
      ).catch(() => null);
    }

    // Resolve proposal names → Monday user ids once per office.
    const users = await fetchMondayUsers(token).catch(() => [] as Array<{ id: string; name: string }>);
    const resolveIds = (names: string[]) =>
      names
        .map((n) => resolveUserId(users, n) ?? resolveUserIdByFirstName(users, n))
        .filter((id): id is string => !!id);

    let created = 0;
    let updated = 0;
    let changes = 0;
    for (const row of rows) {
      if (row.hasChange) changes++;
      const vals: Record<string, unknown> = {
        [APPROVALS_COL.leadDate]: { date: dateISO },
        [APPROVALS_COL.time]: row.timeText,
        [APPROVALS_COL.office]: { label: row.office },
        [APPROVALS_COL.areaProduct]: [row.cityText, row.productsText]
          .filter(Boolean)
          .join(" · "),
        [APPROVALS_COL.source]: row.sourceText,
        [APPROVALS_COL.currentReps]: row.currentRepNames.join(", ") || "—",
        [APPROVALS_COL.blockStatus]: row.blockStatusText,
        [APPROVALS_COL.leadNotes]: row.leadNotes,
        [APPROVALS_COL.flags]: row.flags,
        [APPROVALS_COL.why]: row.suggestion,
        [APPROVALS_COL.blockItem]: row.blockItemId,
        [APPROVALS_COL.openLead]: {
          url: BLOCK_PULSE_URL(row.blockBoardId, row.blockItemId),
          text: "Open lead",
        },
      };
      if (row.proposal) {
        const ids = resolveIds(row.proposal.addReps);
        if (ids.length > 0) {
          vals[APPROVALS_COL.suggestedRep] = {
            personsAndTeams: ids.map((id) => ({ id: Number(id), kind: "person" })),
          };
        }
      }

      const existingId = byBlockId.get(row.blockItemId);
      let approvalsItemId = existingId ?? null;
      if (existingId) {
        // Never reset a manager's Decision on refresh — informational cols only.
        await setColumns(token, APPROVALS_BOARD_ID, existingId, vals).catch(() => null);
        updated++;
      } else {
        approvalsItemId = await createItem(
          token,
          APPROVALS_BOARD_ID,
          targetGroup,
          row.name,
          { ...vals, [APPROVALS_COL.decision]: { label: DECISION.pending } },
          `nightly-approvals-${dateISO}-${row.blockItemId}`,
        ).catch(() => null);
        if (approvalsItemId) created++;
      }
      if (!approvalsItemId) continue;

      // Store / clear the proposal snapshot the apply path will guard against.
      if (row.hasChange && row.proposal) {
        await supabase.from("nightly_approvals").upsert(
          {
            approvals_item_id: approvalsItemId,
            block_item_id: row.blockItemId,
            block_board_id: row.blockBoardId,
            office: row.office,
            lead_date: dateISO,
            lead_name: row.name,
            snapshot_rep_names: row.snapshot.repNames,
            snapshot_statuses: {
              iss: row.snapshot.iss,
              pm: row.snapshot.pm,
              rs: row.snapshot.rs,
              ol: row.snapshot.ol,
              bo: row.snapshot.bo,
              sale: row.snapshot.sale,
            },
            proposed_add_names: row.proposal.addReps,
            reason: row.proposal.reason,
            state: "pending",
          },
          { onConflict: "approvals_item_id" },
        );
      } else {
        // A re-run downgraded this row to "No change" → retire a stale pending
        // proposal so Approve / Approve-all can no longer apply it.
        await supabase
          .from("nightly_approvals")
          .delete()
          .eq("approvals_item_id", approvalsItemId)
          .eq("state", "pending");
      }
    }
    summary.offices![office] = { rows: rows.length, changes, created, updated };
  }
  return summary;
}

/** Rule I7 lookup — who created each reset? Best-effort: the processed OOH
 *  report targeting the item (rep + partner), else the block_cards mirror by
 *  customer base name. Empty results are fine; resetOwners then falls back to
 *  people6 or (if that is empty too) proposes nothing. */
async function lookupResetOrigins(
  supabase: Supa,
  items: DispatchDayItem[],
): Promise<Record<string, ResetOrigin | null>> {
  const out: Record<string, ResetOrigin | null> = {};
  const resets = items.filter((i) => i.isReset && i.reps.length === 0);
  for (const item of resets) {
    let origin: ResetOrigin | null = null;
    try {
      const { data } = await supabase
        .from("ooh_report_queue")
        .select("rep_name, partner, result, created_at")
        .eq("target_item_id", item.itemId)
        .in("result", [2, 3]) // PM w/ Reset, Reset
        .order("created_at", { ascending: false })
        .limit(1);
      const row = (data as Array<{ rep_name: string | null; partner: string | null }>)?.[0];
      if (row?.rep_name) origin = { repName: row.rep_name, partner: row.partner };
    } catch {
      /* best-effort */
    }
    if (!origin) {
      try {
        const base = item.name
          .replace(/(\s*\(copy(\s+\d+)?\))+\s*$/i, "")
          .trim()
          .replace(/[\\%_]/g, (m) => `\\${m}`);
        if (base) {
          const { data } = await supabase
            .from("block_cards")
            .select("reps, board_id")
            .ilike("lead_name", `${base}%`)
            .limit(20);
          const reps = new Set<string>();
          for (const r of (data as Array<{ reps: string[] | null; board_id: string }>) ?? []) {
            if (r.board_id === item.boardId) continue; // the card being planned
            for (const n of r.reps ?? []) if (n?.trim()) reps.add(n.trim());
          }
          const arr = Array.from(reps);
          if (arr.length > 0) origin = { repName: arr[0], partner: arr[1] ?? null };
        }
      } catch {
        /* best-effort */
      }
    }
    out[item.itemId] = origin;
  }
  return out;
}

// ── Decision webhook ─────────────────────────────────────────────────────────
export type DecisionSummary = {
  handled: boolean;
  reason?: string;
  applied?: number;
  approved?: number;
  skipped?: number;
  rejected?: number;
};

type StoredProposal = {
  id: string;
  approvals_item_id: string;
  block_item_id: string;
  block_board_id: string;
  office: string | null;
  lead_date: string | null;
  lead_name: string | null;
  snapshot_rep_names: string[];
  snapshot_statuses: {
    iss: string | null;
    pm: string | null;
    rs: string | null;
    ol: string | null;
    bo: string | null;
    sale: string | null;
  } | null;
  proposed_add_names: string[];
  reason: string | null;
  state: string;
};

/** Rule M: mark a proposal APPROVED — the gap between a manager's night-time
 *  Approve and the 8:45 auto-issue block write. No block is touched here. */
async function markApproved(supabase: Supa, rowId: string, approver: string): Promise<void> {
  await supabase
    .from("nightly_approvals")
    .update({
      state: "approved",
      decided_by: approver,
      decided_at: new Date().toISOString(),
      result_note: "approved — queued for 8:45 auto-issue",
    })
    .eq("id", rowId);
}

/** Handle a Decision-column change on the approvals board. */
export async function runApprovalsDecision(
  supabase: Supa,
  event: { itemId: string; columnId: string | null; label: string | null; userId: string | null },
): Promise<DecisionSummary> {
  if (event.columnId && event.columnId !== APPROVALS_COL.decision) {
    return { handled: false, reason: "not the Decision column" };
  }
  const kind = decisionKind(event.label);
  if (kind === "pending" || kind === "unknown") return { handled: false, reason: "no-op label" };

  const { data: settings } = await supabase.from("system_settings").select("*").maybeSingle();
  const token = ((settings?.monday_api_token as string | null) ?? "").trim();
  if (!token) return { handled: false, reason: "no Monday token" };
  const mode = ((settings?.live_dispatch_mode as string | null) ?? "off") as
    | "off"
    | "dry_run"
    | "live";

  const row = await fetchItemCols(token, event.itemId, [
    APPROVALS_COL.blockItem,
    APPROVALS_COL.office,
    APPROVALS_COL.leadDate,
    APPROVALS_COL.changeTo,
    APPROVALS_COL.addRep,
    APPROVALS_COL.changeToPick,
    APPROVALS_COL.addRepPick,
  ]);
  if (!row || row.boardId !== APPROVALS_BOARD_ID) {
    return { handled: false, reason: "not an approvals row" };
  }

  const users = await fetchMondayUsers(token).catch(() => [] as Array<{ id: string; name: string }>);
  const approver =
    (event.userId && users.find((u) => u.id === String(event.userId))?.name) ||
    (event.userId ? `user ${event.userId}` : "unknown manager");
  const note = (text: string) =>
    setColumns(token, APPROVALS_BOARD_ID, row.id, {
      [APPROVALS_COL.note]: text.slice(0, 250),
    }).catch(() => null);

  // ── ⚡ APPROVE ALL (rule H4) ────────────────────────────────────────────────
  if (isControlRowName(row.name)) {
    if (kind !== "approve") {
      return { handled: false, reason: "control row: only Approve acts" };
    }
    const office = (row.cols[APPROVALS_COL.office]?.text ?? "").trim();
    const dateISO = (row.cols[APPROVALS_COL.leadDate]?.text ?? "").trim().slice(0, 10);
    const { data } = await supabase
      .from("nightly_approvals")
      .select("*")
      .eq("office", office)
      .eq("lead_date", dateISO)
      .eq("state", "pending");
    const targets = selectApproveAllTargets(
      ((data as StoredProposal[]) ?? []).map((p) => ({
        ...p,
        state: p.state as "pending",
        addNames: p.proposed_add_names ?? [],
      })),
    );
    // Rule M: Approve queues the rows; the 8:45 auto-issue job does the block
    // write (no longer applied here on the manager's press).
    let approved = 0;
    for (const t of targets) {
      await markApproved(supabase, t.id, approver);
      approved++;
    }
    await setColumns(token, APPROVALS_BOARD_ID, row.id, {
      [APPROVALS_COL.decision]: { label: DECISION.pending },
      [APPROVALS_COL.note]: `Approve all @ ${laClockNow()}: ${approved} queued for 8:45 auto-issue`,
    }).catch(() => null);
    return { handled: true, approved };
  }

  // ── Single row ──────────────────────────────────────────────────────────────
  const { data } = await supabase
    .from("nightly_approvals")
    .select("*")
    .eq("approvals_item_id", row.id)
    .order("created_at", { ascending: false })
    .limit(1);
  const stored = ((data as StoredProposal[]) ?? [])[0] ?? null;

  if (kind === "reject") {
    if (stored && stored.state === "pending") {
      await supabase
        .from("nightly_approvals")
        .update({
          state: "rejected",
          decided_by: approver,
          decided_at: new Date().toISOString(),
          result_note: "rejected by manager",
        })
        .eq("id", stored.id);
      // Rule J10 — rejected proposals are audited too (old = new: no write).
      await logDispatchWrite(supabase, {
        mode: mode === "live" ? "live" : "dry_run",
        trigger: "approvals",
        formItemId: null,
        boardId: stored.block_board_id,
        itemId: stored.block_item_id,
        leadName: stored.lead_name,
        columnId: BLOCK_COL.reps,
        columnLabel: "Reps",
        oldValue: stored.snapshot_rep_names.join(", "),
        newValue: stored.snapshot_rep_names.join(", "),
        reason: `proposal rejected (${(stored.proposed_add_names ?? []).join(", ")} not added): ${stored.reason ?? ""}`,
        actor: `approvals:${approver}`,
      });
      await note(`Rejected by ${approver} — nothing written`);
      return { handled: true, rejected: 1 };
    }
    await note("Nothing pending on this row");
    return { handled: true, rejected: 0 };
  }

  if (kind === "approve") {
    if (!stored || stored.state !== "pending") {
      await note(
        stored
          ? `Already ${stored.state} — nothing to approve`
          : `${NO_CHANGE_TEXT} — nothing to approve`,
      );
      return { handled: true, approved: 0 };
    }
    // Rule M: Approve only QUEUES the row (marks it approved); the 8:45
    // auto-issue job writes it to the block. Nothing on the block is touched here.
    await markApproved(supabase, stored.id, approver);
    await note(`Approved by ${approver} @ ${laClockNow()} — queued for 8:45 auto-issue`);
    return { handled: true, approved: 1 };
  }

  // Change / Add rep — a manager-directed ADD (always add-only, rule I8). The
  // reps come from the Change to / Add rep people columns or the (pick)
  // dropdowns; anything that would remove a rep simply cannot be expressed.
  const pickNames = [
    ...(row.cols[APPROVALS_COL.changeToPick]?.text ?? "").split(","),
    ...(row.cols[APPROVALS_COL.addRepPick]?.text ?? "").split(","),
  ]
    .map((s) => s.trim())
    .filter(Boolean);
  const peopleIds = [
    ...parsePeopleColumnValue(row.cols[APPROVALS_COL.changeTo]?.value ?? null),
    ...parsePeopleColumnValue(row.cols[APPROVALS_COL.addRep]?.value ?? null),
  ];
  const pickedIds = [
    ...peopleIds,
    ...pickNames
      .map((n) => resolveUserIdByFirstName(users, n) ?? resolveUserId(users, n))
      .filter((id): id is string => !!id),
  ];
  const blockItemId = (row.cols[APPROVALS_COL.blockItem]?.text ?? "").trim();
  if (!blockItemId || pickedIds.length === 0) {
    await note("Pick who to add (Change to / Add rep) first");
    return { handled: true, applied: 0 };
  }
  const applyRes = await applyAddIds({
    supabase,
    token,
    users,
    mode,
    approver,
    approvalsItemId: row.id,
    blockItemId,
    blockBoardId: stored?.block_board_id ?? null,
    addIds: pickedIds,
    reason: `manager ${kind === "change" ? "Change" : "Add rep"} on approvals board`,
    guard: null, // the manager is acting on the live state, not an old snapshot
  });
  return { handled: true, applied: applyRes === "applied" ? 1 : 0 };
}

export type AutoIssueSummary = {
  ran: boolean;
  reason?: string;
  applied: number;
  skipped: number;
  total: number;
};

/** Rule M — the 8:45 AM PT auto-issue. Reads every Nightly Approvals row still
 *  `approved` (approved the night before, not yet issued) and applies it to the
 *  live block via the same re-read-guarded, add-only, write-locked path the
 *  manual Approve used to take. Idempotent per row: approved→applied only after
 *  the block write lands, so a dead-mid-run job leaves the rest `approved` for
 *  the next run (or a manual ?task=auto-issue&force=true), and applied rows are
 *  never re-issued (rule M10). Writes still require live_dispatch_mode='live';
 *  otherwise the approved rows are left untouched (not consumed). */
export async function runNightlyAutoIssue(
  supabase: Supa,
  opts: { force?: boolean } = {},
): Promise<AutoIssueSummary> {
  const empty = (ran: boolean, reason: string): AutoIssueSummary => ({
    ran,
    reason,
    applied: 0,
    skipped: 0,
    total: 0,
  });
  const { data: settings } = await supabase.from("system_settings").select("*").maybeSingle();
  const enabled = settings?.nightly_auto_issue_enabled === true;
  if (!opts.force && !enabled) return empty(false, "nightly_auto_issue_enabled is off");
  const token = ((settings?.monday_api_token as string | null) ?? "").trim();
  if (!token) return empty(false, "no Monday token");
  const mode = ((settings?.live_dispatch_mode as string | null) ?? "off") as
    | "off"
    | "dry_run"
    | "live";
  // The block write is gated on live mode; when not live, leave approved rows
  // in place rather than consuming them (applyStoredProposal would mark them
  // skipped). Nothing auto-issues until an owner flips live_dispatch_mode.
  if (mode !== "live") return empty(false, `live_dispatch_mode=${mode} (not live)`);

  const { data } = await supabase
    .from("nightly_approvals")
    .select("*")
    .eq("state", "approved")
    .order("created_at", { ascending: true })
    .limit(500);
  const rows = (data as StoredProposal[]) ?? [];
  if (rows.length === 0) return { ran: true, reason: "no approved rows", applied: 0, skipped: 0, total: 0 };

  const users = await fetchMondayUsers(token).catch(
    () => [] as Array<{ id: string; name: string }>,
  );
  let applied = 0;
  let skipped = 0;
  for (const stored of rows) {
    const r = await applyStoredProposal({
      supabase,
      token,
      users,
      mode,
      approver: "auto-issue 8:45 (bot)",
      proposal: { ...stored, addNames: stored.proposed_add_names ?? [] },
    });
    if (r === "applied") applied++;
    else skipped++;
  }
  return { ran: true, applied, skipped, total: rows.length };
}

/** Apply ONE stored proposal: re-read, guard (rule H5), add-only write
 *  (rule I8), audit (rule J10), mark the board row. */
async function applyStoredProposal(p: {
  supabase: Supa;
  token: string;
  users: Array<{ id: string; name: string }>;
  mode: "off" | "dry_run" | "live";
  approver: string;
  proposal: StoredProposal & { addNames: string[] };
}): Promise<"applied" | "skipped"> {
  const { supabase, token, users, mode, approver, proposal } = p;
  const addIds = proposal.addNames
    .map((n) => resolveUserId(users, n) ?? resolveUserIdByFirstName(users, n))
    .filter((id): id is string => !!id);
  const res = await applyAddIds({
    supabase,
    token,
    users,
    mode,
    approver,
    approvalsItemId: proposal.approvals_item_id,
    blockItemId: proposal.block_item_id,
    blockBoardId: proposal.block_board_id,
    addIds,
    reason: proposal.reason || `nightly approval (${proposal.addNames.join(", ")})`,
    guard: {
      repNames: proposal.snapshot_rep_names ?? [],
      iss: proposal.snapshot_statuses?.iss ?? null,
      pm: proposal.snapshot_statuses?.pm ?? null,
      rs: proposal.snapshot_statuses?.rs ?? null,
      ol: proposal.snapshot_statuses?.ol ?? null,
      bo: proposal.snapshot_statuses?.bo ?? null,
      sale: proposal.snapshot_statuses?.sale ?? null,
    },
    proposalRowId: proposal.id,
  });
  return res;
}

/** The ONE write path to a block item from the approvals flow. people6 is
 *  always union(current, adds) — applyWriteIds — and a final wouldRemoveRep
 *  check refuses anything else (rules I6/I8). */
async function applyAddIds(p: {
  supabase: Supa;
  token: string;
  users: Array<{ id: string; name: string }>;
  mode: "off" | "dry_run" | "live";
  approver: string;
  approvalsItemId: string;
  blockItemId: string;
  blockBoardId: string | null;
  addIds: string[];
  reason: string;
  guard: ApprovalsRowPlan["snapshot"] | null;
  proposalRowId?: string;
}): Promise<"applied" | "skipped"> {
  const { supabase, token, mode, approver } = p;
  const note = (text: string, issued?: string) =>
    setColumns(token, APPROVALS_BOARD_ID, p.approvalsItemId, {
      [APPROVALS_COL.note]: text.slice(0, 250),
      ...(issued ? { [APPROVALS_COL.issued]: { label: issued } } : {}),
    }).catch(() => null);
  const markProposal = async (state: string, resultNote: string) => {
    if (!p.proposalRowId) return;
    await supabase
      .from("nightly_approvals")
      .update({
        state,
        decided_by: approver,
        decided_at: new Date().toISOString(),
        ...(state === "applied" ? { applied_at: new Date().toISOString() } : {}),
        result_note: resultNote,
      })
      .eq("id", p.proposalRowId);
  };

  if (p.addIds.length === 0) {
    await note("Could not resolve who to add — nothing written");
    await markProposal("skipped", "could not resolve add reps");
    return "skipped";
  }

  // Rule L: take the write lock before the re-read-and-write. Serialize against
  // a concurrent report-driven issue on the SAME lead (item:) or the SAME rep
  // elsewhere (rep:) — reps are already dispo-ing leftover leads when the 8:45
  // auto-issue runs. A conflict leaves the row's state UNTOUCHED (so a later run
  // retries) and reports Held, rather than marking it applied/skipped.
  const lockHolder = `approvals:${p.approvalsItemId}`;
  const lockKeys = [`item:${p.blockItemId}`, ...p.addIds.map((id) => `rep:${id}`)];
  const lock = await acquireAll(supabase, lockKeys, lockHolder);
  if (!lock.ok) {
    await note(
      `Held — write lock ${lock.blockedKey} held by another writer, will retry`,
      APPROVALS_ISSUED.held,
    );
    return "skipped";
  }
  try {
    // Rule L (15s): a mid-flight change by a second writer → wait, then re-read.
    if (p.blockBoardId && (await recentlyTouched(token, p.blockBoardId, p.blockItemId, 15)))
      await sleep(4000);

    // Rule H5 — re-read the block item RIGHT BEFORE the write.
    const block = await fetchBlockItem(token, p.blockItemId).catch(() => null);
    if (!block) {
      await note("Block item unreadable — nothing written", APPROVALS_ISSUED.skipped);
      await markProposal("skipped", "block item unreadable");
      return "skipped";
    }
    if (p.guard) {
      const g = applyGuard({
        snapshot: p.guard,
        current: {
          repNames: block.reps,
          iss: block.iss,
          pm: block.pm,
          rs: block.rs,
          ol: block.ol,
          bo: block.bo,
          sale: block.sale,
        },
      });
      if (!g.ok) {
        await note(g.note, APPROVALS_ISSUED.skipped);
        await markProposal("skipped", g.note);
        return "skipped";
      }
    }

    if (mode !== "live") {
      await note(`[${mode.toUpperCase()}] would add — live_dispatch_mode is not live`);
      await markProposal("skipped", `live_dispatch_mode=${mode}`);
      return "skipped";
    }

    const boardId = p.blockBoardId ?? block.boardId;
    const currentIds = await fetchPeopleColumnIds(token, p.blockItemId, BLOCK_COL.reps).catch(
      () => [] as string[],
    );
    const nextIds = applyWriteIds(currentIds, p.addIds);
    // Rules I6/I8 — the final gate: a write may NEVER remove a rep from people6.
    if (wouldRemoveRep(currentIds, nextIds)) {
      await note(
        "Refused: write would remove a rep (reps are add-only)",
        APPROVALS_ISSUED.skipped,
      );
      await markProposal("skipped", "would remove a rep — refused");
      return "skipped";
    }
    const idToName = new Map(p.users.map((u) => [u.id, u.name]));
    const oldNames = currentIds.map((id) => idToName.get(id) ?? id).join(", ");
    const newNames = nextIds.map((id) => idToName.get(id) ?? id).join(", ");

    const write = await setPeopleColumn(
      token,
      boardId,
      p.blockItemId,
      BLOCK_COL.reps,
      nextIds,
      `approvals-apply-${p.approvalsItemId}`,
    );
    if (write.error) {
      await note(`Write failed: ${write.error}`.slice(0, 200), APPROVALS_ISSUED.skipped);
      await markProposal("skipped", `write failed: ${write.error}`);
      return "skipped";
    }

    // Rule J10 — who approved, when, old and new values (rule-G audit table).
    await logDispatchWrite(supabase, {
      mode: "live",
      trigger: "approvals",
      formItemId: null,
      boardId,
      itemId: p.blockItemId,
      leadName: block.name,
      columnId: BLOCK_COL.reps,
      columnLabel: "Reps",
      oldValue: oldNames,
      newValue: newNames,
      reason: `approved by ${approver}: ${p.reason}`,
      actor: `approvals:${approver}`,
    });
    await note(
      `Applied by ${approver} @ ${laClockNow()} — Reps: ${newNames}`,
      APPROVALS_ISSUED.applied,
    );
    await markProposal("applied", `people6: ${oldNames || "nobody"} → ${newNames}`);
    return "applied";
  } finally {
    await releaseAll(supabase, lockKeys, lockHolder);
  }
}
