// ═══════════════════════════════════════════════════════════════════════════
// OUT OF HOUSE (OOH) — app-side constants, types, and the rep "Report" deep-link
// builder. PURE (no React, no network) so the UI and the verify script share it.
// The disposition ENGINE lives in supabase/functions/monday-ooh-report/engine.ts
// (webhook-only); this file is just what the client needs. Owner brief 2026-10-03.
// ═══════════════════════════════════════════════════════════════════════════

export const OOH_FORM_BOARD_ID = "18433859050"; // "Out of House Reports"

/** Form column ids used to prefill the "Report" deep-link (verified live). */
export const OOH_FORM_PREFILL_COL = {
  repName: "single_selectct0w80q", // "Your name"
  partner: "single_selectmrnw9q8", // "Who ran this appointment with you?"
  address: "short_textcdqow6xq", // "Customer address"
  onBlock: "single_selectg8mobdl", // "Was this appointment on today's block?"
  leadId: "short_texttlxjsw57", // "Lead ID (auto)"
} as const;

/** Form Result (single_selectorxwgbu) index → short label (for the admin queue). */
export const OOH_RESULT_LABEL: Record<number, string> = {
  0: "Sold",
  1: "Pitch miss",
  2: "PM w/ reset",
  3: "Reset",
  4: "One-legger",
  5: "No demo",
  6: "No show (final)",
  7: "At the door",
};

/** Form "On today's block?" (single_selectg8mobdl) index → short label. */
export const OOH_ON_BLOCK_LABEL: Record<number, string> = {
  0: "On block",
  1: "Upsell",
  2: "Self-gen",
  3: "Reload",
};

export type OohQueueStatus =
  "dry_run" | "needs_review" | "error" | "processed" | "dismissed" | "disabled";

export type OohQueueRow = {
  id: string;
  form_item_id: string;
  rep_name: string | null;
  partner: string | null;
  office: string | null;
  result: number | null;
  on_block: number | null;
  lead_id: string | null;
  target_item_id: string | null;
  board_id: string | null;
  status: OohQueueStatus;
  reason: string | null;
  details_line: string | null;
  plan: unknown;
  raw: unknown;
  error: string | null;
  decided_by: string | null;
  decided_at: string | null;
  created_at: string;
  updated_at: string;
};

export type MissingReport = {
  itemId: string;
  boardId: string;
  name: string;
  office: "SD" | "OC";
  reps: string[];
  apptLabel: string | null;
};

export type OohConfig = {
  mode: "off" | "dry_run" | "live";
  formUrl: string | null;
  autocreate: boolean;
};

/**
 * Build the prefilled "Report" form link for a rep's lead. Appends Monday form
 * prefill params keyed by column id (requires "allow prefilled values via URL"
 * on the form — see the PR "Decisions for Shai"). Returns null without a base
 * form URL so the button can hide itself.
 */
export function buildOohReportUrl(
  formUrl: string | null | undefined,
  params: {
    leadId?: string | null;
    repName?: string | null;
    partner?: string | null;
    address?: string | null;
    onBlockLabel?: string | null; // e.g. "Yes"
  },
): string | null {
  if (!formUrl) return null;
  let url: URL;
  try {
    url = new URL(formUrl);
  } catch {
    return null;
  }
  const set = (col: string, v: string | null | undefined) => {
    if (v != null && v !== "") url.searchParams.set(col, v);
  };
  set(OOH_FORM_PREFILL_COL.leadId, params.leadId ?? undefined);
  set(OOH_FORM_PREFILL_COL.repName, params.repName ?? undefined);
  set(OOH_FORM_PREFILL_COL.partner, params.partner ?? undefined);
  set(OOH_FORM_PREFILL_COL.address, params.address ?? undefined);
  set(OOH_FORM_PREFILL_COL.onBlock, params.onBlockLabel ?? undefined);
  return url.toString();
}

export function oohResultLabel(result: number | null | undefined): string {
  return result == null ? "—" : (OOH_RESULT_LABEL[result] ?? `Result ${result}`);
}
export function oohOnBlockLabel(onBlock: number | null | undefined): string {
  return onBlock == null ? "—" : (OOH_ON_BLOCK_LABEL[onBlock] ?? `#${onBlock}`);
}
