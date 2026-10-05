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

// ═══════════════════════════════════════════════════════════════════════════
// Open-lead rule (app side). MIRRORS isOpenLead / hasExistingDisposition in
// supabase/functions/monday-ooh-report/engine.ts — the edge fn can't be imported
// here (Deno/URL imports) so the rule is duplicated, with the same exact text,
// and both copies are asserted in scripts/verify-ooh-writeback.ts.
// ═══════════════════════════════════════════════════════════════════════════

/** The disposition column labels on a block card (everything except Iss). */
export type OohDispositionLabels = {
  pm: string | null; // status_1
  rs: string | null; // status_2
  ol: string | null; // status_3
  bo: string | null; // status4
  sale: string | null; // status9
};

const OOH_ISS = "Iss";
const OOH_NOT_ISSUED = "Not Issued";
const OOH_NO_SHOW_TEXT = "No show text";

/** Blank = empty or Monday's explicit "None". */
export function oohIsBlankStatus(label: string | null | undefined): boolean {
  const t = (label ?? "").trim();
  return t === "" || t.toLowerCase() === "none";
}

/** A disposition is already set (lead no longer open). The at-the-door
 *  "No show text" marker is the ONE exception — it holds the lead open. */
export function oohHasDisposition(d: OohDispositionLabels): boolean {
  if (
    !oohIsBlankStatus(d.pm) ||
    !oohIsBlankStatus(d.rs) ||
    !oohIsBlankStatus(d.ol) ||
    !oohIsBlankStatus(d.sale)
  )
    return true;
  if (!oohIsBlankStatus(d.bo) && (d.bo ?? "").trim() !== OOH_NO_SHOW_TEXT) return true;
  return false;
}

/** Rule 7 "open lead": Iss pressed AND no disposition yet (No show text aside).
 *  A reported lead keeps its Iss label, so this — not `iss === "Iss"` — is what
 *  tells a missing-report scan that the lead is still outstanding (#5). */
export function oohIsOpenLead(d: OohDispositionLabels & { iss: string | null }): boolean {
  if ((d.iss ?? "").trim() !== OOH_ISS) return false;
  return !oohHasDisposition(d);
}

/** Normalize a rep name for matching (lowercase, collapse whitespace). */
export function oohNormName(n: string | null | undefined): string {
  return (n ?? "").toLowerCase().replace(/\s+/g, " ").trim();
}

/**
 * The rep "My Leads" visibility rule (#11): show a lead only when it is issued
 * (Iss) or an Office Appt, OR already reported today (any disposition). Never
 * surface a Not-Issued lead — that breaks one-lead-at-a-time and would leak the
 * address of a lead the rep hasn't been given yet.
 */
export function isMyLeadVisible(c: OohDispositionLabels & { iss: string | null }): boolean {
  const iss = (c.iss ?? "").trim();
  const reported = oohHasDisposition(c) || (c.bo ?? "").trim() === OOH_NO_SHOW_TEXT;
  return reported || iss === OOH_ISS || /^office appt/i.test(iss);
}

/** A block item as the "push next lead" planner needs it. */
export type OohNextLeadItem = {
  itemId: string;
  name: string;
  reps: string[];
  iss: string | null;
  apptMs: number | null;
};

/**
 * The rep's NEXT lead to issue for a manager "Push lead" (#12): the earliest
 * Not-Issued lead that still has the rep, with an appointment time after `now`.
 * Pressing Iss on an already-Iss late/missing lead did nothing — this picks the
 * next one to hand the rep. null when there is none.
 */
export function planNextLeadToIssue(
  items: OohNextLeadItem[],
  repName: string,
  nowMs: number,
): OohNextLeadItem | null {
  const rep = oohNormName(repName);
  if (!rep) return null;
  return (
    items
      .filter((it) => (it.iss ?? "").trim() === OOH_NOT_ISSUED)
      .filter((it) => it.reps.map(oohNormName).includes(rep))
      .filter((it) => it.apptMs == null || it.apptMs > nowMs)
      .sort((a, b) => (a.apptMs ?? Infinity) - (b.apptMs ?? Infinity))[0] ?? null
  );
}
