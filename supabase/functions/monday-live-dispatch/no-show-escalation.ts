// No-show escalation (owner, 2026-11-23): "Every no show — can we also text
// Cynthia and Jeni in the confirmation department so that they can call
// them... and then maybe they can push a button or something that lets us
// all know they called. that would send to Tyler and myself?"
//
// Pure rules only — no Deno APIs, no I/O — so `npm run verify:noshow` can
// exercise them under Node (confirmer-credit.ts precedent). The webhook
// wiring (DB claims + Monday mutations) lives in index.ts; the SMS itself is
// sent by Monday's existing Twilio automations ("When Confirmer Alert
// changes to Send, send SMS to {confirmer phone column}") — the same
// channel that already texts customers on a no-show.

export type EscalationCol = {
  id: string
  text: string | null
  column: { title: string; id: string }
}

/** The Block boards' BO disposition column (status4): the "was the customer
 *  there" column. KEEP IN SYNC with BLOCK_COL.bo in
 *  supabase/functions/monday-ooh-report/engine.ts — ids survive the weekly
 *  template clone, so the pin is stable; the TITLE match below is the
 *  fallback for a rebuilt board. */
export const BO_COLUMN_ID = 'status4'
export const BO_COLUMN_TITLE = 'bo'

/** The trigger column the Twilio automations listen on. Resolved by TITLE
 *  (never id-pinned: it is created by hand on the template board). */
export const ALERT_COLUMN_TITLE = 'confirmer alert'
export const ALERT_SEND_LABEL = 'Send'
export const ALERT_CALLED_LABEL = 'Called'

/** Public origin the SMS links point at (invites.functions.ts precedent). */
export const CALLBACK_BASE_URL = 'https://turfinvaders.com/called/'

/** Lower-case, trim, collapse internal whitespace. */
export function normalizeLabel(s: string | null | undefined): string {
  return (s ?? '').trim().toLowerCase().replace(/\s+/g, ' ')
}

/**
 * True when THIS delivery is the BO column flipping TO exactly "No Show".
 * "No show text" (the at-the-door hold, which already texts the CUSTOMER)
 * and "No Demo" never escalate, and a redelivered/no-op event whose previous
 * value was already "No Show" doesn't re-fire. Label match is exact after
 * normalization: "no show text" !== "no show".
 */
export function isNoShowFlip(
  changedColumnId: string | null | undefined,
  changedColumnTitle: string | null | undefined,
  newLabel: string | null | undefined,
  previousLabel: string | null | undefined,
): boolean {
  const isBoCol =
    changedColumnId === BO_COLUMN_ID || normalizeLabel(changedColumnTitle) === BO_COLUMN_TITLE
  if (!isBoCol) return false
  if (normalizeLabel(newLabel) !== 'no show') return false
  if (normalizeLabel(previousLabel) === 'no show') return false
  return true
}

/** Column id by exact (trimmed, lowercased) title; null when absent —
 *  callers log a board-not-set-up warning instead of guessing. */
export function findColIdByTitle(cols: EscalationCol[], title: string): string | null {
  const want = normalizeLabel(title)
  const c = cols.find((c) => normalizeLabel(c.column?.title) === want)
  return c ? (c.column?.id || c.id) : null
}

/** Column label text by exact title; empty → null (block-cards colText twin). */
export function colTextByTitle(cols: EscalationCol[], title: string): string | null {
  const want = normalizeLabel(title)
  const c = cols.find((c) => normalizeLabel(c.column?.title) === want)
  const t = (c?.text || '').trim()
  return t === '' ? null : t
}

/** The customer snapshot an escalation row carries — everything the
 *  confirmer needs to make the callback without opening Monday. */
export type EscalationDetails = {
  lead_name: string | null
  customer_phone: string | null
  address: string | null
  appt_time: string | null
}

export function buildEscalationDetails(
  cols: EscalationCol[],
  itemName: unknown,
): EscalationDetails {
  const name = String(itemName ?? '').trim()
  return {
    lead_name: name === '' ? null : name,
    customer_phone: colTextByTitle(cols, 'phone'),
    address: colTextByTitle(cols, 'location'),
    appt_time: colTextByTitle(cols, 'date/time'),
  }
}

/** The tokened one-tap link carried in the confirmer's SMS. */
export function callbackUrl(token: string): string {
  return `${CALLBACK_BASE_URL}${encodeURIComponent(token)}`
}

/** E.164 for a US number: digits only, 10 digits get +1, 11 starting with 1
 *  get +. Anything else → null (never text a half-parsed number). */
export function normalizePhoneE164(raw: string | null | undefined): string | null {
  const digits = String(raw ?? '').replace(/\D/g, '')
  if (digits.length === 10) return `+1${digits}`
  if (digits.length === 11 && digits.startsWith('1')) return `+${digits}`
  return null
}
