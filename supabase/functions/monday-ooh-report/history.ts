// ═══════════════════════════════════════════════════════════════════════════
// LIVE DISPATCH — history + decision logging (Deno edge runtime). Reads the
// existing Supabase mirrors instead of hammering Monday cross-board:
//   · public.block_cards     — every Block-board card (customer + reps), the
//     "prior SD/OC block boards" the owner brief points at;
//   · public.production_jobs  — the Production board (homeowner + people5).
// From these we learn who already RAN or SOLD a customer, so a rehash/can-save
// is never handed back to them and a job walk goes to its original rep.
//
// Also writes every issue decision to public.ooh_dispatch_decisions (rep, lead,
// score, reason, mode, issued) so Shai can review and Claude can learn.
// ═══════════════════════════════════════════════════════════════════════════
import { normName } from "./engine.ts";
import type { DispatchDayItem } from "./monday.ts";
import type { Supa } from "./supa.ts";

/** Strip Monday "(copy)" markers and normalize for a name match. */
function baseName(name: string): string {
  return name
    .replace(/(\s*\(copy(\s+\d+)?\))+\s*$/i, "")
    .trim()
    .toLowerCase();
}

/** Escape a string for a Postgres ILIKE prefix match. */
function escapeLike(s: string): string {
  return s.replace(/[\\%_]/g, (m) => `\\${m}`);
}

/**
 * Enrich the flagged leads (rehash / can-save / job walk) with the reps who
 * already handled that customer: `excludedReps` for rehash/can-save (never back
 * to them), `jobWalkReps` for a job walk (its original sales rep(s)). Mutates the
 * leads in place. Best-effort: a query failure leaves the arrays empty (the
 * hard rules then can only under-restrict, which the office catches).
 */
export async function enrichHistory(supabase: Supa, leads: DispatchDayItem[]): Promise<void> {
  const flagged = leads.filter((l) => l.isRehash || l.isCanSave || l.isJobWalk);
  if (flagged.length === 0) return;

  for (const lead of flagged) {
    const base = baseName(lead.name);
    if (!base) continue;
    const priorReps = new Set<string>();
    try {
      const { data: bc } = await supabase
        .from("block_cards")
        .select("reps, board_id")
        .ilike("lead_name", `${escapeLike(base)}%`)
        .limit(50);
      for (const row of (bc as Array<{ reps: string[] | null; board_id: string }> | null) ?? []) {
        // A card on the SAME board/day is the one we're about to assign — skip
        // it; prior reps come from other boards/days.
        if (row.board_id === lead.boardId) continue;
        for (const r of row.reps ?? []) if (r?.trim()) priorReps.add(normName(r));
      }
    } catch {
      /* best-effort */
    }
    try {
      const { data: pj } = await supabase
        .from("production_jobs")
        .select("reps")
        .ilike("homeowner_name", `${escapeLike(base)}%`)
        .limit(50);
      for (const row of (pj as Array<{ reps: string[] | null }> | null) ?? []) {
        for (const r of row.reps ?? []) if (r?.trim()) priorReps.add(normName(r));
      }
    } catch {
      /* best-effort */
    }
    const reps = Array.from(priorReps);
    if (lead.isRehash || lead.isCanSave) lead.excludedReps = reps;
    if (lead.isJobWalk) lead.jobWalkReps = reps;
  }
}

export type DispatchDecision = {
  mode: "dry_run" | "live";
  trigger: "report" | "watchdog";
  formItemId: string | null;
  repName: string | null;
  office: "SD" | "OC" | null;
  boardId: string | null;
  leadItemId: string | null;
  leadName: string | null;
  action: "issue" | "manager" | "none" | "alert";
  score: number | null;
  driveMinutes: number | null;
  strength: number | null;
  reason: string;
  issued: boolean;
  candidates?: unknown;
};

/** One people6 / status write, for the Rule 21 audit (item, old → new, reason,
 *  time). Logged around EVERY such write the dispatcher makes. */
export type DispatchWrite = {
  mode: "dry_run" | "live";
  trigger: "report" | "watchdog" | "late_cover" | "approvals";
  formItemId: string | null;
  boardId: string | null;
  itemId: string;
  leadName: string | null;
  columnId: string;
  columnLabel: string | null;
  oldValue: string | null;
  newValue: string | null;
  reason: string;
  /** Who made the decision (rule J10) — 'dispatch' when absent. For an
   *  approvals-board decision this is the approving manager, e.g.
   *  "approvals:Tyler Ward". */
  actor?: string;
};

/** Append one people6 / status write to the audit table (Rule 21). Best-effort —
 *  an audit hiccup must never undo the write it is recording. */
export async function logDispatchWrite(supabase: Supa, w: DispatchWrite): Promise<void> {
  try {
    await supabase.from("ooh_dispatch_writes").insert({
      mode: w.mode,
      trigger: w.trigger,
      form_item_id: w.formItemId,
      board_id: w.boardId,
      item_id: w.itemId,
      lead_name: w.leadName,
      column_id: w.columnId,
      column_label: w.columnLabel,
      old_value: w.oldValue,
      new_value: w.newValue,
      reason: w.reason,
      actor: w.actor ?? "dispatch",
    });
  } catch (e) {
    console.error("[ooh dispatch write-audit]", e instanceof Error ? e.message : String(e));
  }
}

/** Append one dispatch decision to the audit table. Best-effort. */
export async function logDispatchDecision(supabase: Supa, d: DispatchDecision): Promise<void> {
  try {
    await supabase.from("ooh_dispatch_decisions").insert({
      mode: d.mode,
      trigger: d.trigger,
      form_item_id: d.formItemId,
      rep_name: d.repName,
      office: d.office,
      board_id: d.boardId,
      lead_item_id: d.leadItemId,
      lead_name: d.leadName,
      action: d.action,
      score: d.score,
      drive_minutes: d.driveMinutes,
      strength: d.strength,
      reason: d.reason,
      issued: d.issued,
      candidates: d.candidates ?? null,
    });
  } catch (e) {
    console.error("[ooh dispatch log]", e instanceof Error ? e.message : String(e));
  }
}
