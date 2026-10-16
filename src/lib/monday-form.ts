// Single source of truth for the Monday.com lead-form URL. Both embed
// surfaces (the Log tab's MondayEmbed and Active Run's LeadSheet) iframe the
// same URL: an admin-saved override in localStorage, else the embed-format
// default. Saved per device.
export const MONDAY_URL_STORAGE_KEY = "knockout.monday_form_url";

// The app-only clone of the office's "New Lead" form (created 2026-09-14,
// board 4155518549 view 280849446, same Inbound group "topics" so the
// leads-generated credit gate fires identically). The clone exists so the
// app can prefill Canvasser Name/Office via query params without touching
// the form the office shares. The office original stays reachable at
// forms.monday.com/forms/embed/2e7e2733e186b6e9f3a37c17523f6e6f?r=use1
// (set it via the localStorage override to roll back per device).
export const DEFAULT_MONDAY_FORM_URL =
  "https://forms.monday.com/forms/embed/96f2b63155ef9b8c9818e4aaf52c5144?r=use1";

export function isSafeUrl(u: string) {
  try {
    const url = new URL(u);
    return url.protocol === "https:";
  } catch {
    return false;
  }
}

export function getMondayFormUrl(): string {
  if (typeof window === "undefined") return DEFAULT_MONDAY_FORM_URL;
  return localStorage.getItem(MONDAY_URL_STORAGE_KEY) ?? DEFAULT_MONDAY_FORM_URL;
}

/** The form URL with the canvasser's identity as prefill query params
 *  (question-level QueryParam prefill on the app form: agent → Canvasser
 *  Name, office → Office). Attribution rides profiles.display_name — the
 *  exact string the webhook's Agent matcher keys on — instead of doorstep
 *  typing. Unknown params are ignored by other forms, so a localStorage
 *  override to the office original stays harmless. */
export function getMondayFormUrlWithPrefill(prefill: {
  agent?: string | null;
  office?: string | null;
  /** House-anchored leads only (tap the house → Lead): the OSM-grade street
   *  address of the tapped house. Inert until the app form's Address
   *  question maps a QueryParam named "address" (unknown params are ignored,
   *  so this is safe to send meanwhile). */
  address?: string | null;
}): string {
  const base = getMondayFormUrl();
  try {
    const u = new URL(base);
    // Prefill params carry the rep's name — append them only for
    // Monday-hosted forms (which receive those values in the submission
    // anyway), never for an arbitrary https override URL.
    if (u.hostname !== "forms.monday.com") return base;
    if (prefill.agent) u.searchParams.set("agent", prefill.agent);
    if (prefill.office) u.searchParams.set("office", prefill.office);
    if (prefill.address) u.searchParams.set("address", prefill.address);
    return u.toString();
  } catch {
    return base;
  }
}

// Deterministic submit signal: the app-only form's post-submit redirect loads
// /lead-submitted inside the LeadSheet iframe, and that route postMessages
// this type up to the app — same-origin, no coupling to Monday's embed
// internals. The office's shared form keeps Monday's own thank-you screen.
export const LEAD_SUBMITTED_MESSAGE_TYPE = "ti:lead-submitted";

// Crash insurance for the open lead form (field report 2026-10-16): iOS can
// kill the whole page while the heavy Monday embed is up — white screen, and
// the in-memory pending lead (which house, which address) died with it, so
// the knock was silently lost. While the LeadSheet is open, its target is
// mirrored here; a fresh snapshot found on mount means the page died
// mid-lead and the form reopens where the rep was. Stale snapshots (rep
// moved on, next shift) are ignored and cleared.
export const PENDING_LEAD_STORAGE_KEY = "knockout.pending_lead";
const PENDING_LEAD_MAX_AGE_MS = 20 * 60 * 1000;

export type PendingLeadTarget =
  | { kind: "house"; lat: number; lng: number }
  | { kind: "switch"; pinId: string }
  | { kind: "device" };

export type PendingLeadSnapshot = {
  target: PendingLeadTarget;
  address: string | null;
  at: number;
};

export function savePendingLead(target: PendingLeadTarget, address: string | null) {
  try {
    const snap: PendingLeadSnapshot = { target, address, at: Date.now() };
    localStorage.setItem(PENDING_LEAD_STORAGE_KEY, JSON.stringify(snap));
  } catch {
    /* storage unavailable — recovery is best-effort */
  }
}

export function clearPendingLead() {
  try {
    localStorage.removeItem(PENDING_LEAD_STORAGE_KEY);
  } catch {
    /* storage unavailable */
  }
}

/** A fresh mid-lead snapshot, or null. Reading consumes nothing; the caller
 *  clears it via the normal close path. Malformed/stale entries are removed. */
export function readPendingLead(): PendingLeadSnapshot | null {
  try {
    const raw = localStorage.getItem(PENDING_LEAD_STORAGE_KEY);
    if (!raw) return null;
    const snap = JSON.parse(raw) as PendingLeadSnapshot;
    const kind = snap?.target?.kind;
    const validTarget =
      (kind === "house" &&
        typeof snap.target.lat === "number" &&
        typeof snap.target.lng === "number") ||
      (kind === "switch" && typeof snap.target.pinId === "string") ||
      kind === "device";
    if (
      !validTarget ||
      typeof snap.at !== "number" ||
      Date.now() - snap.at > PENDING_LEAD_MAX_AGE_MS
    ) {
      localStorage.removeItem(PENDING_LEAD_STORAGE_KEY);
      return null;
    }
    return snap;
  } catch {
    try {
      localStorage.removeItem(PENDING_LEAD_STORAGE_KEY);
    } catch {
      /* storage unavailable */
    }
    return null;
  }
}

// Per-device kill switch for the auto-close listener ("off" disables it; the
// flow degrades to the labelled Done bar). Same per-device convention as the
// URL override above.
export const LEAD_CLOSE_V2_STORAGE_KEY = "knockout.lead_close_v2";

export function isLeadCloseV2Enabled(): boolean {
  if (typeof window === "undefined") return false;
  return localStorage.getItem(LEAD_CLOSE_V2_STORAGE_KEY) !== "off";
}
