// Close Kombat aggregation (owner decisions, 2026-07-29): sales-rep stats
// straight from block_cards snapshots, in Monday.com's own language.
//
// - One outcome per card, precedence Sold > PM > Reset > BO — the same order
//   the historical importer uses (HistoricalImporter.tsx) — so a card that
//   was Reset and later ran as a PM counts once, as the PM.
// - 2-rep cards: RESULT COUNTS give each rep full credit, but SALE VOLUME
//   splits evenly between them (owner, 2026-07-29). Company totals are
//   computed from the cards themselves, never by summing rep rows.
// - Iss column: "Iss" = issued lead. An Office Appointment is NOT a lead
//   (job visit / upsale / collecting a check) and never counts in the lead
//   numbers — it ticks the separate officeAppts tally instead, though upsale
//   money still lands in revenue. CTC / Not Issued / Add Rep cards are
//   pipeline states, not appointments a rep ran — they are excluded from
//   Close Kombat entirely (owner, 2026-07-29).
// - Monday's status columns return the literal text "None" for an unset
//   cell (verified live 2026-07-29: rs "None" ×1210 vs "Reset" ×255) —
//   "None" is never a result.
// - Cancels, née WCC (owner, 2026-07-29, renamed 2026-07-30): a sale that
//   later shows "Cancelled" in the monthly Sales Report's WCC column leaves
//   Sold and Revenue — net numbers, not gross. Owner, 2026-07-30: the rep
//   still SAT that demo, so a cancelled sale counts as a PM and keeps its
//   sit ("5 PM + 2 sales, 1 cancels" reads as 6 PM + 1 sale, still 7 sits).
//   The Cancels column is a tally that rides alongside the PM, not a bucket
//   of its own, so results still sum to Appts and Close % takes the hit.
//   Owner, 2026-09-02: the WCC COLUMN is the ONLY cancel authority on the
//   report — "LVM"/"Completed" there means a good sale even when the row's
//   Sales Count column says "Cancelled" (Sales Count is bookkeeping: on a
//   rescued deal it keeps recording the pre-save cancellation — Hagmann,
//   Pinel, Chemberlen, Aug '26; scanned Jun–Sep '26: those three rows were
//   the only WCC/Sales-Count splits). Supersedes the 8/25 Sales-Count
//   fallback, which had killed exactly those saved deals. The stamp follows
//   the CURRENT WCC text on every pass, so a later label change flips the
//   card either way.
// - FTD (owner, 2026-07-30, supersedes its own column): WCC label "FTD" =
//   financial turn down. The demo ran and the money fell through, so it now
//   counts as a PM — no separate FTD tally anywhere.
// - CTC (owner, 2026-07-30): WCC label "CTC" is the same as a cancel — it
//   folds into the Cancels column.
// - Open cards (owner, 2026-07-30, superseding the same-day Sit % rule): an
//   appointment with no result marked yet doesn't count ANYWHERE — not in
//   Appts, not in the percentages, and it isn't displayed. A card enters the
//   stats the moment the board carries a result; until then it's only
//   tracked internally (unmarked).
// - Reload (owner, 2026-07-30, superseding two earlier rules): a reload is a
//   re-sale to an existing customer and is its OWN sales channel, sitting
//   beside the lead funnel rather than inside it. It is counted no matter
//   what the Iss cell says — reloads happen at the customer's job, so the
//   office marks them "Office Appt", and the old lead-only gate held Reload
//   at 0 for all 17 of July 2026's reloads. It is NOT an Appt (no lead was
//   issued) and so is absent from Sit %, Close %, Reset % and Leads / Sale.
//   Reload % = Reload ÷ (Sold + Reload) — the share of all sales that were
//   reloads — and reload money still counts in Revenue.
// - OL (owner, 2026-08-03, superseding the 2026-07-30 "drop OL" call): a
//   one-leg is a lead that RAN but didn't get demoed — on the boards OL is
//   the card's result, not a side-flag (verified: all 34 of July's OL marks
//   sit on cards with nothing else marked; dropping OL had orphaned every
//   one of them out of Appts). OL counts toward lead count with its own OL
//   result column; it is NOT a demo, so Sit % and Close % exclude it.
//   Precedence: last (Cancel > FTD > Sold > PM > Reset > BO > OL) — OL only
//   speaks when nothing else does. OL % = OL ÷ Appts.
// - Can/Save (owner, 2026-08-01): a sold job cancels, the office sends a rep
//   to save it, and the office writes "Can/Save" in the save card's
//   Comments. A save WITH a Sale Price landed: that renegotiated price
//   replaces the original sale's volume ("that trumps out the original
//   price") and the saver takes 50% off the top, the original rep(s)
//   splitting the other 50% evenly — 1 seller + saver = 50/50, 2 sellers +
//   saver = 50/25/25 (owner, 2026-08-01). The saver earns volume only, not
//   a Sold; the save card itself is folded into the original, never counted
//   twice. A save with NO price failed — the job stays cancelled, nothing
//   links.
//   Save → original matching: same office + phone digits (name-key fallback
//   when the save card has no phone), nearest card on/before the save date.
//   Verified on July 2026: 4 saves, 1 landed (Leon — Josh OConnor sold
//   $37,884, wife killed it, Bergan Lundak saved at $27,583 → $13,791.50
//   each, matching the Shark Tank dashboard exactly).
// - Report reps (owner, 2026-08-25; corrected 2026-09-02): the office writes
//   who SHARES THE MONEY in the monthly Sales Report's Sales Rep column — and
//   the Shark Tank splits volume by exactly that column. When the Sales-Report
//   pass stamped report_reps on a card, the VOLUME split follows it; result
//   counts stay with the Block card's own reps. A report row that merely ADDS
//   a name to the Block card's crew is the office splitting the money, not
//   board drift: Hagmann and Pinel (Aug '26) — the cards that originally
//   motivated a "fix the Block card" flag — were sold-cancelled-rescued deals,
//   and the added name (Jonathan Paz) was the SAVER of each, who earns half
//   the volume and must never be added to the Block card (that would mint a
//   Sold he didn't close). The rep_mismatch audit therefore flags only
//   CONTRADICTIONS — a Block rep the report dropped or replaced, or a report
//   crediting a card whose Reps cell is empty — never pure additions.
// - Save cards never count on their own (owner, 2026-08-28): the lead was
//   already issued and counted on the ORIGINAL card, so a Can/Save card —
//   landed, failed, or unlinked — is never an Appt, a Sold, an office tally,
//   or revenue of its own. A landed save folds into its original; everything
//   else counts nowhere. A PRICED save that can't find its original is
//   flagged orphan_save (its money counts nowhere until the card is fixed);
//   an unpriced save is a failed save and stays silent by design.
// - Cross-range saves (owner, 2026-08-28): the re-priced volume belongs to
//   the ORIGINAL sale's date — a July 30 sale saved on Aug 5 pays out in
//   July's standings at the save's price, and August shows nothing for the
//   deal. aggregateCloseKombat/auditBlockCards therefore take an optional
//   stats window: save→original linking runs over EVERY card supplied (the
//   UI fetches ±42 days of context around the view), while counting and
//   flagging cover only cards inside the window.
//
// Pure module: no imports, unit-testable like funnel.ts.

/** Mirror of block_cards Row (kept structural so fixtures stay trivial). */
export type BlockCard = {
  monday_item_id: string;
  board_id: string;
  office_location: string;
  card_date: string | null;
  group_title: string | null;
  lead_name: string | null;
  reps: string[];
  iss: string | null;
  bo: string | null;
  ol: string | null;
  rs: string | null;
  pm: string | null;
  sale: string | null;
  sale_price: number | null;
  products: string | null;
  canvass_stats: string | null;
  /** Raw WCC label from the monthly Sales Report, matched on by the sync. */
  wcc: string | null;
  /** Confirmer/office notes — carries the "Can/Save" marker (owner, 2026-08-01). */
  comments: string | null;
  /** Customer phone — links a Can/Save card to the original sale's card. */
  phone: string | null;
  /** Rep display names from the card's best-matched Sales-Report row —
   *  stamped ONLY by the Sales-Report pass (same contract as wcc; the row
   *  builders exclude it so upserts never clobber). When non-empty it
   *  overrides `reps` for the VOLUME split only (owner, 2026-08-25). */
  report_reps: string[] | null;
};

/** Sale-column values that mean sold — keep in sync with SOLD_VALUES in
 *  supabase/functions/monday-live-dispatch/index.ts. */
export const SOLD_VALUES = ["sold", "reload", "upsell", "sale"] as const;

export type CardOutcome =
  "sold" | "cancelled" | "pm" | "reset" | "no_show" | "no_demo" | "ol" | "unmarked";

/** WCC label tests — "Cancelled"/"CTC" and "FTD" (financial turn down) all
 *  kill the sale's volume; CTC counts inside the WCC column while FTD gets
 *  its own (owner, 2026-07-30). */
const isCancelLabel = (v: string | null | undefined): boolean =>
  /cancel/i.test(v ?? "") || /\bctc\b/i.test(v ?? "");
const isFtdLabel = (v: string | null | undefined): boolean =>
  /\bftd\b/i.test(v ?? "") || /financial\s*turn/i.test(v ?? "");

/** A cell counts only when it carries a real label — Monday hands back ""
 *  or the literal "None" for unset status cells depending on the column. */
const marked = (v: string | null | undefined): boolean => {
  const t = (v ?? "").trim().toLowerCase();
  return t !== "" && t !== "none";
};

/** ONE outcome per card: Cancelled/CTC > FTD > Sold > PM > Reset > BO > OL. A WCC
 *  cancel wins even when the card's Sale cell is empty — when a sale cancels the
 *  office usually reverts the Block board's Sale column too, but the Sales
 *  Report row proves the sale happened and died. FTD keeps its slot in the
 *  order (it must outrank a leftover "Sold" cell) but resolves to a PM. The BO
 *  column's own label splits No Show vs No Demo ("No Show" text → no_show,
 *  anything else marked → no_demo). OL (one-leg: ran, not demoed) speaks only
 *  when nothing else does. Unmarked = hasn't resolved yet. */
export function cardOutcome(
  c: Pick<BlockCard, "bo" | "rs" | "pm" | "sale" | "wcc" | "ol">,
): CardOutcome {
  if (isCancelLabel(c.wcc)) return "cancelled";
  if (isFtdLabel(c.wcc)) return "pm";
  const sale = (c.sale ?? "").trim().toLowerCase();
  if ((SOLD_VALUES as readonly string[]).includes(sale)) return "sold";
  if (marked(c.pm)) return "pm";
  if (marked(c.rs)) return "reset";
  if (marked(c.bo)) return /no\s*show/i.test(c.bo as string) ? "no_show" : "no_demo";
  if (marked(c.ol)) return "ol";
  return "unmarked";
}

/** An active Reload sale (owner, 2026-07-30: its own sales channel, outside
 *  the lead funnel — counted in Reload and Revenue, never in Appts or any
 *  lead percentage). A cancelled reload is a Cancel, not a reload. */
export function isReload(c: Pick<BlockCard, "sale" | "wcc">): boolean {
  return (
    cardOutcome({ bo: null, rs: null, pm: null, ol: null, sale: c.sale, wcc: c.wcc }) === "sold" &&
    (c.sale ?? "").trim().toLowerCase() === "reload"
  );
}

/** Office Appointment per the Iss column (label truncates to "Office A…" on
 *  the board, so match any "office" variant). Blank or "Iss" = issued lead —
 *  only an explicit office mark pulls a card out of the lead numbers. */
export function isOfficeAppt(c: Pick<BlockCard, "iss">): boolean {
  return /office/i.test(c.iss ?? "");
}

/** Pipeline states, not appointments a rep ran — excluded from Close Kombat
 *  entirely (owner, 2026-07-29): CTC (cancelled before running), Not Issued,
 *  Add Rep. Exact labels as seen on the live boards. */
export function isExcludedCard(c: Pick<BlockCard, "iss">): boolean {
  const v = (c.iss ?? "").trim().toLowerCase();
  return v === "ctc" || v === "not issued" || v === "add rep";
}

/** A Can/Save card (owner, 2026-08-01): a sold job cancelled and the office
 *  sent a rep to save it. The office writes "Can/Save" (verified verbatim on
 *  all four July 2026 saves) in Comments; tolerate spacing/punctuation. */
export function isCanSave(c: Pick<BlockCard, "comments">): boolean {
  return /can\W{0,3}save/i.test(c.comments ?? "");
}

/** Phone → bare 10 digits ("+1 (562) 380-5392" and "15623805392" both →
 *  "5623805392"); "" when there's nothing usable to match on. */
export function phoneKey(p: string | null | undefined): string {
  const d = (p ?? "").replace(/\D/g, "");
  return d.length === 11 && d.startsWith("1") ? d.slice(1) : d;
}

/** Order-insensitive customer-name key, for save→original linking when a
 *  card has no phone: "Darren and Angela Leon (copy)" and "Leon, Darren &
 *  Angela" both → "angela darren leon". */
export function customerKey(s: string | null | undefined): string {
  const NOISE = new Set(["and", "the", "mr", "mrs", "ms", "dr", "sho", "copy", "wife", "husband"]);
  return (s ?? "")
    .toLowerCase()
    .replace(/[^a-z]+/g, " ")
    .split(" ")
    .filter((t) => t.length > 1 && !NOISE.has(t))
    .sort()
    .join(" ");
}

/** Trim, collapse internal runs of whitespace (house rule — see normalizeName
 *  in utils.ts; "Daniel  Figueiredo" and "Daniel Figueiredo" are one person),
 *  drop blanks, dedupe — a Reps cell of "Sam, Sam" is one Sam, not a double
 *  bump with a halved split. Every rep list goes through this door. */
export function cleanReps(xs: string[] | null | undefined): string[] {
  return [
    ...new Set((xs ?? []).map((r) => r.trim().replace(/\s+/g, " ")).filter(Boolean)),
  ];
}

/** Who gets RESULT credit (Appts/Sold/...): always the Block card's own reps.
 *  The Sales Report proves who shares the money, not who sat the demo. */
export function countReps(c: Pick<BlockCard, "reps">): string[] {
  return cleanReps(c.reps);
}

/** Who shares the card's MONEY (owner, 2026-08-25): the Sales-Report row's
 *  reps when the pass stamped them, else the Block card's own. Result counts
 *  never read this — they stay with countReps. */
export function volumeReps(c: Pick<BlockCard, "reps" | "report_reps">): string[] {
  const fromReport = cleanReps(c.report_reps);
  return fromReport.length > 0 ? fromReport : cleanReps(c.reps);
}

/** One report row's evidence about a card, as collected by the Sales-Report
 *  pass in block-cards.server.ts. Lives here so the decision ladder below is
 *  unit-testable by verify-close-kombat.ts (this module stays pure). */
export type ReportRepHit = {
  /** The row's WCC label (Cancelled/CTC/FTD/...), null when unset. */
  wcc: string | null;
  /** The row's Sale Amt — best-row tiebreak only, never a volume source. */
  amt: number | null;
  /** The row's "Sales Rep" people column, cleaned display names. */
  reps: string[];
  /** The row's real Date Sold (null when unparseable). */
  saleDate: string | null;
  /** Matched in matchReportRow's date-anchored pass — the only tier trusted
   *  to rewrite who gets paid. */
  dateTrue: boolean;
  /** The row's board had a resolvable "Sales Rep" column. A renamed column
   *  makes every row look repless — that must read as "unknown", never as
   *  "the office removed the reps" (it would mass-clear a month of stamps). */
  repsKnown: boolean;
};

/** The ONE report row allowed to name a card's volume reps (owner,
 *  2026-08-25), and whether to write at all. Union-across-rows is
 *  deliberately avoided: one customer spans sale + reload + "(copy)" rows
 *  with DIFFERENT rep sets, and a mis-bound sibling would dilute the sale
 *  and double-count its closer.
 *
 *  Returns { set } to write (set may be null = clear a stale stamp) or null
 *  to leave the stored stamp untouched. A stamp is only CLEARED by evidence
 *  as strong as what sets one: a date-anchored match from a board whose
 *  Sales Rep column resolved. Weaker evidence (date-blind fuzzy matches, a
 *  renamed column) keeps the stamp. Can/Save cards never carry a stamp —
 *  the report row describes the sale's closers, not the save crew.
 *
 *  Among qualifying rows: the one whose Sale Amt equals the card's Sale
 *  Price wins, then the nearest Date Sold, then a non-cancel row. */
export function chooseReportReps(
  hits: ReportRepHit[],
  card: { sale_price: number | null; card_date: string | null; can_save: boolean },
): { set: string[] | null } | null {
  if (card.can_save) return { set: null };
  const cands = hits.filter((h) => h.dateTrue && h.repsKnown);
  if (cands.length === 0) return null; // weak evidence — keep what's stored
  const withReps = cands.filter((h) => h.reps.length > 0);
  if (withReps.length === 0) return { set: null }; // office removed the reps
  const dead = (v: string | null) => isCancelLabel(v) || isFtdLabel(v);
  const dist = (h: ReportRepHit) =>
    h.saleDate && card.card_date
      ? Math.abs(Date.parse(h.saleDate) - Date.parse(card.card_date))
      : Number.MAX_SAFE_INTEGER;
  const best = [...withReps].sort((a, b) => {
    const amtA = card.sale_price !== null && a.amt === card.sale_price ? 0 : 1;
    const amtB = card.sale_price !== null && b.amt === card.sale_price ? 0 : 1;
    if (amtA !== amtB) return amtA - amtB;
    const dA = dist(a);
    const dB = dist(b);
    if (dA !== dB) return dA - dB;
    return Number(dead(a.wcc)) - Number(dead(b.wcc));
  })[0];
  return { set: cleanReps(best.reps) };
}

/** Among one report row's name-matched candidate CARDS, keep only those
 *  whose Sale Price equals one of the row's dollar figures (Sale Amt or
 *  Cancel Amt) when any do — the card-side mirror of chooseReportReps's
 *  amount rule. A repeat customer's sale + reload rows land days apart
 *  (Buford, Aug '26: $9,900 sale dated 8/4 and $12,048 reload dated 8/5,
 *  cards on 8/4 and 8/6) and nearest-card_date ties at one day each — both
 *  cancel rows bound to the 8/4 card and the cancelled 8/6 reload kept
 *  counting. The dollar figure is identity evidence, so it narrows before
 *  the date tiebreak; a row with no figure, or no card at that price,
 *  changes nothing. Zero/blank never matches — blanks are everywhere and
 *  prove nothing. */
export function preferAmountMatch<T extends { sale_price: number | null }>(
  cands: T[],
  amounts: Array<number | null>,
): T[] {
  if (cands.length < 2) return cands;
  const cents = new Set(
    amounts.filter((a): a is number => a !== null && a > 0).map((a) => Math.round(a * 100)),
  );
  if (cents.size === 0) return cands;
  const priced = cands.filter(
    (c) => c.sale_price !== null && cents.has(Math.round(c.sale_price * 100)),
  );
  return priced.length > 0 ? priced : cands;
}

export type RepStats = {
  rep: string;
  /** RESULTED leads only — a card with nothing marked yet isn't an appt, and
   *  neither Office Appointments nor reloads count here (owner, 2026-07-30).
   *  noShow + noDemo + ol + reset + pm + sold always equals this. */
  appts: number;
  noShow: number;
  noDemo: number;
  /** One-legs — the lead ran but didn't get demoed (owner, 2026-08-03):
   *  an Appt with its own result, never a demo. */
  ol: number;
  reset: number;
  /** Demos that didn't end in a kept sale — includes FTDs and cancelled
   *  sales, since the rep sat those too (owner, 2026-07-30). */
  pm: number;
  sold: number;
  /** Reload sales — their own channel, NOT inside sold and NOT inside appts
   *  (owner, 2026-07-30): a reload is a re-sale to an existing customer, so
   *  no lead was issued for it. Counted even when the Iss cell says "Office
   *  Appt", which it almost always does. Money still counts in Revenue. */
  reloads: number;
  /** Sales later cancelled on the monthly report (Cancelled / CTC) — out of
   *  Sold and Revenue. A TALLY, not a bucket: a LEAD sale's cancel is
   *  already counted in `pm` (owner, 2026-07-30 — the demo ran), so never
   *  add this to the result columns or Appts will double-count. A cancel on
   *  an office-appt card (a dead reload/upsell — Ledger, Aug '26) is tallied
   *  here WITHOUT a pm: no lead was sat, but the owner counts every dead
   *  written sale. */
  cancels: number;
  /** Cards with no result yet — internal tally only: NOT in appts and never
   *  displayed (owner, 2026-07-30). */
  unmarked: number;
  /** Office Appointments (job visit / upsale / check pickup) — not leads. */
  officeAppts: number;
  /** Lead demos (PM + Sold) ÷ Appts (owner, 2026-07-30) — appts are
   *  resulted-only by construction; null until a resulted appt exists.
   *  Reloads are not lead demos and never appear here. */
  sitPct: number | null;
  /** Sold ÷ lead demos (PM + Sold) — owner, 2026-07-30: kept purely
   *  lead-based, since folding reloads in would inflate the close rate on
   *  lead appointments. Null until a demo exists. */
  closePct: number | null;
  /** Reset ÷ Appts — null until an appt exists. */
  resetPct: number | null;
  /** Reload ÷ (Sold + Reload) (owner, 2026-07-30) — the share of sales that
   *  were reloads, NOT a share of leads; null until a sale exists. */
  reloadPct: number | null;
  /** No Demo ÷ Appts — null until an appt exists. */
  noDemoPct: number | null;
  /** No Show ÷ Appts — completes the BO split alongside No Demo %. */
  noShowPct: number | null;
  /** OL ÷ Appts — share of resulted leads that ran one-legged. */
  olPct: number | null;
  /** Cancels ÷ (Sold + Cancels) — share of written LEAD sales that later
   *  died on the Sales Report; null until a sale was written. */
  cancelPct: number | null;
  /** Appts ÷ Sold (owner, 2026-07-30) — leads needed per lead-sourced sale,
   *  rendered as a plain number (4.5), not a percentage. Reloads are excluded
   *  from both sides: no lead was spent to get one. Null until a sale exists,
   *  since dividing by zero sales is meaningless rather than zero. */
  leadsToSale: number | null;
  /** Sale volume: split evenly across the card's volume reps (report_reps
   *  when the Sales-Report pass stamped them, else the Block card's reps —
   *  owner, 2026-08-25); includes office-appt upsales. */
  revenue: number;
};

export type KombatTotals = Omit<RepStats, "rep">;

const emptyStats = (): Omit<RepStats, "rep"> => ({
  appts: 0,
  noShow: 0,
  noDemo: 0,
  ol: 0,
  reset: 0,
  pm: 0,
  sold: 0,
  reloads: 0,
  cancels: 0,
  unmarked: 0,
  officeAppts: 0,
  sitPct: null,
  closePct: null,
  resetPct: null,
  reloadPct: null,
  noDemoPct: null,
  noShowPct: null,
  olPct: null,
  cancelPct: null,
  leadsToSale: null,
  revenue: 0,
});

/** A cancelled sale lands in PM (owner, 2026-07-30): the rep sat the demo, so
 *  it's still a sit — they just don't keep the sale. `cancels` is tallied
 *  alongside in bump(), not instead, which is why "cancelled" maps to pm. */
const OUTCOME_KEY: Record<Exclude<CardOutcome, "unmarked">, keyof KombatTotals> = {
  sold: "sold",
  cancelled: "pm",
  pm: "pm",
  reset: "reset",
  no_show: "noShow",
  no_demo: "noDemo",
  ol: "ol",
};

/** A landed save's effect on the original sale (owner, 2026-08-01):
 *  the renegotiated price REPLACES the original volume; the saver takes 50%
 *  and the original rep(s) split the other 50% evenly. */
type SaveEffect = { price: number; saverReps: string[]; saveDate: string };

/** Link each landed Can/Save card to the original sale it rescued.
 *  Match by office + phone (name-key fallback when the save has no phone),
 *  preferring the nearest card dated on/before the save. A save with no
 *  price FAILED — the job stayed dead, nothing links, nothing changes. */
function linkSaves(cards: BlockCard[]): {
  effects: Map<string, SaveEffect>;
  consumed: Set<string>;
} {
  const effects = new Map<string, SaveEffect>();
  const consumed = new Set<string>();
  for (const s of cards) {
    if (!isCanSave(s)) continue;
    if (!(s.sale_price != null && s.sale_price > 0)) continue; // failed save
    const sPhone = phoneKey(s.phone);
    const sName = customerKey(s.lead_name);
    const cands = cards.filter((o) => {
      if (o === s || isCanSave(o)) return false;
      if (o.office_location !== s.office_location) return false;
      // Only originals the stats can actually see — linking to an excluded
      // (Not Issued / CTC / Add Rep) card would sink the money with it.
      if (isExcludedCard(o) && !isCancelLabel(o.wcc) && !isFtdLabel(o.wcc)) return false;
      const oc = cardOutcome(o);
      if (oc !== "sold" && oc !== "cancelled") return false;
      const key = sPhone !== "" ? phoneKey(o.phone) : null;
      return key !== null ? key === sPhone : sName !== "" && customerKey(o.lead_name) === sName;
    });
    if (cands.length === 0) continue; // original outside this range: the deal
    // already counts (corrected) in ITS OWN range — never double it here.
    const dist = (o: BlockCard) => {
      if (!o.card_date || !s.card_date) return Number.MAX_SAFE_INTEGER / 2;
      const d = Date.parse(s.card_date) - Date.parse(o.card_date);
      // The sale precedes the save — a later-dated "original" is suspect,
      // so it only wins when nothing sits on/before the save date.
      return d >= 0 ? d : Number.MAX_SAFE_INTEGER / 2 - d;
    };
    const original = cands.reduce((b, o) => (dist(o) < dist(b) ? o : b));
    const prev = effects.get(original.monday_item_id);
    // Several saves for one job: the latest landed save is the live contract.
    if (!prev || (s.card_date ?? "") >= prev.saveDate) {
      effects.set(original.monday_item_id, {
        price: s.sale_price,
        // Deliberately the BLOCK card's reps, never report_reps: the report
        // row describes the sale's closers, not the save crew — a matched
        // cancel row must not redirect the saver's half (owner, 2026-08-25).
        saverReps: countReps(s),
        saveDate: s.card_date ?? "",
      });
    }
    consumed.add(s.monday_item_id);
  }
  return { effects, consumed };
}

/** Optional stats window (inclusive ISO dates): cards outside it still LINK
 *  saves — a July original must be re-priceable by an August save — but never
 *  count or get flagged. With no window every card counts (fixtures, and any
 *  caller that already narrowed its input). A dateless card counts only when
 *  no window is given: the UI's date-bounded fetch can't return one anyway. */
export type KombatWindow = { start: string; end: string };

const inWindow = (c: Pick<BlockCard, "card_date">, w: KombatWindow | undefined): boolean =>
  !w || (c.card_date !== null && c.card_date >= w.start && c.card_date <= w.end);

export function aggregateCloseKombat(
  cards: BlockCard[],
  window?: KombatWindow,
): {
  reps: RepStats[];
  totals: KombatTotals;
} {
  const byRep = new Map<string, RepStats>();
  const totals: KombatTotals = emptyStats();
  const repRow = (name: string): RepStats => {
    let s = byRep.get(name);
    if (!s) {
      s = { rep: name, ...emptyStats() };
      byRep.set(name, s);
    }
    return s;
  };

  // Can/Save pre-pass (owner, 2026-08-01): a landed save re-prices the
  // original sale and adds the saver to the volume split.
  const saves = linkSaves(cards);

  /** Result counts only — volume is handled in the loop below, because a
   *  landed save changes both the price and WHO shares it. Full result
   *  credit to each rep on the card (owner rule). */
  const bump = (s: Omit<RepStats, "rep">, c: BlockCard) => {
    const outcome = cardOutcome(c);
    if (outcome === "sold" && isReload(c)) {
      // Reload = its own sales channel (owner, 2026-07-30). Re-selling an
      // existing customer happens at their job, so the office marks the Iss
      // cell "Office Appt" on essentially every one — 17 of 17 in July 2026.
      // Gating reloads behind the lead check therefore pinned Reload and
      // Reload % at zero permanently. Counted here whatever Iss says, and
      // deliberately NOT an Appt: no lead was issued for it, so it stays out
      // of Sit %, Close %, Reset % and Leads / Sale.
      s.reloads += 1;
    } else if (isOfficeAppt(c)) {
      // Job visit / upsale / check pickup: not a lead and not a reload, so
      // only the office tally — but its money still lands in revenue below.
      s.officeAppts += 1;
      // A written sale that DIED on an office-appt card still joins the
      // Cancels tally (owner counts every dead sale: "5 cancelled sales in
      // SD and 1 in OC", 2026-09-02 — the 1 was Ledger's $30,500 reload
      // cancel, invisible here because reloads live on office-appt cards).
      // No appt and no PM: an office appt is never a lead sit.
      if (outcome === "cancelled") s.cancels += 1;
    } else if (outcome === "unmarked") {
      // No result on the board yet: not an appt at all (owner, 2026-07-30) —
      // internal tally only, the card joins the stats once it's resulted.
      s.unmarked += 1;
    } else {
      s.appts += 1;
      // "cancelled" maps to pm here — the rep still sat the demo, so a
      // cancelled sale is a sit they don't get to keep (owner, 2026-07-30:
      // 5 PM + 2 sales with 1 cancel reads as 6 PM + 1 sale, still 7 sits).
      s[OUTCOME_KEY[outcome]] += 1;
      // Tallied ALONGSIDE the PM, never instead of it, so Cancel % can still
      // report how many written sales died.
      if (outcome === "cancelled") s.cancels += 1;
    }
  };

  for (let card of cards) {
    // A landed save card is folded into its original below — counting it
    // here too would double the deal.
    if (saves.consumed.has(card.monday_item_id)) continue;
    // Any OTHER Can/Save card — failed, or priced but unlinked — counts
    // NOWHERE (owner, 2026-08-28): the lead was already issued and counted
    // on the original card, so a save attempt is never a second Appt, Sold,
    // or office tally, whatever results the office marks on it. A priced
    // save with no findable original is surfaced by the orphan_save audit
    // flag rather than guessed into the stats.
    if (isCanSave(card)) continue;
    // Context card outside the stats window: it's here so saves can link
    // across a range edge — it counts in its OWN range's view, never this
    // one (owner, 2026-08-28: the re-priced deal pays on the original's
    // date).
    if (!inWindow(card, window)) continue;
    const save = saves.effects.get(card.monday_item_id);
    // A landed save supersedes a stale Cancelled stamp: the deal is alive
    // again, so the original counts as the sale it is. (The Sales-Report
    // sync heals the stamp on its next pass; this covers the gap.)
    if (save && cardOutcome(card) === "cancelled") card = { ...card, wcc: null };
    // CTC / Not Issued / Add Rep never reach the stats at all — UNLESS the
    // monthly report stamped the card dead (Cancelled/CTC/FTD): the office
    // often flips a dead sale's Iss cell to "CTC" too, and the report proves
    // an issued lead ran and sold, so it must count as an appt.
    if (isExcludedCard(card) && !isCancelLabel(card.wcc) && !isFtdLabel(card.wcc)) continue;
    // Totals count every card exactly once — reps.length never inflates them.
    bump(totals, card);
    // Result counts follow the Block card's reps; the volume split below
    // follows the Sales Report when it disagrees (owner, 2026-08-25).
    const countNames = countReps(card);
    for (const name of countNames) bump(repRow(name), card);

    // --- Volume. Money is money — an office-appt upsale still pays. A blank
    // Sale Price on the Block board is $0, full stop (owner, 2026-07-30):
    // never infer a price from another source, never guess. Nothing else may
    // write sale_price either — see the Sales-Report pass in
    // block-cards.server.ts. A landed save is the ONE lawful override
    // (owner, 2026-08-01): its renegotiated price replaces the original —
    // "that trumps out the original price". The SAVER'S HALF comes off the
    // top (owner, 2026-08-01): 50% to whoever saved it, the other 50% split
    // evenly among the original rep(s) — so 1 seller + saver = 50/50, and
    // 2 sellers + saver = 50/25/25. A rep on both cards earns both shares.
    // The office sometimes writes the save split into the report row's rep
    // pair too (Hagmann/Pinel, Aug '26): a saver's name THERE is the same
    // 50% already paid off the top, never a second cut of the originals'
    // half. Result credit stays with the card's own reps: the saver earns
    // volume, not a Sold.
    if (cardOutcome(card) === "sold") {
      totals.revenue += save ? save.price : (card.sale_price ?? 0);
      const volNames = volumeReps(card);
      if (save) {
        // saverReps comes out of linkSaves already cleaned/deduped.
        const savers = save.saverReps;
        // No saver names on the save card: nobody to pay the save half to —
        // the originals split the whole re-priced deal instead.
        const saverPool = savers.length > 0 ? save.price / 2 : 0;
        const originalPool = save.price - saverPool;
        for (const name of savers) repRow(name).revenue += saverPool / savers.length;
        // A saver who reached volNames only through the REPORT STAMP already
        // took the save half above — drop them from the originals' half, or
        // the office writing the split into the report pair pays them twice
        // (75/25 on a one-seller deal instead of the owner's 50/50). A saver
        // the BLOCK card itself names sold the deal too, and a rep on both
        // cards earns both shares — they stay.
        const blockSet = new Set(countNames.map((r) => r.toLowerCase()));
        const saverSet = new Set(savers.map((r) => r.toLowerCase()));
        const originals = volNames.filter(
          (n) => !saverSet.has(n.toLowerCase()) || blockSet.has(n.toLowerCase()),
        );
        const originalNames = originals.length > 0 ? originals : volNames;
        // No original reps recorded: their half stays uncredited (company
        // totals keep the whole price) — never invent a recipient.
        for (const name of originalNames)
          repRow(name).revenue += originalPool / originalNames.length;
      } else {
        const price = card.sale_price ?? 0;
        for (const name of volNames) repRow(name).revenue += price / volNames.length;
      }
    }
  }

  /** Owner's formulas, 2026-07-30. Every ratio is null (renders "—") rather
   *  than 0 when its denominator is empty — "no sales yet" and "0%" are
   *  different claims. */
  const finalize = (s: Omit<RepStats, "rep">) => {
    // Lead funnel: demos and sales that came from an issued lead. Cancelled
    // sales are already inside `pm` (the demo ran), so sits stay whole.
    // Reloads are excluded on purpose (owner, 2026-07-30) — counting a
    // re-sale to an existing customer as a lead demo would flatter every
    // lead percentage.
    const demos = s.pm + s.sold;
    const written = s.sold + s.cancels;
    // Both channels together — the only place a reload belongs.
    const sales = s.sold + s.reloads;
    s.sitPct = s.appts > 0 ? demos / s.appts : null;
    s.closePct = demos > 0 ? s.sold / demos : null;
    s.resetPct = s.appts > 0 ? s.reset / s.appts : null;
    s.noDemoPct = s.appts > 0 ? s.noDemo / s.appts : null;
    s.noShowPct = s.appts > 0 ? s.noShow / s.appts : null;
    s.olPct = s.appts > 0 ? s.ol / s.appts : null;
    s.reloadPct = sales > 0 ? s.reloads / sales : null;
    s.cancelPct = written > 0 ? s.cancels / written : null;
    s.leadsToSale = s.sold > 0 ? s.appts / s.sold : null;
    s.revenue = Math.round(s.revenue * 100) / 100;
  };
  finalize(totals);

  // No all-zero rows in the standings: a rep shows up once they have a
  // resulted appt, a reload, or office-appt upsale money — a $0 reload would
  // otherwise hide a rep who did sell something.
  const reps = [...byRep.values()].filter((r) => r.appts > 0 || r.reloads > 0 || r.revenue > 0);
  for (const r of reps) finalize(r);
  // Rank by SALE VOLUME, highest first (owner, 2026-07-30) — the same order
  // in the day, week and month views, since the aggregate is what's sorted.
  // Sale count breaks ties, then appts, then name so the order is stable.
  reps.sort(
    (a, b) =>
      b.revenue - a.revenue ||
      b.sold + b.reloads - (a.sold + a.reloads) ||
      b.appts - a.appts ||
      a.rep.localeCompare(b.rep),
  );
  return { reps, totals };
}

// ── Needs Attention ────────────────────────────────────────────────────────
// Board-hygiene audit (owner, 2026-08-03), born from the July reconciliation
// against the Shark Tank dashboard: every dollar of daylight between the two
// traced to a Block card with a blank price, a sale trapped on a Not Issued
// card, a sale with no reps, or a card in the wrong group. Each of those
// failure modes is silent — the card just quietly counts wrong or not at
// all — so this surfaces them on the dashboard instead of waiting for a
// month-end audit. Detection only: the numbers stay exactly what the board
// says (see the never-invent rule); fixing happens on Monday, then a sync.

export type AttentionKind =
  | "duplicate_sale"
  | "excluded_sale"
  | "orphan_save"
  | "no_reps"
  | "blank_price"
  | "rep_mismatch"
  | "unresolved"
  | "no_weekday_group";

export type AttentionItem = {
  kind: AttentionKind;
  monday_item_id: string;
  lead_name: string | null;
  office_location: string;
  card_date: string | null;
  reps: string[];
  /** What's wrong and what fixing it on Monday looks like. */
  detail: string;
};

const WEEKDAY_NAMES = [
  "monday",
  "tuesday",
  "wednesday",
  "thursday",
  "friday",
  "saturday",
  "sunday",
];

/** Group titles that aren't weekday-named get a drifting fallback date at
 *  sync time (active boards stamp "today") — mirror of deriveCardDate. */
const isWeekdayGroup = (title: string | null): boolean => {
  const t = (title ?? "").trim().toLowerCase();
  return WEEKDAY_NAMES.some((w) => t === w || t.startsWith(w + " "));
};

/** Same people, ignoring order/case/spacing — "b, A" equals "a, B". Used to
 *  keep the rep_mismatch flag quiet when the boards actually agree, and by
 *  the Sales-Report pass to skip no-op report_reps writes. Routed through
 *  cleanReps so its normalization can never drift from the rep lists'. */
export const sameRepSet = (a: string[], b: string[]): boolean => {
  const key = (xs: string[]) =>
    [...new Set(cleanReps(xs).map((r) => r.toLowerCase()))].sort().join("|");
  return key(a) === key(b);
};

/** The report kept every Block rep and only ADDED names — and the card
 *  actually names its crew. That shape is the office splitting the money
 *  (a saver written into the pay pair — Hagmann/Pinel, Aug '26), never
 *  board drift, so the audit stays quiet on it. An empty Reps cell doesn't
 *  qualify: a report crediting people the board doesn't name at all is a
 *  contradiction, not an addition. */
export const reportOnlyAdds = (report: string[], block: string[]): boolean => {
  const rep = new Set(cleanReps(report).map((r) => r.toLowerCase()));
  const blk = cleanReps(block).map((r) => r.toLowerCase());
  return blk.length > 0 && blk.every((b) => rep.has(b)) && rep.size > blk.length;
};

/** ONE issue per card, worst first — a Not Issued card carrying a sale also
 *  has a blank price half the time, and the Iss fix has to come first anyway
 *  (the price only starts counting once the card counts at all). Save-aware:
 *  the audit must never contradict how aggregateCloseKombat counts the same
 *  card, so landed-save cards (consumed into their original) are exempt from
 *  the money checks, and an original that a landed save re-priced is not
 *  "counting as $0" — the save price replaced it. */
export function auditBlockCards(
  cards: BlockCard[],
  todayISO: string,
  window?: KombatWindow,
): AttentionItem[] {
  const saves = linkSaves(cards);

  // Duplicate sales (owner, 2026-08-31): an automation on the SD Block board
  // doubles a new sale card seconds after it's created — same customer,
  // phone, price and date, one card named "... (copy)" (Libiran and Hauser
  // 8/28, the Ortegas 8/29). Both cards carry a sold result, so one deal
  // pays twice until the office deletes the extra on Monday. Detection only:
  // board = ground truth, the aggregate keeps counting both. Membership
  // mirrors what actually counts as sold money — Can/Save cards never join
  // (two landed save cards for one original, the Chemberlen 8/25 pair, are
  // absorbed by linkSaves and are NOT duplicates), excluded cards don't
  // count in the first place, and a blank phone or price proves nothing.
  const dupKey = (c: BlockCard): string | null => {
    if (isCanSave(c) || isExcludedCard(c)) return null;
    if (cardOutcome(c) !== "sold") return null;
    if (!(c.sale_price !== null && c.sale_price > 0)) return null;
    const phone = phoneKey(c.phone);
    if (phone === "" || c.card_date === null) return null;
    return [c.office_location, phone, c.sale_price, c.card_date].join("|");
  };
  const dupGroups = new Map<string, BlockCard[]>();
  for (const c of cards) {
    const k = dupKey(c);
    if (k === null) continue;
    const g = dupGroups.get(k);
    if (g) g.push(c);
    else dupGroups.set(k, [c]);
  }
  // Every card in a group gets flagged, each naming its twin(s) — whichever
  // card the office keeps, the flag dies with the deleted one.
  const dupTwins = new Map<string, BlockCard[]>();
  for (const g of dupGroups.values()) {
    if (g.length < 2) continue;
    for (const c of g) dupTwins.set(c.monday_item_id, g.filter((o) => o !== c));
  }

  const items: AttentionItem[] = [];
  for (const c of cards) {
    // Context cards outside the stats window link saves but belong to their
    // own range's view — flag them there, not here.
    if (!inWindow(c, window)) continue;
    const outcome = cardOutcome(c);
    const saleLabel = (c.sale ?? "").trim();
    const carriesSale = (SOLD_VALUES as readonly string[]).includes(saleLabel.toLowerCase());
    const reps = countReps(c);
    const reportReps = cleanReps(c.report_reps);
    const excluded = isExcludedCard(c);
    const canSave = isCanSave(c);
    const dead = isCancelLabel(c.wcc) || isFtdLabel(c.wcc);
    // A landed save card is folded into its original — the aggregate already
    // counts its price there, whatever its own Iss/reps/price cells look like.
    const consumedSave = saves.consumed.has(c.monday_item_id);
    // A landed save's price replaces the original's, so a blank cell on the
    // original no longer means $0.
    const savePriced = saves.effects.has(c.monday_item_id);
    const inWeekdayGroup = isWeekdayGroup(c.group_title);

    const twins = dupTwins.get(c.monday_item_id);

    let kind: AttentionKind | null = null;
    let detail = "";
    if (twins) {
      // The Monday copy-step double: worst issue a card can have — real
      // money counting more than once.
      kind = "duplicate_sale";
      const names = twins.map((t) => `"${t.lead_name ?? "(unnamed card)"}"`).join(", ");
      detail =
        `same phone, $${(c.sale_price ?? 0).toLocaleString("en-US")} and date as ${names} — ` +
        `the sale counts ${twins.length + 1} times until the extra card is deleted`;
    } else if (!consumedSave && canSave && c.sale_price !== null && c.sale_price > 0) {
      // A landed save that linked is consumedSave; a PRICED save left over
      // means office/phone/customer on the two cards don't line up (or the
      // original predates the loaded context). Save cards count nowhere on
      // their own, so this money is invisible until the cards match.
      kind = "orphan_save";
      detail =
        "Can/Save with a Sale Price but no matching original sale — the save's money counts nowhere until the office, phone, or customer name lines up";
    } else if (!consumedSave && !canSave && excluded && carriesSale && !dead) {
      // The Garcia/Nielsen/Vroom reloads, the Nguyen $41,000, Maddalena.
      kind = "excluded_sale";
      detail = `"${saleLabel}" on a "${c.iss}" card — counts NOWHERE until the Iss cell is fixed`;
    } else if (
      !consumedSave &&
      !canSave &&
      !excluded &&
      outcome === "sold" &&
      reps.length === 0 &&
      reportReps.length === 0
    ) {
      // Report reps count as credit too — a card the Sales-Report pass
      // stamped is a rep_mismatch below, not an uncredited sale.
      kind = "no_reps";
      detail = `${saleLabel || "Sale"} with no reps — the money counts for the company, nobody gets credit`;
    } else if (
      !consumedSave &&
      !canSave &&
      !excluded &&
      outcome === "sold" &&
      c.sale_price === null &&
      !savePriced
    ) {
      // The Adams $27,500 and Washington $780 — blank counts as $0.
      kind = "blank_price";
      detail = `${saleLabel || "Sale"} with a blank Sale Price — counting as $0`;
    } else if (
      !consumedSave &&
      !canSave &&
      // Mirror the aggregate's gate exactly: an excluded card still counts
      // (and still routes volume through report_reps) when the report
      // stamped it dead — so the drift must stay visible there too.
      (!excluded || dead) &&
      (outcome === "sold" || outcome === "cancelled") &&
      reportReps.length > 0 &&
      !sameRepSet(reportReps, reps) &&
      // A report row that merely ADDS names is the office paying a saver
      // (owner, 2026-09-02 — Hagmann/Pinel: sold, cancelled, rescued by
      // Jonathan Paz, and the report pair IS the 50/50 save split). The
      // board is already right — the saver earns volume, never a result —
      // so "add him to the Block card" would mint a Sold he didn't close.
      !reportOnlyAdds(reportReps, reps)
    ) {
      // The boards CONTRADICT each other: a Block rep the report dropped or
      // replaced, or a report crediting a card whose Reps cell is empty.
      // Volume already follows the report (volumeReps); result credit
      // follows the card — someone has it wrong, so surface it.
      kind = "rep_mismatch";
      detail =
        `Sales Report credits ${reportReps.join(", ")}; the Block card's Reps say ` +
        `${reps.join(", ") || "nobody"} — volume follows the report, result credit follows the card; make the boards agree`;
    } else if (
      !excluded &&
      !isOfficeAppt(c) &&
      outcome === "unmarked" &&
      !canSave &&
      inWeekdayGroup &&
      c.card_date !== null &&
      c.card_date < todayISO
    ) {
      // Yesterday-or-older appointment with nothing marked: counts nowhere.
      // Today's cards get a pass (reps are still out running them), and so
      // do Can/Save cards — an unpriced save is a FAILED save, not a gap.
      // Non-weekday-group cards fall through to the group flag instead: their
      // card_date is a drifting sync-time guess, so "yesterday" proves
      // nothing and the real fix is filing the card, not marking a result.
      kind = "unresolved";
      detail = "no result marked yet — not counting anywhere";
    } else if (!inWeekdayGroup && c.group_title !== null) {
      // "Needs Assignment" and friends: the card's date is a guess that
      // drifts to "today" on every sync until it gets a weekday group.
      kind = "no_weekday_group";
      detail = `group "${c.group_title}" isn't a weekday — its date drifts until the card is filed`;
    }
    if (!kind) continue;
    items.push({
      kind,
      monday_item_id: c.monday_item_id,
      lead_name: c.lead_name,
      office_location: c.office_location,
      card_date: c.card_date,
      reps,
      detail,
    });
  }
  const rank: Record<AttentionKind, number> = {
    duplicate_sale: 0,
    excluded_sale: 1,
    orphan_save: 2,
    no_reps: 3,
    blank_price: 4,
    rep_mismatch: 5,
    unresolved: 6,
    no_weekday_group: 7,
  };
  items.sort(
    (a, b) =>
      rank[a.kind] - rank[b.kind] ||
      (a.card_date ?? "").localeCompare(b.card_date ?? "") ||
      (a.lead_name ?? "").localeCompare(b.lead_name ?? ""),
  );
  return items;
}
