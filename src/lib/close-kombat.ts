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
//   money still lands in revenue.
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
};

/** Sale-column values that mean sold — keep in sync with SOLD_VALUES in
 *  supabase/functions/monday-live-dispatch/index.ts. */
export const SOLD_VALUES = ["sold", "reload", "upsell", "sale"] as const;

export type CardOutcome = "sold" | "pm" | "reset" | "no_show" | "no_demo" | "unmarked";

const marked = (v: string | null | undefined): boolean => !!v && v.trim() !== "";

/** ONE outcome per card: Sold > PM > Reset > BO. The BO column's own label
 *  splits No Show vs No Demo ("No Show" text → no_show, anything else
 *  marked → no_demo). Unmarked = the appointment hasn't resolved yet. */
export function cardOutcome(c: Pick<BlockCard, "bo" | "rs" | "pm" | "sale">): CardOutcome {
  const sale = (c.sale ?? "").trim().toLowerCase();
  if ((SOLD_VALUES as readonly string[]).includes(sale)) return "sold";
  if (marked(c.pm)) return "pm";
  if (marked(c.rs)) return "reset";
  if (marked(c.bo)) return /no\s*show/i.test(c.bo as string) ? "no_show" : "no_demo";
  return "unmarked";
}

/** Office Appointment per the Iss column (label truncates to "Office A…" on
 *  the board, so match any "office" variant). Blank or "Iss" = issued lead —
 *  only an explicit office mark pulls a card out of the lead numbers. */
export function isOfficeAppt(c: Pick<BlockCard, "iss">): boolean {
  return /office/i.test(c.iss ?? "");
}

export type RepStats = {
  rep: string;
  /** Issued leads only — Office Appointments never count here. */
  appts: number;
  noShow: number;
  noDemo: number;
  reset: number;
  pm: number;
  sold: number;
  ol: number;
  unmarked: number;
  /** Office Appointments (job visit / upsale / check pickup) — not leads. */
  officeAppts: number;
  /** Sold ÷ (Sold + PM) — sold share of demos that ran; null until a demo exists. */
  closePct: number | null;
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
  ol: 0,
  unmarked: 0,
  officeAppts: 0,
  closePct: null,
  revenue: 0,
});

const OUTCOME_KEY: Record<Exclude<CardOutcome, "unmarked">, keyof KombatTotals> = {
  sold: "sold",
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
    const office = isOfficeAppt(c);
    if (office) {
      // Not a lead: only the office tally — never appts/results/close %.
      s.officeAppts += 1;
    } else {
      s.appts += 1;
      if (outcome === "unmarked") s.unmarked += 1;
      else s[OUTCOME_KEY[outcome]] += 1;
      if (marked(c.ol)) s.ol += 1;
    }
    // Money is money — an office-appt upsale still pays.
    if (outcome === "sold") s.revenue += (c.sale_price ?? 0) * revenueShare;
  };

  for (const card of cards) {
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

  const finalize = (s: Omit<RepStats, "rep">) => {
    const demos = s.sold + s.pm;
    s.closePct = demos > 0 ? s.sold / demos : null;
    s.revenue = Math.round(s.revenue * 100) / 100;
  };
  finalize(totals);

  const reps = [...byRep.values()];
  for (const r of reps) finalize(r);
  reps.sort(
    (a, b) =>
      b.sold - a.sold || b.revenue - a.revenue || b.appts - a.appts || a.rep.localeCompare(b.rep),
  );
  return { reps, totals };
}
