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

export type RepStats = {
  rep: string;
  /** RESULTED leads only — a card with nothing marked yet isn't an appt, and
   *  neither Office Appointments nor reloads count here (owner, 2026-07-30).
   *  noShow + noDemo + reset + pm + sold always equals this. */
  appts: number;
  noShow: number;
  noDemo: number;
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
   *  Sold and Revenue. A TALLY, not a bucket: each one is already counted in
   *  `pm` (owner, 2026-07-30 — the demo ran), so never add this to the
   *  result columns or Appts will double-count. */
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
        saverReps: s.reps.map((r) => r.trim()).filter(Boolean),
        saveDate: s.card_date ?? "",
      });
    }
    consumed.add(s.monday_item_id);
  }
  return { effects, consumed };
}

export function aggregateCloseKombat(cards: BlockCard[]): {
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
    const names = card.reps.map((r) => r.trim()).filter(Boolean);
    for (const name of names) bump(repRow(name), card);

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
    // Result credit stays with the card's own reps: the saver earns volume,
    // not a Sold.
    if (cardOutcome(card) === "sold") {
      totals.revenue += save ? save.price : (card.sale_price ?? 0);
      if (save) {
        const savers = [...new Set(save.saverReps)];
        // No saver names on the save card: nobody to pay the save half to —
        // the originals split the whole re-priced deal instead.
        const saverPool = savers.length > 0 ? save.price / 2 : 0;
        const originalPool = save.price - saverPool;
        for (const name of savers) repRow(name).revenue += saverPool / savers.length;
        // No original reps recorded: their half stays uncredited (company
        // totals keep the whole price) — never invent a recipient.
        for (const name of names) repRow(name).revenue += originalPool / names.length;
      } else {
        const price = card.sale_price ?? 0;
        for (const name of names) repRow(name).revenue += price / names.length;
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
