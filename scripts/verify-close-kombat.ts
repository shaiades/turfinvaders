// Close Kombat verification suite — every owner rule as an executable check.
// Run:  npm run verify:kombat   (or: npx tsx scripts/verify-close-kombat.ts)
//
// This is the suite that guarded the 2026-07/08 rules work: reload channel,
// Cancels-as-PM, Can/Save 50/25/25 splits, blank-price-is-$0, OL-as-result,
// the Needs Attention audit, and the Shark Tank reconciliation invariants.
// Pure module in, assertions out — no network, no database, no browser.
// Exits non-zero on any failure. Extend it whenever a counting rule changes.

import {
  aggregateCloseKombat,
  auditBlockCards,
  cardOutcome,
  chooseReportReps,
  preferAmountMatch,
  type BlockCard,
  type ReportRepHit,
} from "../src/lib/close-kombat";

let n = 0;
const card = (over: Partial<BlockCard>): BlockCard => ({
  monday_item_id: `i${n++}`,
  board_id: "b",
  office_location: "HQ",
  card_date: "2026-07-27",
  group_title: null,
  lead_name: `lead ${n}`,
  reps: ["Rep A"],
  iss: "Iss",
  bo: null,
  ol: null,
  rs: null,
  pm: null,
  sale: null,
  sale_price: null,
  products: null,
  canvass_stats: null,
  wcc: null,
  comments: null,
  phone: null,
  report_reps: null,
  ...over,
});
const many = (c: number, over: Partial<BlockCard>) => Array.from({ length: c }, () => card(over));

const fails: string[] = [];
const eq = (label: string, got: unknown, want: unknown) => {
  const ok = Math.abs(Number(got ?? NaN) - Number(want ?? NaN)) < 1e-9 || got === want;
  if (!ok) fails.push(`${label}: got ${String(got)}, want ${String(want)}`);
};

// ---- 1. Outcome precedence ----------------------------------------------
eq("ftd->pm", cardOutcome({ bo: null, rs: null, pm: null, sale: "Sold", wcc: "FTD" }), "pm");
eq(
  "cancel wins",
  cardOutcome({ bo: null, rs: null, pm: null, sale: "Sold", wcc: "Cancelled" }),
  "cancelled",
);

// ---- 2. THE REGRESSION: an Office-Appt reload must count -----------------
const oneReload = aggregateCloseKombat([
  card({ iss: "Office Appt", sale: "Reload", sale_price: 21176 }),
]);
eq("office-appt reload counts", oneReload.totals.reloads, 1);
eq("...and is not an appt", oneReload.totals.appts, 0);
eq("...and is not an office tally", oneReload.totals.officeAppts, 0);
eq("...money still counts", oneReload.totals.revenue, 21176);
eq("...reload % is 100%", oneReload.totals.reloadPct, 1);
eq("...lead ratios stay null", oneReload.totals.sitPct, null);
eq("...close % stays null", oneReload.totals.closePct, null);
eq("...leads/sale stays null", oneReload.totals.leadsToSale, null);
eq("...rep row survives", oneReload.reps.length, 1);
// A $0 reload must still surface its rep (the old filter needed revenue > 0).
const freeReload = aggregateCloseKombat([
  card({ iss: "Office Appt", sale: "Reload", sale_price: null }),
]);
eq("$0 reload still lists the rep", freeReload.reps.length, 1);
eq("$0 reload counts", freeReload.totals.reloads, 1);

// A non-office reload is still a reload, still not an appt.
const leadReload = aggregateCloseKombat([card({ iss: "Iss", sale: "Reload", sale_price: 500 })]);
eq("lead-marked reload counts", leadReload.totals.reloads, 1);
eq("lead-marked reload is not an appt", leadReload.totals.appts, 0);

// A cancelled reload is a cancel, never a reload.
const deadReload = aggregateCloseKombat([
  card({ iss: "Iss", sale: "Reload", sale_price: 9999, wcc: "Cancelled" }),
]);
eq("cancelled reload isn't a reload", deadReload.totals.reloads, 0);
eq("cancelled reload pays nothing", deadReload.totals.revenue, 0);

// ---- 3. Full sweep on a hand-countable set -------------------------------
// Lead funnel: 10 no show, 8 no demo, 6 reset, 4 pm, 2 ftd(->pm), 5 sold, 2 cancels
// Separate channel: 3 reloads (office-marked, as they are in real data)
const cards: BlockCard[] = [
  ...many(10, { bo: "No Show" }),
  ...many(8, { bo: "No Demo" }),
  ...many(6, { rs: "Reset" }),
  ...many(4, { pm: "PM" }),
  ...many(2, { sale: "Sold", wcc: "FTD" }),
  ...many(5, { sale: "Sold", sale_price: 1000 }),
  ...many(2, { sale: "Sold", sale_price: 9999, wcc: "Cancelled" }),
  ...many(3, { iss: "Office Appt", sale: "Reload", sale_price: 500 }),
  ...many(3, {}), // unmarked
  ...many(2, { iss: "Office Appt", sale: "Upsell", sale_price: 700 }), // upsell, not a reload
  ...many(1, { iss: "Not Issued", sale: "Sold", sale_price: 5000 }), // excluded entirely
];
const { totals } = aggregateCloseKombat(cards);

const appts = 10 + 8 + 6 + 4 + 2 + 5 + 2; // 37 — reloads excluded
const demos = 4 + 2 + 2 + 5; // pm + ftd + cancels + sold = 13
const sales = 5 + 3; // sold + reloads = 8

eq("appts excludes reloads", totals.appts, appts);
eq("noShow", totals.noShow, 10);
eq("noDemo", totals.noDemo, 8);
eq("reset", totals.reset, 6);
eq("pm (incl. 2 FTD + 2 cancels)", totals.pm, 8);
eq("sold", totals.sold, 5);
eq("reloads", totals.reloads, 3);
eq("cancels", totals.cancels, 2);
eq("officeAppts = upsells only", totals.officeAppts, 2);
eq(
  "lead parts sum to appts (cancels live in pm)",
  totals.noShow + totals.noDemo + totals.reset + totals.pm + totals.sold,
  appts,
);

eq("sitPct = (PM+Sold)/Appts, cancels included via PM", totals.sitPct, demos / appts);
eq("noShowPct", totals.noShowPct, 10 / appts);
eq("noDemoPct", totals.noDemoPct, 8 / appts);
eq("resetPct", totals.resetPct, 6 / appts);
eq("closePct = Sold/(PM+Sold)", totals.closePct, 5 / demos);
eq("reloadPct = Reload/(Sold+Reload)", totals.reloadPct, 3 / sales);
eq("cancelPct = Cancels/(Sold+Cancels)", totals.cancelPct, 2 / (5 + 2));
eq("leadsToSale = Appts/Sold", totals.leadsToSale, appts / 5);
// 5 sold + 3 reloads + 2 upsells; cancels and the Not-Issued card pay nothing
eq("revenue", totals.revenue, 5000 + 1500 + 1400);

// Reloads must not leak into any lead percentage.
eq("sitPct <= 1", totals.sitPct! <= 1, true);
eq("closePct <= 1", totals.closePct! <= 1, true);

// ---- 4. Blank Sale Price is $0 ------------------------------------------
const blank = aggregateCloseKombat([
  card({ sale: "Sold", sale_price: null }),
  card({ iss: "Office Appt", sale: "Reload", sale_price: null }),
]);
eq("blank price = $0", blank.totals.revenue, 0);
eq("blank price still counts the sale", blank.totals.sold, 1);
eq("blank price still counts the reload", blank.totals.reloads, 1);

// ---- 5. Empty denominators render null, not 0 ---------------------------
const noSales = aggregateCloseKombat(many(4, { bo: "No Show" }));
eq("closePct null w/o demos", noSales.totals.closePct, null);
eq("reloadPct null w/o sales", noSales.totals.reloadPct, null);
eq("cancelPct null w/o writes", noSales.totals.cancelPct, null);
eq("leadsToSale null w/o sales", noSales.totals.leadsToSale, null);
eq("noShowPct is 100%", noSales.totals.noShowPct, 1);

// ---- 6. Shared card: full result credit, split volume -------------------
const shared = aggregateCloseKombat([
  card({ iss: "Office Appt", sale: "Reload", sale_price: 9000, reps: ["A", "B"] }),
]);
eq("totals count the reload once", shared.totals.reloads, 1);
eq("totals keep whole volume", shared.totals.revenue, 9000);
eq(
  "each rep full reload credit",
  shared.reps.every((r) => r.reloads === 1),
  true,
);
eq("volume splits", shared.reps[0].revenue, 4500);

// ---- 7. Owner's worked example: 5 PM + 2 sales, 1 cancels -> 6 PM, 1 sale, 7 sits
const worked = aggregateCloseKombat([
  ...many(5, { pm: "PM" }),
  ...many(1, { sale: "Sold", sale_price: 1000 }),
  ...many(1, { sale: "Sold", sale_price: 5000, wcc: "Cancelled" }),
]);
eq("worked: pm becomes 6", worked.totals.pm, 6);
eq("worked: sold becomes 1", worked.totals.sold, 1);
eq("worked: cancels tallied", worked.totals.cancels, 1);
eq("worked: appts still 7", worked.totals.appts, 7);
eq("worked: 7 sits", worked.totals.pm + worked.totals.sold, 7);
eq("worked: sit % is 100%", worked.totals.sitPct, 1);
eq("worked: close % is 1/7", worked.totals.closePct, 1 / 7);
eq("worked: cancelled sale pays nothing", worked.totals.revenue, 1000);

// ---- 8. Standings rank by sale volume, highest first ---------------------
const ranked = aggregateCloseKombat([
  // Fewer sales but far more volume — must outrank the higher sale count.
  card({ lead_name: "big", reps: ["Volume Vic"], sale: "Sold", sale_price: 90000 }),
  card({ lead_name: "s1", reps: ["Count Carl"], sale: "Sold", sale_price: 1000 }),
  card({ lead_name: "s2", reps: ["Count Carl"], sale: "Sold", sale_price: 1000 }),
  card({ lead_name: "s3", reps: ["Count Carl"], sale: "Sold", sale_price: 1000 }),
]);
eq("top rep is highest volume", ranked.reps[0]?.rep, "Volume Vic");
eq("second is the higher count", ranked.reps[1]?.rep, "Count Carl");
eq("descending volume", ranked.reps[0].revenue > ranked.reps[1].revenue, true);

// ---- 9. Can/Save (owner, 2026-08-01) -------------------------------------
// THE REAL LEON CASE: Josh sold $37,884 on 7/6; the wife killed it; Bergan
// saved it 7/8 at $27,583. Save card: Office Appt, "Can/Save" in comments,
// price but NO Sale label, phone in a different format than the original.
const leon = () => [
  card({
    monday_item_id: "orig-leon",
    lead_name: "Darren and Angela Leon (copy)",
    card_date: "2026-07-06",
    reps: ["Josh OConnor"],
    sale: "Sold",
    sale_price: 37884,
    phone: "15623805392",
  }),
  card({
    monday_item_id: "save-leon",
    lead_name: "Leon, Darren & Angela",
    card_date: "2026-07-08",
    reps: ["Bergan Lundak"],
    iss: "Office Appt",
    sale_price: 27583,
    phone: "+1 (562) 380-5392",
    comments: "9am Can/Save\n\nSold\nReps: Josh OConnor,\nSale Price: 37884",
  }),
];
const saved = aggregateCloseKombat(leon());
eq("save: revenue = save price, once", saved.totals.revenue, 27583);
eq("save: still one sold", saved.totals.sold, 1);
eq("save: still one appt", saved.totals.appts, 1);
eq("save: no office tally for the save card", saved.totals.officeAppts, 0);
const josh = saved.reps.find((r) => r.rep === "Josh OConnor");
const bergan = saved.reps.find((r) => r.rep === "Bergan Lundak");
eq("save: Josh gets half", josh?.revenue, 13791.5);
eq("save: Josh keeps the Sold", josh?.sold, 1);
eq("save: Bergan gets half", bergan?.revenue, 13791.5);
eq("save: Bergan gets volume, not a Sold", bergan?.sold, 0);
eq("save: Bergan is not an appt", bergan?.appts, 0);

// Two sellers + a saver -> 50% to the saver, 25% to each seller
// (owner, 2026-08-01: "50% to the person who saved it and 25% to each").
const quartered = aggregateCloseKombat([
  card({
    monday_item_id: "o3",
    lead_name: "Big Deal",
    card_date: "2026-07-06",
    reps: ["A", "B"],
    sale: "Sold",
    sale_price: 30000,
    phone: "6191112222",
  }),
  card({
    monday_item_id: "s3",
    lead_name: "Deal, Big",
    card_date: "2026-07-08",
    reps: ["C"],
    iss: "Office Appt",
    sale_price: 21000,
    phone: "6191112222",
    comments: "Can/Save",
  }),
]);
eq("50/25/25: revenue is the save price", quartered.totals.revenue, 21000);
eq("50/25/25: saver gets half", quartered.reps.find((r) => r.rep === "C")?.revenue, 10500);
eq("50/25/25: seller A gets a quarter", quartered.reps.find((r) => r.rep === "A")?.revenue, 5250);
eq("50/25/25: seller B gets a quarter", quartered.reps.find((r) => r.rep === "B")?.revenue, 5250);
eq(
  "50/25/25: shares sum to the price",
  quartered.reps.reduce((s, r) => s + r.revenue, 0),
  21000,
);

// A seller who saves their own two-rep job earns both shares: 50% + 25%.
const dualRole = aggregateCloseKombat([
  card({
    monday_item_id: "od",
    lead_name: "Dual, Role",
    card_date: "2026-07-06",
    reps: ["A", "B"],
    sale: "Sold",
    sale_price: 40000,
    phone: "6194445555",
  }),
  card({
    monday_item_id: "sd",
    lead_name: "Role, Dual",
    card_date: "2026-07-08",
    reps: ["A"],
    iss: "Office Appt",
    sale_price: 20000,
    phone: "6194445555",
    comments: "Can/Save",
  }),
]);
eq("dual role: saver-seller gets 75%", dualRole.reps.find((r) => r.rep === "A")?.revenue, 15000);
eq("dual role: other seller gets 25%", dualRole.reps.find((r) => r.rep === "B")?.revenue, 5000);

// Save card with no reps recorded: originals split the whole re-priced deal.
const noSaver = aggregateCloseKombat([
  card({
    monday_item_id: "ons",
    lead_name: "No, Saver",
    card_date: "2026-07-06",
    reps: ["A", "B"],
    sale: "Sold",
    sale_price: 30000,
    phone: "6196667777",
  }),
  card({
    monday_item_id: "sns",
    lead_name: "Saver, No",
    card_date: "2026-07-08",
    reps: [],
    iss: "Office Appt",
    sale_price: 20000,
    phone: "6196667777",
    comments: "Can/Save",
  }),
]);
eq(
  "no saver: originals split whole price",
  noSaver.reps.find((r) => r.rep === "A")?.revenue,
  10000,
);
eq("no saver: totals whole price", noSaver.totals.revenue, 20000);

// Original with no reps: the saver's 50% pays out, the sellers' half stays
// uncredited — company totals still carry the whole price.
const noSellers = aggregateCloseKombat([
  card({
    monday_item_id: "one",
    lead_name: "No, Sellers",
    card_date: "2026-07-06",
    reps: [],
    sale: "Sold",
    sale_price: 30000,
    phone: "6198889999",
  }),
  card({
    monday_item_id: "sne",
    lead_name: "Sellers, No",
    card_date: "2026-07-08",
    reps: ["C"],
    iss: "Office Appt",
    sale_price: 20000,
    phone: "6198889999",
    comments: "Can/Save",
  }),
]);
eq(
  "no sellers: saver gets exactly half",
  noSellers.reps.find((r) => r.rep === "C")?.revenue,
  10000,
);
eq("no sellers: totals still whole price", noSellers.totals.revenue, 20000);

// Failed save (no price): nothing changes; the cancel stands.
const failed = aggregateCloseKombat([
  card({
    monday_item_id: "of",
    lead_name: "Newsom, Brian & Lorena",
    card_date: "2026-07-10",
    reps: ["Yakup"],
    sale: "Sold",
    sale_price: 22500,
    wcc: "Cancelled",
    phone: "6193334444",
  }),
  card({
    monday_item_id: "sf",
    lead_name: "Newsom, Brian & Lorena",
    card_date: "2026-07-15",
    reps: ["Jonathan Paz"],
    iss: "Office Appt",
    sale_price: null,
    phone: "6193334444",
    comments: "Can/Save",
  }),
]);
eq("failed save: no revenue", failed.totals.revenue, 0);
eq("failed save: cancel stands", failed.totals.cancels, 1);
eq(
  "failed save: saver earns nothing",
  failed.reps.find((r) => r.rep === "Jonathan Paz"),
  undefined,
);
// Owner, 2026-08-28: a save card counts NOWHERE on its own — not even the
// office tally its "Office Appt" Iss cell used to earn it.
eq("failed save: save card counts nowhere", failed.totals.officeAppts, 0);

// A failed save the office RESULTED (Iss left as an issued lead, PM marked
// on the save card) must not become a second issued lead — the lead was
// already counted on the original card (owner, 2026-08-28).
const failedResulted = aggregateCloseKombat([
  card({
    monday_item_id: "ofr",
    lead_name: "Newsom, Brian & Lorena",
    card_date: "2026-07-10",
    reps: ["Yakup"],
    sale: "Sold",
    sale_price: 22500,
    wcc: "Cancelled",
    phone: "6193334444",
  }),
  card({
    monday_item_id: "sfr",
    lead_name: "Newsom, Brian & Lorena",
    card_date: "2026-07-15",
    reps: ["Jonathan Paz"],
    pm: "PM",
    sale_price: null,
    phone: "6193334444",
    comments: "Can/Save",
  }),
]);
eq("resulted failed save: only the original is an appt", failedResulted.totals.appts, 1);
eq(
  "resulted failed save: saver gets no row",
  failedResulted.reps.find((r) => r.rep === "Jonathan Paz"),
  undefined,
);

// An unlinked save marked Sold must not become a phantom sale for the saver.
const phantom = aggregateCloseKombat([
  card({
    monday_item_id: "sph",
    lead_name: "Ghost, Deal",
    card_date: "2026-07-08",
    reps: ["B"],
    sale: "Sold",
    sale_price: 27583,
    phone: "5551112222",
    comments: "Can/Save",
  }),
]);
eq("phantom save: no sold", phantom.totals.sold, 0);
eq("phantom save: no appt", phantom.totals.appts, 0);
eq("phantom save: no revenue", phantom.totals.revenue, 0);

// A landed save supersedes a stale Cancelled stamp on the original.
const revived = aggregateCloseKombat([
  card({
    monday_item_id: "or",
    lead_name: "Back, From & Dead",
    card_date: "2026-07-06",
    reps: ["A"],
    sale: "Sold",
    sale_price: 30000,
    wcc: "Cancelled",
    phone: "6195556666",
  }),
  card({
    monday_item_id: "sr",
    lead_name: "From & Dead Back",
    card_date: "2026-07-09",
    reps: ["B"],
    iss: "Office Appt",
    sale_price: 18000,
    phone: "6195556666",
    comments: "can save",
  }),
]);
eq("revived: counts as sold", revived.totals.sold, 1);
eq("revived: no cancel", revived.totals.cancels, 0);
eq("revived: revenue is the save price", revived.totals.revenue, 18000);

// Name fallback when the save card has no phone.
const byName = aggregateCloseKombat([
  card({
    monday_item_id: "on",
    lead_name: "Darren and Angela Leon (copy)",
    card_date: "2026-07-06",
    reps: ["A"],
    sale: "Sold",
    sale_price: 37884,
    phone: null,
  }),
  card({
    monday_item_id: "sn",
    lead_name: "Leon, Darren & Angela",
    card_date: "2026-07-08",
    reps: ["B"],
    iss: "Office Appt",
    sale_price: 27583,
    phone: null,
    comments: "Can/Save",
  }),
]);
eq("name fallback links", byName.totals.revenue, 27583);

// A landed save with NO original in range contributes nothing — the deal
// already counts, corrected, in its own range.
const orphanSave = aggregateCloseKombat([
  card({
    monday_item_id: "so",
    lead_name: "Leon, Darren & Angela",
    card_date: "2026-07-08",
    reps: ["B"],
    iss: "Office Appt",
    sale_price: 27583,
    phone: "5623805392",
    comments: "Can/Save",
  }),
]);
eq("orphan save: no revenue", orphanSave.totals.revenue, 0);
eq("orphan save: no reload/sold", orphanSave.totals.sold + orphanSave.totals.reloads, 0);
eq(
  "orphan save: not an appt or office tally either",
  orphanSave.totals.appts + orphanSave.totals.officeAppts,
  0,
);

// ---- Cross-month save (owner, 2026-08-28): the re-priced volume pays out
// on the ORIGINAL sale's date; the save's own month shows nothing. The
// window narrows COUNTING only — linking sees every card supplied.
const crossMonthCards = [
  card({
    monday_item_id: "ocm",
    lead_name: "July, Sold",
    card_date: "2026-07-30",
    reps: ["A"],
    sale: "Sold",
    sale_price: 20000,
    wcc: "Cancelled",
    phone: "6194440000",
  }),
  card({
    monday_item_id: "scm",
    lead_name: "July, Sold",
    card_date: "2026-08-05",
    reps: ["B"],
    iss: "Office Appt",
    sale_price: 12000,
    phone: "6194440000",
    comments: "Can/Save",
  }),
];
const julyView = aggregateCloseKombat(crossMonthCards, {
  start: "2026-07-01",
  end: "2026-07-31",
});
eq("cross-month: July carries the re-priced deal", julyView.totals.revenue, 12000);
eq("cross-month: July revives the sale", julyView.totals.sold, 1);
eq("cross-month: no cancel once saved", julyView.totals.cancels, 0);
eq(
  "cross-month: saver's half lands in July",
  julyView.reps.find((r) => r.rep === "B")?.revenue,
  6000,
);
eq(
  "cross-month: seller's half lands in July",
  julyView.reps.find((r) => r.rep === "A")?.revenue,
  6000,
);
const augustView = aggregateCloseKombat(crossMonthCards, {
  start: "2026-08-01",
  end: "2026-08-31",
});
eq("cross-month: August shows no money", augustView.totals.revenue, 0);
eq(
  "cross-month: August counts no cards",
  augustView.totals.appts + augustView.totals.officeAppts + augustView.totals.sold,
  0,
);

// Office mismatch must not link (same phone, different office).
const crossOffice = aggregateCloseKombat([
  card({
    monday_item_id: "ox",
    office_location: "San Diego",
    lead_name: "X",
    card_date: "2026-07-06",
    reps: ["A"],
    sale: "Sold",
    sale_price: 1000,
    phone: "6197778888",
  }),
  card({
    monday_item_id: "sx",
    office_location: "Orange County",
    lead_name: "X",
    card_date: "2026-07-08",
    reps: ["B"],
    iss: "Office Appt",
    sale_price: 900,
    phone: "6197778888",
    comments: "Can/Save",
  }),
]);
eq("cross-office save doesn't link", crossOffice.totals.revenue, 1000);

// A rep saving their own job keeps the whole (new) volume.
const selfSave = aggregateCloseKombat([
  card({
    monday_item_id: "os",
    lead_name: "Self, Save",
    card_date: "2026-07-06",
    reps: ["A"],
    sale: "Sold",
    sale_price: 10000,
    phone: "6199990000",
  }),
  card({
    monday_item_id: "ss",
    lead_name: "Save, Self",
    card_date: "2026-07-08",
    reps: ["A"],
    iss: "Office Appt",
    sale_price: 8000,
    phone: "6199990000",
    comments: "Can/Save",
  }),
]);
eq("self-save: whole volume, once", selfSave.reps.find((r) => r.rep === "A")?.revenue, 8000);

// Two saves for one job: the LATEST landed save is the live contract.
const twoSaves = aggregateCloseKombat([
  card({
    monday_item_id: "ot",
    lead_name: "Twice, Saved",
    card_date: "2026-07-06",
    reps: ["A"],
    sale: "Sold",
    sale_price: 30000,
    phone: "6190001111",
  }),
  card({
    monday_item_id: "st1",
    lead_name: "Twice, Saved",
    card_date: "2026-07-08",
    reps: ["B"],
    iss: "Office Appt",
    sale_price: 25000,
    phone: "6190001111",
    comments: "Can/Save",
  }),
  card({
    monday_item_id: "st2",
    lead_name: "Twice, Saved",
    card_date: "2026-07-10",
    reps: ["C"],
    iss: "Office Appt",
    sale_price: 22000,
    phone: "6190001111",
    comments: "Can/Save",
  }),
]);
eq("two saves: latest price wins", twoSaves.totals.revenue, 22000);
eq(
  "two saves: latest saver in the split",
  twoSaves.reps.find((r) => r.rep === "C")?.revenue,
  11000,
);

// REGRESSION GUARD: cards without Can/Save comments behave exactly as before.
const noComment = aggregateCloseKombat([
  card({
    lead_name: "P",
    reps: ["A"],
    sale: "Sold",
    sale_price: 5000,
    phone: "6192223333",
    comments: "customer very happy, wants fence quote later",
  }),
  card({
    lead_name: "P",
    reps: ["B"],
    iss: "Office Appt",
    sale_price: 700,
    phone: "6192223333",
    sale: "Upsell",
    comments: "collected check",
  }),
]);
eq("plain comments: both count", noComment.totals.revenue, 5700);

// ---- Needs Attention audit — every silent failure mode from the July
// reconciliation, as fixtures. TODAY = 2026-08-03.
const TODAY = "2026-08-03";
const audit = (cs: BlockCard[]) => auditBlockCards(cs, TODAY);

// Each real-world case maps to exactly one kind.
const aExcluded = audit([card({ iss: "Not Issued", sale: "Reload", sale_price: 25800 })]);
eq("audit: Not-Issued reload flagged", aExcluded[0]?.kind, "excluded_sale");
const aNoReps = audit([card({ sale: "Sold", sale_price: 41000, reps: [] })]);
eq("audit: sale with no reps flagged", aNoReps[0]?.kind, "no_reps");
const aBlank = audit([card({ iss: "Office Appt", sale: "Reload", sale_price: null })]);
eq("audit: blank-price reload flagged", aBlank[0]?.kind, "blank_price");
const aStale = audit([card({ group_title: "Saturday", card_date: "2026-08-01" })]);
eq("audit: stale unmarked card flagged", aStale[0]?.kind, "unresolved");
const aGroup = audit([card({ group_title: "Needs Assignment", bo: "No Show", card_date: TODAY })]);
eq("audit: non-weekday group flagged", aGroup[0]?.kind, "no_weekday_group");
// A PRICED save with no findable original: real money counting nowhere.
const aOrphan = audit([
  card({ sale: "Sold", sale_price: 27583, phone: "5550001111", comments: "Can/Save" }),
]);
eq("audit: priced unlinked save flagged", aOrphan[0]?.kind, "orphan_save");
eq("audit: orphan save is the only flag on the card", aOrphan.length, 1);
// The window narrows flagging the same way it narrows counting.
const aWindowed = auditBlockCards(
  [
    card({ group_title: "Saturday", card_date: "2026-08-01" }),
    card({ group_title: "Saturday", card_date: "2026-07-25" }),
  ],
  TODAY,
  { start: "2026-08-01", end: "2026-08-31" },
);
eq("audit: context cards outside the window stay quiet", aWindowed.length, 1);
eq("audit: in-window card still flags", aWindowed[0]?.card_date, "2026-08-01");

// One issue per card, worst wins: Maddalena was excluded AND blank-priced.
const aBoth = audit([card({ iss: "Not Issued", sale: "Upsell", sale_price: null })]);
eq("audit: one item for a doubly-broken card", aBoth.length, 1);
eq("audit: excluded_sale outranks blank_price", aBoth[0]?.kind, "excluded_sale");

// Quiet cards stay quiet.
const aClean = audit([
  card({ group_title: "Friday", sale: "Sold", sale_price: 1000 }), // healthy sale
  card({ group_title: "Monday", bo: "No Show" }), // resulted lead
  card({ group_title: "Tuesday", iss: "Not Issued" }), // pipeline noise, no sale
  card({ group_title: "Monday", iss: "CTC", sale: "Sold", sale_price: 5, wcc: "Cancelled" }), // dead-stamped: counts as cancel already
  card({ group_title: "Monday", sale: "Sold", sale_price: 9, wcc: "Cancelled" }), // cancel w/ blank-ish price is fine
  card({ group_title: "Wednesday", card_date: TODAY }), // unmarked TODAY: reps still out
  card({ group_title: "Thursday", iss: "Office Appt", card_date: "2026-08-01" }), // office appt, never "unresolved"
  card({
    group_title: "Friday",
    iss: "Office Appt",
    card_date: "2026-08-01",
    comments: "9am Can/Save",
  }), // failed save = normal
  card({ card_date: null, group_title: "Monday" }), // retired-board card, no date
]);
eq("audit: clean cards produce nothing", aClean.length, 0);

// Sorting: money issues first, then by date.
const aSort = audit([
  card({ group_title: "Needs Assignment", bo: "No Demo", card_date: TODAY }),
  card({ sale: "Sold", sale_price: null, card_date: "2026-08-02" }),
  card({ iss: "Not Issued", sale: "Sold", sale_price: 1, card_date: "2026-08-01" }),
]);
eq("audit: hidden sale sorts first", aSort[0]?.kind, "excluded_sale");
eq("audit: blank price second", aSort[1]?.kind, "blank_price");
eq("audit: group drift last", aSort[2]?.kind, "no_weekday_group");

// ---- Audit is save-aware: never contradicts the aggregate (review findings)
// A landed save card — excluded Iss, sold label, priced — is consumed into
// its original; the aggregate counts it, so the audit must stay silent.
const savePair = [
  card({
    monday_item_id: "sa-o",
    lead_name: "Leon, Darren",
    card_date: "2026-07-24",
    group_title: "Friday",
    reps: ["Josh"],
    sale: "Sold",
    sale_price: 37884,
    phone: "5623805392",
  }),
  card({
    monday_item_id: "sa-s",
    lead_name: "Darren Leon",
    card_date: "2026-07-28",
    group_title: "Tuesday",
    reps: ["Bergan"],
    iss: "Not Issued",
    sale: "Sold",
    sale_price: 27583,
    phone: "5623805392",
    comments: "9am Can/Save",
  }),
];
eq("audit: landed save card not flagged as hidden sale", audit(savePair).length, 0);
// An original whose blank price a landed save replaced is not "counting as $0".
const rePriced = [
  card({
    monday_item_id: "rp-o",
    lead_name: "Blank, Orig",
    card_date: "2026-07-24",
    group_title: "Friday",
    reps: ["A"],
    sale: "Sold",
    sale_price: null,
    phone: "6190001111",
  }),
  card({
    monday_item_id: "rp-s",
    lead_name: "Orig Blank",
    card_date: "2026-07-28",
    group_title: "Tuesday",
    reps: ["B"],
    iss: "Office Appt",
    sale_price: 9000,
    phone: "6190001111",
    comments: "Can/Save",
  }),
];
eq("audit: save-re-priced original not flagged blank_price", audit(rePriced).length, 0);
// Aggregate agreement spot-check on that same pair: revenue is the save price.
eq("audit fixture agrees with aggregate", aggregateCloseKombat(rePriced).totals.revenue, 9000);
// A stale-dated card in a non-weekday group gets the GROUP flag, not
// "unresolved" — its date is a drifting sync-time guess, not evidence.
const drifted = audit([card({ group_title: "Needs Assignment", card_date: "2026-08-01" })]);
eq("audit: drifted card flags wrong group", drifted[0]?.kind, "no_weekday_group");
eq("audit: drifted card is one item", drifted.length, 1);

// ---- Duplicate sales (owner, 2026-08-31) ---------------------------------
// THE LIBIRAN CASE: a Block-board automation copies each new sale card
// seconds after it's created — same customer, phone, price and date, one
// card named "... (copy)" (Aida Libiran 8/28 $32,695, Jen Hauser 8/28
// $17,504, the Ortegas 8/29 $49,584). Both carry a sold result, so one deal
// pays twice. Detection only: the audit flags BOTH cards; the aggregate
// keeps counting both until the office deletes the extra on Monday.
const libiranPair = [
  card({
    monday_item_id: "dup-o",
    lead_name: "Aida Libiran",
    card_date: "2026-08-28",
    group_title: "Friday",
    reps: ["Bergan Lundak", "Garett Koltun"],
    sale: "Sold",
    sale_price: 32695,
    phone: "16191234567",
  }),
  card({
    monday_item_id: "dup-c",
    lead_name: "Aida Libiran (copy)",
    card_date: "2026-08-28",
    group_title: "Friday",
    reps: ["Bergan Lundak", "Garett Koltun"],
    sale: "Sold",
    sale_price: 32695,
    // Different formatting, same phoneKey — the copy must still match.
    phone: "+1 (619) 123-4567",
  }),
];
const aDup = audit(libiranPair);
eq("dup: both cards flagged", aDup.length, 2);
eq("dup: first is duplicate_sale", aDup[0]?.kind, "duplicate_sale");
eq("dup: second is duplicate_sale", aDup[1]?.kind, "duplicate_sale");
eq("dup: detail names the twin", /Aida Libiran \(copy\)/.test(aDup[0]?.detail ?? ""), true);
// Never dedupe in the aggregate — board = ground truth (owner rule).
const dupAgg = aggregateCloseKombat(libiranPair);
eq("dup: aggregate still counts both sales", dupAgg.totals.sold, 2);
eq("dup: aggregate still counts both dollars", dupAgg.totals.revenue, 65390);
// Money-doubling sorts above every other flag, hidden sales included.
const aDupSort = audit([
  card({ iss: "Not Issued", sale: "Sold", sale_price: 1, card_date: "2026-08-01" }),
  ...libiranPair,
]);
eq("dup: sorts ahead of a hidden sale", aDupSort[0]?.kind, "duplicate_sale");
// THE CHEMBERLEN CASE (8/25): the automation doubled a Can/Save card too —
// two landed save cards for one original. linkSaves absorbs both into the
// original (latest wins), so they are NOT duplicates and stay quiet.
const chemberlen = [
  card({
    monday_item_id: "ch-o",
    lead_name: "Chemberlen, Dana",
    card_date: "2026-08-20",
    group_title: "Thursday",
    reps: ["A"],
    sale: "Sold",
    sale_price: 30000,
    wcc: "Cancelled",
    phone: "6195550101",
  }),
  card({
    monday_item_id: "ch-s1",
    lead_name: "Chemberlen, Dana",
    card_date: "2026-08-25",
    group_title: "Tuesday",
    reps: ["B"],
    iss: "Office Appt",
    sale: "Sold",
    sale_price: 24000,
    phone: "6195550101",
    comments: "Can/Save",
  }),
  card({
    monday_item_id: "ch-s2",
    lead_name: "Chemberlen, Dana (copy)",
    card_date: "2026-08-25",
    group_title: "Tuesday",
    reps: ["B"],
    iss: "Office Appt",
    sale: "Sold",
    sale_price: 24000,
    phone: "6195550101",
    comments: "Can/Save",
  }),
];
eq("dup: landed dup save pair stays quiet", audit(chemberlen).length, 0);
eq(
  "dup: saved deal still counts once",
  aggregateCloseKombat(chemberlen).totals.revenue,
  24000,
);
// Same price + date on DIFFERENT customers (different phones): coincidence,
// not a copy — stays quiet.
eq(
  "dup: same price, different customers, quiet",
  audit([
    card({
      lead_name: "Smith, Pat",
      card_date: "2026-08-28",
      group_title: "Friday",
      sale: "Sold",
      sale_price: 17504,
      phone: "6191110001",
    }),
    card({
      lead_name: "Jones, Sam",
      card_date: "2026-08-28",
      group_title: "Friday",
      sale: "Sold",
      sale_price: 17504,
      phone: "6192220002",
    }),
  ]).length,
  0,
);
// A blank phone proves nothing — two phoneless same-price cards never group.
eq(
  "dup: blank phones never group",
  audit([
    card({
      lead_name: "NoPhone, A",
      card_date: "2026-08-28",
      group_title: "Friday",
      sale: "Sold",
      sale_price: 9000,
      phone: null,
    }),
    card({
      lead_name: "NoPhone, B",
      card_date: "2026-08-28",
      group_title: "Friday",
      sale: "Sold",
      sale_price: 9000,
      phone: null,
    }),
  ]).length,
  0,
);

// ---- OL is a result (owner, 2026-08-03): ran, not demoed ----------------
eq(
  "ol outcome",
  cardOutcome({ bo: null, rs: null, pm: null, ol: "OL", sale: null, wcc: null }),
  "ol",
);
eq(
  "bo beats ol",
  cardOutcome({ bo: "No Demo", rs: null, pm: null, ol: "OL", sale: null, wcc: null }),
  "no_demo",
);
eq(
  "'None' ol is not a result",
  cardOutcome({ bo: null, rs: null, pm: null, ol: "None", sale: null, wcc: null }),
  "unmarked",
);
const olAgg = aggregateCloseKombat([
  ...many(3, { group_title: "Thursday", ol: "OL" }),
  ...many(2, { group_title: "Thursday", pm: "PM" }),
  ...many(1, { group_title: "Thursday", sale: "Sold", sale_price: 1000 }),
]);
eq("ol counts as appts", olAgg.totals.appts, 6);
eq("ol tallied", olAgg.totals.ol, 3);
eq("ol % = OL/Appts", olAgg.totals.olPct, 3 / 6);
eq("ol is not a demo: sit %", olAgg.totals.sitPct, 3 / 6);
eq("ol out of close %", olAgg.totals.closePct, 1 / 3);
eq(
  "results still sum to appts",
  olAgg.totals.noShow +
    olAgg.totals.noDemo +
    olAgg.totals.ol +
    olAgg.totals.reset +
    olAgg.totals.pm +
    olAgg.totals.sold,
  6,
);
// Audit: an OL card is resulted — never "No Result".
eq(
  "audit: OL card not flagged",
  audit([card({ group_title: "Thursday", ol: "OL", card_date: "2026-08-01" })]).length,
  0,
);

// ---- Report reps (owner, 2026-08-25): volume follows the Sales Report ----
// THE HAGMANN CASE (corrected 2026-09-02): Daniel sold the job, it cancelled,
// Jonathan Paz saved it, and the office wrote the 50/50 save split as the
// report row's rep pair. The sync stamps report_reps; the volume split
// follows it while result counts stay with the Block card's own reps — the
// saver earns money, never a Sold, and the Block card needs no fix.
const hagmann = aggregateCloseKombat([
  card({
    reps: ["Daniel Figueiredo"],
    report_reps: ["Daniel Figueiredo", "Jonathan Paz"],
    sale: "Sold",
    sale_price: 10000,
  }),
]);
eq("report split: totals one sold", hagmann.totals.sold, 1);
eq("report split: totals whole volume", hagmann.totals.revenue, 10000);
const rrDaniel = hagmann.reps.find((r) => r.rep === "Daniel Figueiredo");
const rrJon = hagmann.reps.find((r) => r.rep === "Jonathan Paz");
eq("report split: Daniel keeps the Sold", rrDaniel?.sold, 1);
eq("report split: Daniel keeps the appt", rrDaniel?.appts, 1);
eq("report split: Daniel gets half", rrDaniel?.revenue, 5000);
eq("report split: Jonathan gets half", rrJon?.revenue, 5000);
eq("report split: Jonathan volume only, no Sold", rrJon?.sold, 0);
eq("report split: Jonathan is not an appt", rrJon?.appts, 0);

// An empty stamp behaves exactly like no stamp.
const rrEmpty = aggregateCloseKombat([
  card({ reps: ["A"], report_reps: [], sale: "Sold", sale_price: 1000 }),
]);
eq("empty report_reps falls back to reps", rrEmpty.reps.find((r) => r.rep === "A")?.revenue, 1000);

// Dedup: a repeated name is ONE rep — one bump, full volume, either list.
const rrDupBlock = aggregateCloseKombat([
  card({ reps: ["A", "A"], sale: "Sold", sale_price: 1000 }),
]);
const rrDupA = rrDupBlock.reps.find((r) => r.rep === "A");
eq("dup block name: one appt", rrDupA?.appts, 1);
eq("dup block name: one sold", rrDupA?.sold, 1);
eq("dup block name: full volume", rrDupA?.revenue, 1000);
const rrDupReport = aggregateCloseKombat([
  card({ reps: ["A"], report_reps: ["A", "A"], sale: "Sold", sale_price: 1000 }),
]);
eq(
  "dup report name: full volume",
  rrDupReport.reps.find((r) => r.rep === "A")?.revenue,
  1000,
);

// Save interplay: the original's report_reps reshapes only the ORIGINALS'
// half; the saver's identity always comes from the save card's Block reps.
const rrSaved = aggregateCloseKombat([
  card({
    monday_item_id: "orig-rr",
    lead_name: "Shared Deal",
    card_date: "2026-07-06",
    reps: ["A"],
    report_reps: ["A", "B"],
    sale: "Sold",
    sale_price: 30000,
    phone: "1111111111",
  }),
  card({
    monday_item_id: "save-rr",
    lead_name: "Shared Deal",
    card_date: "2026-07-08",
    reps: ["C"],
    iss: "Office Appt",
    sale_price: 20000,
    phone: "1111111111",
    comments: "Can/Save",
  }),
]);
eq("save+report: saver takes half", rrSaved.reps.find((r) => r.rep === "C")?.revenue, 10000);
eq("save+report: A takes a quarter", rrSaved.reps.find((r) => r.rep === "A")?.revenue, 5000);
eq("save+report: B takes a quarter", rrSaved.reps.find((r) => r.rep === "B")?.revenue, 5000);
eq("save+report: B has no Sold", rrSaved.reps.find((r) => r.rep === "B")?.sold, 0);
eq("save+report: revenue = save price, once", rrSaved.totals.revenue, 20000);

// The office wrote the save split into the report pair TOO (Hagmann-style)
// while a priced save card links: the saver's report listing is the same
// 50% already paid off the top — 50/50, never 75/25.
const rrOverlap = aggregateCloseKombat([
  card({
    monday_item_id: "orig-ov",
    lead_name: "Overlap Deal",
    card_date: "2026-07-06",
    reps: ["A"],
    report_reps: ["A", "C"],
    sale: "Sold",
    sale_price: 30000,
    phone: "2223334444",
  }),
  card({
    monday_item_id: "save-ov",
    lead_name: "Overlap Deal",
    card_date: "2026-07-08",
    reps: ["C"],
    iss: "Office Appt",
    sale_price: 20000,
    phone: "2223334444",
    comments: "Can/Save",
  }),
]);
eq(
  "save+report overlap: stamped saver takes half, once",
  rrOverlap.reps.find((r) => r.rep === "C")?.revenue,
  10000,
);
eq(
  "save+report overlap: seller keeps the whole originals' half",
  rrOverlap.reps.find((r) => r.rep === "A")?.revenue,
  10000,
);
eq("save+report overlap: revenue = save price, once", rrOverlap.totals.revenue, 20000);

// Audit (corrected 2026-09-02): a report row that only ADDS names is the
// office paying a saver — the Hagmann/Pinel shape — and stays SILENT; a
// CONTRADICTION (a Block rep dropped or replaced) still flags.
const rrCard = (over: Partial<BlockCard>) =>
  card({ group_title: "Thursday", card_date: "2026-08-01", ...over });
eq(
  "audit: report adding the saver is silent (Hagmann/Pinel)",
  audit([
    rrCard({ reps: ["Daniel"], report_reps: ["Daniel", "Jon"], sale: "Sold", sale_price: 100 }),
  ]).length,
  0,
);
const rrMismatch = audit([
  rrCard({ reps: ["Daniel"], report_reps: ["Jon"], sale: "Sold", sale_price: 100 }),
]);
eq("audit: rep_mismatch fires on a replaced rep", rrMismatch[0]?.kind, "rep_mismatch");
eq("audit: rep_mismatch is one item", rrMismatch.length, 1);
eq(
  "audit: report dropping a Block rep still flags",
  audit([
    rrCard({ reps: ["A", "B"], report_reps: ["A"], sale: "Sold", sale_price: 100 }),
  ])[0]?.kind,
  "rep_mismatch",
);
eq(
  "audit: same set, different order/case, silent",
  audit([
    rrCard({ reps: ["b", "A"], report_reps: ["a ", "B"], sale: "Sold", sale_price: 100 }),
  ]).length,
  0,
);
eq(
  "audit: block-empty + report-present is rep_mismatch, not no_reps",
  audit([rrCard({ reps: [], report_reps: ["A"], sale: "Sold", sale_price: 100 })])[0]?.kind,
  "rep_mismatch",
);
eq(
  "audit: both empty is still no_reps",
  audit([rrCard({ reps: [], sale: "Sold", sale_price: 100 })])[0]?.kind,
  "no_reps",
);
eq(
  "audit: blank price outranks the mismatch (one issue per card)",
  audit([rrCard({ reps: ["A"], report_reps: ["B"], sale: "Sold", sale_price: null })])[0]
    ?.kind,
  "blank_price",
);
eq(
  "audit: cancelled card with a contradiction still flags",
  audit([
    rrCard({ reps: ["A"], report_reps: ["B"], sale: "Sold", sale_price: 100, wcc: "Cancelled" }),
  ])[0]?.kind,
  "rep_mismatch",
);
// A cancelled sale whose report merely adds a name is save bookkeeping on a
// dead deal — nothing on the Block board to fix, so it stays quiet too.
eq(
  "audit: cancelled card with an added name is silent",
  audit([
    rrCard({ reps: ["A"], report_reps: ["A", "B"], sale: "Sold", sale_price: 100, wcc: "Cancelled" }),
  ]).length,
  0,
);
// The aggregate counts a dead excluded card (CTC flip + report stamp), so
// the audit must be able to flag its drift too — same gate, both sides.
eq(
  "audit: dead CTC card with a contradiction still flags",
  audit([
    rrCard({ iss: "CTC", reps: ["A"], report_reps: ["B"], sale_price: 100, wcc: "Cancelled" }),
  ])[0]?.kind,
  "rep_mismatch",
);
// House whitespace rule: internal runs collapse, so a hand-typed double
// space is the same person, not a mismatch (and not a phantom rep row).
eq(
  "audit: double-spaced name is the same person",
  audit([
    rrCard({
      reps: ["Daniel  Figueiredo"],
      report_reps: ["Daniel Figueiredo"],
      sale: "Sold",
      sale_price: 100,
    }),
  ]).length,
  0,
);

// ---- chooseReportReps: the best-single-row decision ladder ---------------
const hit = (over: Partial<ReportRepHit>): ReportRepHit => ({
  wcc: null,
  amt: null,
  reps: ["A", "B"],
  saleDate: "2026-08-14",
  dateTrue: true,
  repsKnown: true,
  ...over,
});
const ladderCard = { sale_price: 10000, card_date: "2026-08-14", can_save: false };
eq(
  "ladder: stamps the date-true row",
  JSON.stringify(chooseReportReps([hit({})], ladderCard)),
  JSON.stringify({ set: ["A", "B"] }),
);
eq("ladder: date-blind rows never stamp OR clear", chooseReportReps([hit({ dateTrue: false })], ladderCard), null);
eq(
  "ladder: unknown Sales Rep column keeps the stamp",
  chooseReportReps([hit({ reps: [], repsKnown: false })], ladderCard),
  null,
);
eq(
  "ladder: known-empty reps clear the stamp",
  JSON.stringify(chooseReportReps([hit({ reps: [] })], ladderCard)),
  JSON.stringify({ set: null }),
);
eq(
  "ladder: can/save cards always clear",
  JSON.stringify(chooseReportReps([hit({})], { ...ladderCard, can_save: true })),
  JSON.stringify({ set: null }),
);
eq(
  "ladder: amt match beats nearest date",
  chooseReportReps(
    [
      hit({ amt: 500, reps: ["Wrong"], saleDate: "2026-08-14" }),
      hit({ amt: 10000, reps: ["Right"], saleDate: "2026-08-16" }),
    ],
    ladderCard,
  )?.set?.[0],
  "Right",
);
eq(
  "ladder: nearest Date Sold breaks the tie",
  chooseReportReps(
    [
      hit({ amt: 1, reps: ["Far"], saleDate: "2026-08-11" }),
      hit({ amt: 2, reps: ["Near"], saleDate: "2026-08-15" }),
    ],
    ladderCard,
  )?.set?.[0],
  "Near",
);
eq(
  "ladder: non-cancel row wins the last tie",
  chooseReportReps(
    [
      hit({ wcc: "Cancelled", reps: ["Dead"], amt: 1, saleDate: "2026-08-14" }),
      hit({ wcc: null, reps: ["Live"], amt: 2, saleDate: "2026-08-14" }),
    ],
    ladderCard,
  )?.set?.[0],
  "Live",
);

// ---- WCC column is the only cancel authority (owner, 2026-09-02) --------
// Supersedes the 8/25 Sales-Count fallback (reportRowWcc, deleted): a row
// whose WCC says "LVM"/"Completed" is a GOOD sale even when its Sales Count
// column says "Cancelled" — on a rescued deal Sales Count keeps recording
// the pre-save cancellation (Hagmann/Pinel/Chemberlen, Aug '26). Only a
// WCC-stamped cancel kills volume; the sit stays either way.
const wccCancel = aggregateCloseKombat([
  card({ sale: "Sold", sale_price: 14549, wcc: "Cancelled", reps: ["Daniel Figueiredo"] }),
]);
eq("wcc-only: WCC-cancelled sale pays nothing", wccCancel.totals.revenue, 0);
eq("wcc-only: still a sit (PM)", wccCancel.totals.pm, 1);
eq("wcc-only: cancels tallied", wccCancel.totals.cancels, 1);
// The Hagmann shape after the rule change: WCC "Completed" stamp, pair in
// report_reps — a live sale, volume split 50/50, Sold stays with the seller.
const wccGood = aggregateCloseKombat([
  card({
    sale: "Sold",
    sale_price: 14549,
    wcc: "Completed",
    reps: ["Daniel Figueiredo"],
    report_reps: ["Daniel Figueiredo", "Jonathan Paz"],
  }),
]);
eq("wcc-only: Completed stamp counts as sold", wccGood.totals.sold, 1);
eq("wcc-only: no cancel tallied", wccGood.totals.cancels, 0);
eq(
  "wcc-only: seller takes half",
  wccGood.reps.find((r) => r.rep === "Daniel Figueiredo")?.revenue,
  7274.5,
);
eq(
  "wcc-only: saver takes half, no Sold",
  wccGood.reps.find((r) => r.rep === "Jonathan Paz")?.revenue,
  7274.5,
);
eq(
  "wcc-only: saver has no Sold",
  wccGood.reps.find((r) => r.rep === "Jonathan Paz")?.sold,
  0,
);

// ---- preferAmountMatch: repeat customer's rows bind their OWN cards ------
// THE BUFORD CASE (found live 2026-08-28): the SD August report carried two
// cancelled rows for one customer — a $9,900 sale dated 8/4 and a $12,048
// reload dated 8/5 — against Block cards on 8/4 ($9,900) and 8/6 ($12,048).
// Both cards sit one day from the reload row's Date Sold, so the
// nearest-date tiebreak bound BOTH rows to the 8/4 card and the cancelled
// 8/6 reload kept paying $12,048.
const buford84 = { monday_item_id: "84", sale_price: 9900 };
const buford86 = { monday_item_id: "86", sale_price: 12048 };
const bufords = [buford84, buford86];
const picks = (cands: Array<{ monday_item_id: string; sale_price: number | null }>) =>
  cands.map((c) => c.monday_item_id).join(",");
eq(
  "amount: reload row picks the $12,048 card",
  picks(preferAmountMatch(bufords, [12048, 12048])),
  "86",
);
eq("amount: sale row picks the $9,900 card", picks(preferAmountMatch(bufords, [9900, 9900])), "84");
eq("amount: Cancel Amt alone is enough", picks(preferAmountMatch(bufords, [null, 12048])), "86");
eq("amount: no figure changes nothing", picks(preferAmountMatch(bufords, [null, null])), "84,86");
eq("amount: unpriced figure changes nothing", picks(preferAmountMatch(bufords, [5000])), "84,86");
eq(
  "amount: $0 never matches a $0 card",
  picks(preferAmountMatch([{ monday_item_id: "z", sale_price: 0 }, buford84], [0])),
  "z,84",
);
eq(
  "amount: blank card price never matches",
  picks(preferAmountMatch([{ monday_item_id: "n", sale_price: null }, buford86], [12048])),
  "86",
);
eq("amount: single candidate is never vetoed", picks(preferAmountMatch([buford84], [12048])), "84");
eq("amount: sub-cent drift still matches", picks(preferAmountMatch(bufords, [9900.001])), "84");

console.log(`checks run, ${fails.length} failure(s)`);
for (const f of fails) console.log("  FAIL " + f);
process.exit(fails.length === 0 ? 0 : 1);
