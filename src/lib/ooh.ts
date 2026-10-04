// ═══════════════════════════════════════════════════════════════════════════
// OUT OF HOUSE (OOH) — app-side constants, types, and the rep "Report" deep-link
// builder. PURE (no React, no network) so the UI and the verify script share it.
// The disposition ENGINE lives in supabase/functions/monday-ooh-report/engine.ts
// (webhook-only); this file is just what the client needs. Owner brief 2026-10-03.
// ═══════════════════════════════════════════════════════════════════════════

export const OOH_FORM_BOARD_ID = "18433859050"; // "Out of House Reports"
/** The public form URL (fallback). The live value is read from
 *  system_settings.ooh_form_url via getOohConfig; this is just a sane default. */
export const OOH_FORM_URL =
  "https://forms.monday.com/forms/bf0baa57c8250e7cddf123349a65cfce?r=use1";

/** Monday WorkForms URL-prefill lookup keys (read live from the form's
 *  settings 2026-10-04 — these are the friendly `?key=` names, NOT column ids).
 *  Each field has prefill.enabled + source "queryParam" + these lookups. */
export const OOH_FORM_PREFILL_KEY = {
  rep: "rep", // "Your name"
  partner: "partner", // "Who ran this appointment with you?"
  customer: "customer", // name question "Customer name (as it shows on the block)"
  address: "address", // "Customer address"
  onBlock: "onblock", // "Was this appointment on today's block?"
  date: "date", // "Appointment date"
  lead: "lead", // "Lead ID (auto)"
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
 * Build the prefilled "Report" form link for a rep's lead. Uses the Monday
 * WorkForms URL-prefill lookup keys (verified live — the form has prefill
 * enabled per field). Falls back to OOH_FORM_URL when no form URL is passed, and
 * returns null only if even that is unusable — so the button can hide itself.
 * Verified in a real browser 2026-10-04: `?rep=Yakup Sancakli` prefilled the
 * "Your name" field.
 */
export function buildOohReportUrl(
  formUrl: string | null | undefined,
  params: {
    leadId?: string | null;
    repName?: string | null;
    partner?: string | null;
    customer?: string | null;
    address?: string | null;
    onBlockLabel?: string | null; // e.g. "Yes"
    apptDate?: string | null; // YYYY-MM-DD
  },
): string | null {
  let url: URL;
  try {
    url = new URL(formUrl || OOH_FORM_URL);
  } catch {
    return null;
  }
  const set = (key: string, v: string | null | undefined) => {
    if (v != null && v !== "") url.searchParams.set(key, v);
  };
  set(OOH_FORM_PREFILL_KEY.lead, params.leadId ?? undefined);
  set(OOH_FORM_PREFILL_KEY.rep, params.repName ?? undefined);
  set(OOH_FORM_PREFILL_KEY.partner, params.partner ?? undefined);
  set(OOH_FORM_PREFILL_KEY.customer, params.customer ?? undefined);
  set(OOH_FORM_PREFILL_KEY.address, params.address ?? undefined);
  set(OOH_FORM_PREFILL_KEY.onBlock, params.onBlockLabel ?? undefined);
  set(OOH_FORM_PREFILL_KEY.date, params.apptDate ?? undefined);
  return url.toString();
}

export function oohResultLabel(result: number | null | undefined): string {
  return result == null ? "—" : (OOH_RESULT_LABEL[result] ?? `Result ${result}`);
}
export function oohOnBlockLabel(onBlock: number | null | undefined): string {
  return onBlock == null ? "—" : (OOH_ON_BLOCK_LABEL[onBlock] ?? `#${onBlock}`);
}
