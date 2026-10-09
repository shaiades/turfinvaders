// ═══════════════════════════════════════════════════════════════════════════
// NIGHTLY APPROVALS — PURE logic (no network, no Deno/Node APIs) so the edge
// fn and the verify script share one source of truth. Owner mandate 2026-10-08
// night (sections H / I / J, rules 1–10):
//
//   H — the "Nightly Lineup – Approvals" Monday board (18433860636) shows the
//       WHOLE of tomorrow's block — one row per block item, SD and OC as their
//       own sections, sorted by time — not just the rows Claude wants to
//       change. Unchanged rows say "No change". Each changed row shows a
//       Current → Proposed diff with its reason and gets its own Approve /
//       Reject (the Decision status column). One "⚡ APPROVE ALL" control row
//       per section applies only the rows still Pending with a change.
//       NOTHING is written to a block item until a manager presses Approve,
//       and every apply re-reads the item first — if people6 or any status
//       changed since the proposal was made, the proposal is dropped with
//       "Changed by office, skipped".
//
//   I — resets stay with their rep. A reset (status_2 Reset, or a block item
//       made from a reset) belongs to the rep who set it: never propose
//       removing or replacing them — a second rep is proposed as an ADD. If
//       the original rep can't be determined (empty people6 and no creating
//       report), propose nothing for that row. ALL people6 changes are
//       add-only (same as rule A1), on this board and in live dispatch.
//
//   J — every approved or rejected proposal is written to the rule-G audit
//       (ooh_dispatch_writes): who decided, when, old and new values.
//
// Column ids were read live from board 18433860636 on 2026-10-08; the two
// text columns Current reps / Block status were added the same day.
// ═══════════════════════════════════════════════════════════════════════════
import { normName } from "./engine.ts";
import { wallClock12, type DispatchLead } from "./dispatch.ts";

/** Display-cased first name ("Jonathan Paz" → "Jonathan") — unlike dispatch's
 *  firstName(), which normalizes for matching. */
function displayFirst(name: string): string {
  return name.trim().split(/\s+/)[0] ?? name;
}

// ── Board + columns (read live 2026-10-08) ───────────────────────────────────
export const APPROVALS_BOARD_ID = "18433860636"; // "Nightly Lineup – Approvals"

export const APPROVALS_COL = {
  leadDate: "date_mm7t85gq", // "Lead date"
  time: "text_mm7t366b", // "Time"
  office: "color_mm7tfv2", // "Office": SD | OC
  decision: "color_mm7tn5ej", // "Decision": Pending|Approve|Don't approve|Change|Add rep
  areaProduct: "text_mm7tk4hj", // "Area / product"
  suggestedRep: "multiple_person_mm7tdbt0", // "Suggested rep" (the proposal, people)
  why: "long_text_mm7tkdf5", // "Why" — the Current → Proposed diff + reason
  changeTo: "multiple_person_mm7tk1ss", // "Change to" (manager override, people)
  note: "text_mm7t36b7", // "Note" — apply/skip/reject outcome
  blockItem: "text_mm7tjyb4", // "Block item" — the block item id this row mirrors
  addRep: "multiple_person_mm7vp7rn", // "Add rep" (manager override, people)
  leadNotes: "long_text_mm7vv5s4", // "Lead notes" — block Details (long_text3)
  flags: "text_mm7vtsbc", // "Flags" — reset / job walk / can-save / language
  source: "text_mm7vhfv1", // "Source" — block Source (text)
  openLead: "link_mm7v33s4", // "Open lead" — link to the block item
  issued: "color_mm7vdc79", // "Issued" status (apply outcome)
  changeToPick: "dropdown_mm7w28tr", // "Change to (pick)" — first-name dropdown
  addRepPick: "dropdown_mm7wqqr5", // "Add rep (pick)" — first-name dropdown
  currentReps: "text_mm7z68ny", // "Current reps" — people6 at proposal time (H2)
  blockStatus: "text_mm7z274e", // "Block status" — Iss + dispositions at proposal time (H2)
} as const;

/** Decision status labels, exactly as on the board (press by LABEL). */
export const DECISION = {
  pending: "Pending",
  approve: "Approve",
  reject: "Don't approve",
  change: "Change",
  addRep: "Add rep",
} as const;

/** Issued status labels used for apply outcomes. */
export const APPROVALS_ISSUED = {
  applied: "Assigned – not Iss", // people6 written; Iss stays with the live flow
  skipped: "Stuck", // guard tripped — changed by office / reset rule
  held: "Held",
} as const;

/** Row Note shown when the pre-write re-read finds the office got there first
 *  (rule H5). Exact owner wording. */
export const CHANGED_BY_OFFICE_NOTE = "Changed by office, skipped";

/** The one "Approve all" control row per section (rule H4). Detection is by
 *  this prefix so a renamed suffix still matches. */
export const APPROVE_ALL_NAME = "⚡ APPROVE ALL";
export function isControlRowName(name: string | null | undefined): boolean {
  return (name ?? "").trim().toUpperCase().startsWith("⚡ APPROVE ALL");
}

/** Section (group) title for one office's slice of tomorrow, e.g.
 *  "Fri 10/9 – SD full block". dateISO is the LA calendar date. */
export function approvalsGroupTitle(office: "SD" | "OC", dateISO: string): string {
  const [y, m, d] = dateISO.split("-").map(Number);
  const wd = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"][
    new Date(Date.UTC(y, (m ?? 1) - 1, d ?? 1, 12)).getUTCDay()
  ];
  return `${wd} ${m}/${d} – ${office} full block`;
}

// ── Inputs ───────────────────────────────────────────────────────────────────
/** One block item of tomorrow's day group, as the builder sees it. Extends the
 *  dispatch day item with the display texts rule H2 asks for. */
export type ApprovalsDayItem = DispatchLead & {
  pm: string | null;
  rs: string | null;
  ol: string | null;
  bo: string | null;
  sale: string | null;
  sourceText: string | null; // block Source (text)
  detailsText: string | null; // block Details (long_text3)
  addressText: string | null; // block Location rendered address
};

/** A proposal as handed to the builder. `proposedReps` may arrive
 *  replace-shaped ("Yakup → Jonathan"); sanitizeProposal converts it to the
 *  add-only form the owner mandates (rules I6/I8). */
export type ProposalInput = {
  blockItemId: string;
  /** Desired final reps (replace-shaped input — removals will be DROPPED). */
  proposedReps?: string[];
  /** Explicit adds (already add-only). */
  addReps?: string[];
  reason?: string;
};

/** The rep + partner of the dispo report that created a reset (rule I7),
 *  matched by the glue from ooh_report_queue. */
export type ResetOrigin = { repName: string | null; partner: string | null };

// ── Rule I: resets stay with their rep ───────────────────────────────────────
/**
 * Rule I7 — who does a reset belong to? The item's people6 first; else the rep
 * (+ partner) of the report that created the reset. null when neither says —
 * the builder then proposes NOTHING for that row.
 */
export function resetOwners(
  item: Pick<ApprovalsDayItem, "reps">,
  origin: ResetOrigin | null | undefined,
): string[] | null {
  if (item.reps.length > 0) return item.reps;
  const fromReport = [origin?.repName, origin?.partner]
    .filter((n): n is string => !!n && !!n.trim())
    .map((n) => n.trim());
  return fromReport.length > 0 ? fromReport : null;
}

/** A sanitized, add-only proposal for one row. null ⇒ the row shows
 *  "No change". */
export type SanitizedProposal = {
  addReps: string[];
  reason: string;
  /** Reps a replace-shaped input tried to remove — dropped, never written. */
  droppedRemovals: string[];
};

/**
 * Rules I6 / I8 — convert any proposal to ADD-ONLY. Removals and replacements
 * are dropped: the adds survive ("Add Jonathan"), the removals never reach the
 * board or Monday. A reset row with no determinable owner (rule I7) gets no
 * proposal at all. Rule I9 is exactly this function on Yakup's reset:
 * proposedReps ["Jonathan"] over current ["Yakup"] → addReps ["Jonathan"],
 * droppedRemovals ["Yakup"] — "Add Jonathan", never "replace".
 */
export function sanitizeProposal(
  item: Pick<ApprovalsDayItem, "reps" | "isReset">,
  proposal: ProposalInput | null | undefined,
  resetOrigin?: ResetOrigin | null,
): SanitizedProposal | null {
  if (!proposal) return null;
  // Rule I7: a reset whose original rep can't be determined → propose nothing.
  if (item.isReset && resetOwners(item, resetOrigin) === null) return null;
  const current = item.reps.map(normName);
  const has = (n: string) => current.includes(normName(n));
  const adds: string[] = [];
  for (const n of [...(proposal.addReps ?? []), ...(proposal.proposedReps ?? [])]) {
    const t = (n ?? "").trim();
    if (!t || has(t)) continue;
    if (!adds.some((a) => normName(a) === normName(t))) adds.push(t);
  }
  const proposed = (proposal.proposedReps ?? []).map(normName);
  const droppedRemovals =
    proposal.proposedReps && proposal.proposedReps.length > 0
      ? item.reps.filter((r) => !proposed.includes(normName(r)))
      : [];
  if (adds.length === 0) return null; // nothing left to do → "No change"
  return { addReps: adds, reason: (proposal.reason ?? "").trim(), droppedRemovals };
}

/**
 * Rule I8 / A1 — THE add-only write. The people6 ids written to Monday are
 * always the union of what is there and what is being added: a rep already on
 * an item can never be removed by this engine, on the approvals board or in
 * live dispatch.
 */
export function applyWriteIds(currentIds: string[], addIds: string[]): string[] {
  return Array.from(new Set([...currentIds, ...addIds]));
}

// ── Rule H: the full-block view ──────────────────────────────────────────────
/** "Block status" cell: the Iss label plus any set dispositions, e.g.
 *  "Not Issued · Reset". */
export function blockStatusText(
  item: Pick<ApprovalsDayItem, "issLabel" | "pm" | "rs" | "ol" | "bo" | "sale">,
): string {
  const parts = [item.issLabel, item.sale, item.rs, item.pm, item.bo, item.ol]
    .map((t) => (t ?? "").trim())
    .filter((t) => t && t.toLowerCase() !== "none");
  return parts.length > 0 ? Array.from(new Set(parts)).join(" · ") : "—";
}

/** City from a rendered address ("6345 Southern Rd, La Mesa, CA 91942, USA" →
 *  "La Mesa"). Falls back to the whole address, then "—". */
export function cityFromAddress(address: string | null | undefined): string {
  const parts = (address ?? "")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
  if (parts.length >= 3) {
    // Walk back past "USA" and the state/zip part to the city.
    let i = parts.length - 1;
    if (/^(usa|united states)$/i.test(parts[i] ?? "")) i--;
    if (/^[A-Z]{2}(\s+\d{5})?$/.test(parts[i] ?? "")) i--;
    if (i >= 1) return parts[i];
  }
  return parts.length > 0 ? parts.join(", ") : "—";
}

/** Flags cell: the marker summary a manager scans (reset / job walk / …). */
export function flagsText(
  item: Pick<
    ApprovalsDayItem,
    "isReset" | "isJobWalk" | "isCanSave" | "isRehash" | "requestedLanguage"
  >,
): string {
  const f: string[] = [];
  if (item.isReset) f.push("Reset");
  if (item.isJobWalk) f.push("Job walk");
  if (item.isCanSave) f.push("Can-save");
  if (item.isRehash) f.push("Rehash");
  if (item.requestedLanguage) f.push(`Language: ${item.requestedLanguage}`);
  return f.join(" · ");
}

export const NO_CHANGE_TEXT = "No change";

/**
 * Rule H4 — the proposal cell. A changed row shows the diff with its reason:
 *   "Add Jonathan — Yakup needs a partner (Current: Yakup → Proposed:
 *    Yakup + Jonathan)"
 * An unchanged row shows exactly "No change" (rule H3). A dropped replace
 * says so, so the manager can see what was asked and refused.
 */
export function suggestionText(
  currentReps: string[],
  proposal: SanitizedProposal | null,
): string {
  if (!proposal) return NO_CHANGE_TEXT;
  const current = currentReps.length > 0 ? currentReps.join(" + ") : "nobody";
  const proposed = [...currentReps, ...proposal.addReps].join(" + ");
  const adds = `Add ${proposal.addReps.map(displayFirst).join(" + ")}`;
  const why = proposal.reason ? ` — ${proposal.reason}` : "";
  const diff = ` (Current: ${current} → Proposed: ${proposed})`;
  const dropped =
    proposal.droppedRemovals.length > 0
      ? ` [asked to remove ${proposal.droppedRemovals
          .map(displayFirst)
          .join(" + ")} — dropped: reps are add-only]`
      : "";
  return `${adds}${why}${diff}${dropped}`;
}

/** One planned approvals-board row. People columns carry NAMES here — the
 *  glue resolves them to Monday user ids at write time. */
export type ApprovalsRowPlan = {
  blockItemId: string;
  blockBoardId: string;
  office: "SD" | "OC";
  name: string; // customer name
  timeText: string; // wall-clock, e.g. "5:30 PM"
  apptWallMinutes: number | null; // sort key
  cityText: string;
  productsText: string;
  sourceText: string;
  blockStatusText: string;
  currentRepNames: string[];
  leadNotes: string;
  flags: string;
  suggestion: string; // the Why cell (diff + reason, or "No change")
  proposal: SanitizedProposal | null;
  hasChange: boolean;
  /** Snapshot for the rule-H5 pre-write guard. */
  snapshot: {
    repNames: string[];
    iss: string | null;
    pm: string | null;
    rs: string | null;
    ol: string | null;
    bo: string | null;
    sale: string | null;
  };
};

/**
 * Rules H1–H3 — build the full-block rows for ONE office: one row per block
 * item in tomorrow's group (every item, not only the changed ones), sorted by
 * time (unknown times last, then by name so the order is stable).
 */
export function buildApprovalsRows(input: {
  office: "SD" | "OC";
  items: ApprovalsDayItem[];
  proposals: ProposalInput[];
  resetOrigins?: Record<string, ResetOrigin | null>;
}): ApprovalsRowPlan[] {
  const byItem = new Map(input.proposals.map((p) => [String(p.blockItemId), p]));
  const rows = input.items.map((item) => {
    const proposal = sanitizeProposal(
      item,
      byItem.get(item.itemId) ?? null,
      input.resetOrigins?.[item.itemId] ?? null,
    );
    return {
      blockItemId: item.itemId,
      blockBoardId: item.boardId,
      office: input.office,
      name: item.name,
      timeText: wallClock12(item.apptWallMinutes),
      apptWallMinutes: item.apptWallMinutes,
      cityText: cityFromAddress(item.addressText),
      productsText: item.products.join(", "),
      sourceText: (item.sourceText ?? "").trim() || "—",
      blockStatusText: blockStatusText(item),
      currentRepNames: item.reps,
      leadNotes: (item.detailsText ?? "").trim(),
      flags: flagsText(item),
      suggestion: suggestionText(item.reps, proposal),
      proposal,
      hasChange: proposal !== null,
      snapshot: {
        repNames: item.reps,
        iss: item.issLabel,
        pm: item.pm,
        rs: item.rs,
        ol: item.ol,
        bo: item.bo,
        sale: item.sale,
      },
    } satisfies ApprovalsRowPlan;
  });
  return rows.sort((a, b) => {
    const ta = a.apptWallMinutes ?? Number.MAX_SAFE_INTEGER;
    const tb = b.apptWallMinutes ?? Number.MAX_SAFE_INTEGER;
    return ta !== tb ? ta - tb : a.name.localeCompare(b.name);
  });
}

// ── Rule H4: Approve all ─────────────────────────────────────────────────────
/** A stored proposal's lifecycle state (public.nightly_approvals.state). */
export type ApprovalState = "pending" | "applied" | "skipped" | "rejected";

/**
 * Rule H4 — "Approve all" applies ONLY the rows still showing a pending
 * change: a stored proposal in state 'pending' with at least one add. Rows
 * with no change, already applied/skipped, or rejected are never touched.
 */
export function selectApproveAllTargets<
  T extends { state: ApprovalState; addNames: string[] },
>(rows: T[]): T[] {
  return rows.filter((r) => r.state === "pending" && r.addNames.length > 0);
}

// ── Rule H5: the pre-write guard ─────────────────────────────────────────────
export type ApplyGuardResult = { ok: true } | { ok: false; note: string };

/**
 * Rule H5 — right before an approved write, the block item is RE-READ and
 * compared to the snapshot taken when the proposal was made. If people6 or any
 * status column changed in between, the office got there first: drop the
 * proposal and show "Changed by office, skipped". Name comparison is
 * normalized and order-free.
 */
export function applyGuard(input: {
  snapshot: ApprovalsRowPlan["snapshot"];
  current: {
    repNames: string[];
    iss: string | null;
    pm: string | null;
    rs: string | null;
    ol: string | null;
    bo: string | null;
    sale: string | null;
  };
}): ApplyGuardResult {
  const nameSet = (names: string[]) => [...new Set(names.map(normName))].sort().join("|");
  if (nameSet(input.snapshot.repNames) !== nameSet(input.current.repNames)) {
    return { ok: false, note: CHANGED_BY_OFFICE_NOTE };
  }
  const label = (t: string | null) => {
    const v = (t ?? "").trim().toLowerCase();
    return v === "none" ? "" : v;
  };
  const cols: Array<keyof ApprovalsRowPlan["snapshot"]> = ["iss", "pm", "rs", "ol", "bo", "sale"];
  for (const c of cols) {
    if (label(input.snapshot[c] as string | null) !== label(input.current[c] as string | null)) {
      return { ok: false, note: CHANGED_BY_OFFICE_NOTE };
    }
  }
  return { ok: true };
}

/** Rule I6 at APPLY time (belt and braces): refuse any write whose final rep
 *  set drops someone who is currently on the item. With applyWriteIds this can
 *  only trip on a hand-crafted write — but the rule is owner-permanent, so it
 *  is enforced at the last gate too. */
export function wouldRemoveRep(currentIds: string[], nextIds: string[]): boolean {
  const next = new Set(nextIds);
  return currentIds.some((id) => !next.has(id));
}

// ── Decisions (webhook side) ─────────────────────────────────────────────────
export type DecisionKind = "approve" | "reject" | "change" | "add_rep" | "pending" | "unknown";

/** Map a Decision status label to what the apply engine should do. */
export function decisionKind(label: string | null | undefined): DecisionKind {
  const t = (label ?? "").trim().toLowerCase();
  if (t === DECISION.approve.toLowerCase()) return "approve";
  if (t === DECISION.reject.toLowerCase()) return "reject";
  if (t === DECISION.change.toLowerCase()) return "change";
  if (t === DECISION.addRep.toLowerCase()) return "add_rep";
  if (t === DECISION.pending.toLowerCase() || t === "") return "pending";
  return "unknown";
}
