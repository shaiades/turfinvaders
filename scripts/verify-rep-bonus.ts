// Double Up / Triple Up verification suite — every bonus rule as an
// executable check. Run:  npm run verify:rep-bonus
// Pure module in, assertions out — no network, no database, no browser.
//
// Rules (owner 2026-11-03): 2+ jobs in a day ≥ $20k combined → $500 Double
// Up; 3+ jobs ≥ $30k → $1,000 Triple Up INSTEAD (best tier only); below the
// threshold nothing pays. Shared cards count as a job for each rep at the
// rep's split share. Reloads/upsells count. Bonuses stay pending until the
// month-end cancel window passes, then lock.

import {
  BONUS_TIERS,
  bonusFinalizeAfterISO,
  bonusTierFor,
  buildRepDayBonuses,
  type RepDayBonusCandidate,
} from "../src/lib/rep-bonus";
import type { BlockCard } from "../src/lib/close-kombat";

const fails: string[] = [];
const eq = (label: string, got: unknown, want: unknown) => {
  const ok = Math.abs(Number(got ?? NaN) - Number(want ?? NaN)) < 1e-9 || got === want;
  if (!ok) fails.push(`${label}: got ${String(got)}, want ${String(want)}`);
};

let n = 0;
const card = (over: Partial<BlockCard>): BlockCard => ({
  monday_item_id: `c${n++}`,
  board_id: "b",
  office_location: "San Diego",
  card_date: "2026-11-02",
  group_title: null,
  lead_name: `lead ${n}`,
  reps: ["Rep A"],
  iss: "Iss",
  bo: null,
  ol: null,
  rs: null,
  pm: null,
  sale: "Sold",
  sale_price: null,
  products: null,
  canvass_stats: null,
  source: null,
  agent: null,
  wcc: null,
  comments: null,
  phone: null,
  report_reps: null,
  ...over,
});

const MID = "2026-11-10"; // mid-month: cancel window still open → pending
const WINDOW = 3; // cancel_window_days knob (Kombat default)

const run = (cards: BlockCard[], today = MID): RepDayBonusCandidate[] =>
  buildRepDayBonuses(cards, today, WINDOW);
const forRep = (out: RepDayBonusCandidate[], rep: string, date = "2026-11-02") =>
  out.find((b) => b.rep_name === rep && b.bonus_date === date);

// ── Tier table sanity ───────────────────────────────────────────────────────
eq("tiers: triple first", BONUS_TIERS[0].tier, "triple");
eq("tierFor: 2 jobs $20k → double", bonusTierFor(2, 20_000)?.tier, "double");
eq("tierFor: 2 jobs $19,999 → none", bonusTierFor(2, 19_999), null);
eq("tierFor: 3 jobs $30k → triple", bonusTierFor(3, 30_000)?.tier, "triple");
eq("tierFor: 3 jobs $29,999 → double (fallback)", bonusTierFor(3, 29_999)?.tier, "double");
eq("tierFor: 1 job $50k → none (needs 2 jobs)", bonusTierFor(1, 50_000), null);
eq("tierFor: 4 jobs $35k → triple, never both", bonusTierFor(4, 35_000)?.amount, 1_000);

// ── Double Up: 2 jobs, $20k combined ────────────────────────────────────────
{
  const out = run([card({ sale_price: 12_000 }), card({ sale_price: 8_000 })]);
  const b = forRep(out, "Rep A");
  eq("double: minted", b?.tier, "double");
  eq("double: $500", b?.amount, 500);
  eq("double: 2 jobs", b?.job_count, 2);
  eq("double: $20k volume", b?.volume, 20_000);
  eq("double: pending mid-month", b?.status, "pending");
  eq("double: jobs snapshot has both", b?.jobs.length, 2);
}

// ── Triple Up replaces, never stacks ────────────────────────────────────────
{
  const out = run([
    card({ sale_price: 12_000 }),
    card({ sale_price: 10_000 }),
    card({ sale_price: 8_000 }),
  ]);
  eq("triple: one row only", out.length, 1);
  const b = forRep(out, "Rep A");
  eq("triple: tier", b?.tier, "triple");
  eq("triple: $1,000 total (not $1,500)", b?.amount, 1_000);
}

// ── Below threshold: nothing pays ───────────────────────────────────────────
eq(
  "2 jobs $19,999 → no bonus",
  run([card({ sale_price: 10_000 }), card({ sale_price: 9_999 })]).length,
  0,
);
{
  // 3 jobs ≥$20k <$30k → the DOUBLE still pays (tier fallback).
  const b = forRep(
    run([card({ sale_price: 10_000 }), card({ sale_price: 10_000 }), card({ sale_price: 5_000 })]),
    "Rep A",
  );
  eq("3 jobs $25k → double fallback", b?.tier, "double");
  eq("3 jobs $25k → counts all 3 jobs", b?.job_count, 3);
}

// ── Shared card: 1 job each, split dollars ──────────────────────────────────
{
  // Card 1 $24k shared (12k each). Rep A also sells $8k solo → 2 jobs, $20k
  // → double. Rep B has only the shared job → 1 job, no bonus.
  const out = run([
    card({ reps: ["Rep A", "Rep B"], sale_price: 24_000 }),
    card({ sale_price: 8_000 }),
  ]);
  const a = forRep(out, "Rep A");
  eq("shared: Rep A doubles on split share", a?.tier, "double");
  eq("shared: Rep A volume 12k+8k", a?.volume, 20_000);
  eq("shared: Rep B under 2 jobs → nothing", forRep(out, "Rep B"), undefined);
}
{
  // Shared volume is the SPLIT share, not the full price: two $19k shared
  // cards = 2 jobs but only $19k each rep → no bonus.
  const out = run([
    card({ reps: ["Rep A", "Rep B"], sale_price: 19_000 }),
    card({ reps: ["Rep A", "Rep B"], sale_price: 19_000 }),
  ]);
  eq("shared: split dollars don't fake the threshold", out.length, 0);
}
{
  // report_reps overrides the volume split (owner 2026-08-25).
  const out = run([
    card({ reps: ["Rep A"], report_reps: ["Rep A", "Rep B"], sale_price: 30_000 }),
    card({ sale_price: 5_000 }),
  ]);
  eq("report_reps: Rep A split to $15k+$5k → $20k double", forRep(out, "Rep A")?.tier, "double");
}

// ── Reloads and upsells count ───────────────────────────────────────────────
{
  const out = run([
    card({ sale: "Reload", sale_price: 11_000, iss: "Office Appt" }),
    card({ sale: "Upsell", sale_price: 9_000, iss: "Office Appt" }),
  ]);
  eq("reload+upsell: 2 jobs $20k → double", forRep(out, "Rep A")?.tier, "double");
}

// ── Cancellation breaks the day ─────────────────────────────────────────────
{
  const sold = [card({ sale_price: 12_000 }), card({ sale_price: 8_000 })];
  eq("pre-cancel: double", run(sold).length, 1);
  const cancelled = [sold[0], { ...sold[1], wcc: "Cancelled" }];
  eq("WCC cancel: candidate disappears", run(cancelled).length, 0);
  const ftd = [sold[0], { ...sold[1], wcc: "FTD" }];
  eq("FTD kills the job too", run(ftd).length, 0);
}
{
  // Triple day loses one job to a cancel → downgrades to double.
  const cards = [
    card({ sale_price: 12_000 }),
    card({ sale_price: 10_000 }),
    card({ sale_price: 12_000, wcc: "CTC" }),
  ];
  const b = forRep(run(cards), "Rep A");
  eq("CTC: triple downgrades to double", b?.tier, "double");
  eq("CTC: volume drops to $22k", b?.volume, 22_000);
}

// ── Landed save re-prices on the ORIGINAL date ──────────────────────────────
{
  // Original $37,884 by Rep A on 11/02 cancels; Rep B saves it 11/05 at
  // $27,583 → $13,791.50 each ON 11/02 (the Leon deal, owner 2026-08-01).
  // Each needs a second job that day to double.
  const original = card({
    sale_price: 37_884,
    phone: "619-555-0101",
    wcc: "Cancelled",
    reps: ["Rep A"],
  });
  const save = card({
    card_date: "2026-11-05",
    comments: "Can/Save",
    sale_price: 27_583,
    phone: "619-555-0101",
    reps: ["Rep B"],
    sale: null,
    iss: null,
  });
  const out = run([
    original,
    save,
    card({ sale_price: 7_000, reps: ["Rep A"] }),
    card({ sale_price: 7_000, reps: ["Rep B"] }),
  ]);
  const a = forRep(out, "Rep A");
  const b = forRep(out, "Rep B");
  eq("save: Rep A doubles at 13,791.50+7,000", a?.volume, 20_791.5);
  eq("save: saver's job lands on the ORIGINAL date", b?.bonus_date, "2026-11-02");
  eq("save: Rep B volume", b?.volume, 20_791.5);
  eq("save: job_count counts the original card once", b?.job_count, 2);
  eq("save: no bonus minted on the save's own date", forRep(out, "Rep B", "2026-11-05"), undefined);
  eq(
    "save: card_total is the re-negotiated price",
    a?.jobs.find((j) => j.monday_item_id === original.monday_item_id)?.card_total,
    27_583,
  );
}

// ── Edge cases ──────────────────────────────────────────────────────────────
{
  // $0-price card: a job, but adds no volume.
  const out = run([card({ sale_price: 0 }), card({ sale_price: 20_000 })]);
  const b = forRep(out, "Rep A");
  eq("$0 job: still 2 jobs", b?.job_count, 2);
  eq("$0 job: volume is the other card's", b?.volume, 20_000);
  eq("$0 job: double mints", b?.tier, "double");
}
eq(
  "null card_date: skipped entirely",
  run([card({ card_date: null, sale_price: 15_000 }), card({ sale_price: 15_000 })]).length,
  0,
);
{
  // Same rep, different days — never pooled across days.
  const out = run([
    card({ sale_price: 12_000, card_date: "2026-11-02" }),
    card({ sale_price: 12_000, card_date: "2026-11-03" }),
  ]);
  eq("cross-day: no bonus", out.length, 0);
}
{
  // Case-insensitive rep grouping: "rep a" and "Rep A" are one person.
  const out = run([
    card({ reps: ["Rep A"], sale_price: 12_000 }),
    card({ reps: ["rep a"], sale_price: 8_000 }),
  ]);
  eq("name casing: one bonus", out.length, 1);
  eq("name casing: $20k pooled", out[0]?.volume, 20_000);
}
{
  // Excluded cards (CTC / Not Issued / Add Rep pipeline states) never count.
  const out = run([card({ iss: "Not Issued", sale_price: 12_000 }), card({ sale_price: 12_000 })]);
  eq("excluded card: not a job", out.length, 0);
}

// ── Lock timing: month end + cancel window ──────────────────────────────────
eq("finalize: Nov day locks after Dec 3", bonusFinalizeAfterISO("2026-11-02", 3), "2026-12-03");
{
  const cards = [card({ sale_price: 12_000 }), card({ sale_price: 8_000 })];
  eq("on the finalize day: still pending", run(cards, "2026-12-03")[0]?.status, "pending");
  eq("day after finalize: locked", run(cards, "2026-12-04")[0]?.status, "locked");
  eq("way later: locked", run(cards, "2027-01-15")[0]?.status, "locked");
}

console.log(`checks run, ${fails.length} failure(s)`);
for (const f of fails) console.log("  FAIL " + f);
process.exit(fails.length === 0 ? 0 : 1);
