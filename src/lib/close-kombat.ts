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
//   Sold and Revenue and moves to its own Cancels bucket — net numbers, not
//   gross. Owner, 2026-07-30: a cancel is NOT a demo — Sit % counts only
//   PM + Sold, so a cancelled sale leaves the Sit % numerator and the
//   Close % denominator entirely. It stays an Appt.
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
// - OL (owner, 2026-07-30): dropped from Close Kombat entirely. The column
//   still lands in block_cards, it just isn't a stat here any more.
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
};

/** Sale-column values that mean sold — keep in sync with SOLD_VALUES in
 *  supabase/functions/monday-live-dispatch/index.ts. */
export const SOLD_VALUES = ["sold", "reload", "upsell", "sale"] as const;

export type CardOutcome =
  "sold" | "cancelled" | "pm" | "reset" | "no_show" | "no_demo" | "unmarked";

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

/** ONE outcome per card: Cancelled/CTC > FTD > Sold > PM > Reset > BO. A WCC
 *  cancel wins even when the card's Sale cell is empty — when a sale cancels the
 *  office usually reverts the Block board's Sale column too, but the Sales
 *  Report row proves the sale happened and died. FTD keeps its slot in the
 *  order (it must outrank a leftover "Sold" cell) but resolves to a PM. The BO
 *  column's own label splits No Show vs No Demo ("No Show" text → no_show,
 *  anything else marked → no_demo). Unmarked = hasn't resolved yet. */
export function cardOutcome(c: Pick<BlockCard, "bo" | "rs" | "pm" | "sale" | "wcc">): CardOutcome {
  if (isCancelLabel(c.wcc)) return "cancelled";
  if (isFtdLabel(c.wcc)) return "pm";
  const sale = (c.sale ?? "").trim().toLowerCase();
  if ((SOLD_VALUES as readonly string[]).includes(sale)) return "sold";
  if (marked(c.pm)) return "pm";
  if (marked(c.rs)) return "reset";
  if (marked(c.bo)) return /no\s*show/i.test(c.bo as string) ? "no_show" : "no_demo";
  return "unmarked";
}

/** An active Reload sale (owner, 2026-07-30: its own sales channel, outside
 *  the lead funnel — counted in Reload and Revenue, never in Appts or any
 *  lead percentage). A cancelled reload is a Cancel, not a reload. */
export function isReload(c: Pick<BlockCard, "sale" | "wcc">): boolean {
  return (
    cardOutcome({ bo: null, rs: null, pm: null, sale: c.sale, wcc: c.wcc }) === "sold" &&
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

export type RepStats = {
  rep: string;
  /** RESULTED leads only — a card with nothing marked yet isn't an appt, and
   *  neither Office Appointments nor reloads count here (owner, 2026-07-30).
   *  noShow + noDemo + reset + pm + sold + cancels always equals this. */
  appts: number;
  noShow: number;
  noDemo: number;
  reset: number;
  pm: number;
  sold: number;
  /** Reload sales — their own channel, NOT inside sold and NOT inside appts
   *  (owner, 2026-07-30): a reload is a re-sale to an existing customer, so
   *  no lead was issued for it. Counted even when the Iss cell says "Office
   *  Appt", which it almost always does. Money still counts in Revenue. */
  reloads: number;
  /** Sales later cancelled on the monthly report (Cancelled / CTC) — out of
   *  Sold and Revenue, and NOT a demo (owner, 2026-07-30), so they sit
   *  outside Sit % and Close % while still counting as an Appt. */
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
  /** Cancels ÷ (Sold + Cancels) — share of written LEAD sales that later
   *  died on the Sales Report; null until a sale was written. */
  cancelPct: number | null;
  /** Appts ÷ Sold (owner, 2026-07-30) — leads needed per lead-sourced sale,
   *  rendered as a plain number (4.5), not a percentage. Reloads are excluded
   *  from both sides: no lead was spent to get one. Null until a sale exists,
   *  since dividing by zero sales is meaningless rather than zero. */
  leadsToSale: number | null;
  /** Sale volume: split evenly across the card's reps; includes office-appt upsales. */
  revenue: number;
};

export type KombatTotals = Omit<RepStats, "rep">;

const emptyStats = (): Omit<RepStats, "rep"> => ({
  appts: 0,
  noShow: 0,
  noDemo: 0,
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
  cancelPct: null,
  leadsToSale: null,
  revenue: 0,
});

const OUTCOME_KEY: Record<Exclude<CardOutcome, "unmarked">, keyof KombatTotals> = {
  sold: "sold",
  cancelled: "cancels",
  pm: "pm",
  reset: "reset",
  no_show: "noShow",
  no_demo: "noDemo",
};

export function aggregateCloseKombat(cards: BlockCard[]): {
  reps: RepStats[];
  totals: KombatTotals;
} {
  const byRep = new Map<string, RepStats>();
  const totals: KombatTotals = emptyStats();

  /** countWeight: 1 for rep rows AND totals (full credit each, owner rule).
   *  revenueShare: rep rows get price ÷ rep-count; totals pass 1 (whole card). */
  const bump = (s: Omit<RepStats, "rep">, c: BlockCard, revenueShare: number) => {
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
    } else if (outcome === "unmarked") {
      // No result on the board yet: not an appt at all (owner, 2026-07-30) —
      // internal tally only, the card joins the stats once it's resulted.
      s.unmarked += 1;
    } else {
      s.appts += 1;
      s[OUTCOME_KEY[outcome]] += 1;
    }
    // Money is money — an office-appt upsale still pays. A blank Sale Price
    // on the Block board is $0, full stop (owner, 2026-07-30): never infer a
    // price from another source, never guess. Nothing else may write
    // sale_price either — see the Sales-Report pass in block-cards.server.ts.
    if (outcome === "sold") s.revenue += (c.sale_price ?? 0) * revenueShare;
  };

  for (const card of cards) {
    // CTC / Not Issued / Add Rep never reach the stats at all — UNLESS the
    // monthly report stamped the card dead (Cancelled/CTC/FTD): the office
    // often flips a dead sale's Iss cell to "CTC" too, and the report proves
    // an issued lead ran and sold, so it must count as an appt.
    if (isExcludedCard(card) && !isCancelLabel(card.wcc) && !isFtdLabel(card.wcc)) continue;
    // Totals count every card exactly once — reps.length never inflates them.
    bump(totals, card, 1);
    const names = card.reps.map((r) => r.trim()).filter(Boolean);
    const share = names.length > 0 ? 1 / names.length : 1;
    for (const name of names) {
      let s = byRep.get(name);
      if (!s) {
        s = { rep: name, ...emptyStats() };
        byRep.set(name, s);
      }
      bump(s, card, share);
    }
  }

  /** Owner's formulas, 2026-07-30. A demo is PM + Sold + Reload: a cancelled
   *  sale is deliberately NOT one, so it never lands in Sit % or Close %.
   *  Every ratio is null (renders "—") rather than 0 when its denominator is
   *  empty — "no sales yet" and "0%" are different claims. */
  const finalize = (s: Omit<RepStats, "rep">) => {
    // Lead funnel: demos and sales that came from an issued lead. Reloads are
    // excluded on purpose (owner, 2026-07-30) — counting a re-sale to an
    // existing customer as a lead demo would flatter every lead percentage.
    const demos = s.pm + s.sold;
    const written = s.sold + s.cancels;
    // Both channels together — the only place a reload belongs.
    const sales = s.sold + s.reloads;
    s.sitPct = s.appts > 0 ? demos / s.appts : null;
    s.closePct = demos > 0 ? s.sold / demos : null;
    s.resetPct = s.appts > 0 ? s.reset / s.appts : null;
    s.noDemoPct = s.appts > 0 ? s.noDemo / s.appts : null;
    s.noShowPct = s.appts > 0 ? s.noShow / s.appts : null;
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
  // Rank by total sales (Sold + Reload) so the split doesn't reshuffle the
  // bracket — a reload win is still a win.
  reps.sort(
    (a, b) =>
      b.sold + b.reloads - (a.sold + a.reloads) ||
      b.revenue - a.revenue ||
      b.appts - a.appts ||
      a.rep.localeCompare(b.rep),
  );
  return { reps, totals };
}
