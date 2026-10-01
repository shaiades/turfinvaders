import { createServerFn } from "@tanstack/react-start";
import { requireSupabaseAuth } from "@/integrations/supabase/auth-middleware";
import {
  composeDigest,
  detectDoorSag,
  detectOfficeCancelSpike,
  detectPaymentAging,
  detectRepCloseCollapse,
  detectVanLeadSag,
  rankDeviations,
  type Deviation,
  type DigestFacts,
} from "@/lib/deviations";

/**
 * The What-Changed engine's server half (owner directive 2026-10-01):
 * ONE computation, two outlets — the God Mode rail block and the 6:45am
 * push digest both consume this result, so the page and the phone can
 * never disagree. Owner/office_staff gated like the syncs; service client,
 * aggregates only. All windows are LA-calendar, anchored to today.
 */
export type WhatChanged = {
  items: Deviation[];
  facts: DigestFacts;
};

export const getWhatChanged = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .handler(async ({ context }): Promise<WhatChanged> => {
    const { data: roleRows, error: roleErr } = await context.supabase
      .from("user_roles")
      .select("role")
      .eq("user_id", context.userId);
    if (roleErr) throw new Error(roleErr.message);
    const roles = (roleRows ?? []).map((r: { role: string }) => r.role);
    if (!roles.includes("owner") && !roles.includes("office_staff")) {
      throw new Error("Owners and Managers only.");
    }
    return computeWhatChanged();
  });

/** The digest route calls this directly (cron auth, no user session). */
export async function computeWhatChanged(): Promise<WhatChanged> {
  const { supabaseAdmin } = await import("@/integrations/supabase/client.server");
  const {
    addDaysISO,
    laTodayISO,
    laMonthStartISO,
    monthStartISO,
    nextMonthStartISO,
    weekStartOfISO,
  } = await import("@/lib/dates");
  const { aggregateCloseKombat, aggregateReportYear, CARD_COLUMNS } =
    await import("@/lib/close-kombat");
  const { buildForwardOutlook } = await import("@/lib/collections");
  const { DOORS_TRACKED_SINCE } = await import("@/lib/funnel");

  const today = laTodayISO();
  const yday = addDaysISO(today, -1);
  const wkStart = weekStartOfISO(today);
  const baseStart = addDaysISO(wkStart, -28);
  const monthStart = laMonthStartISO();
  const prevMonth = monthStartISO(addDaysISO(monthStart, -1));
  const nextMonth = nextMonthStartISO(monthStart);
  const threeMonths = [
    prevMonth,
    monthStartISO(addDaysISO(prevMonth, -1)),
    monthStartISO(addDaysISO(monthStartISO(addDaysISO(prevMonth, -1)), -1)),
  ];

  const PAGE = 1000;
  async function pageAll<T>(
    build: (from: number, to: number) => PromiseLike<{ data: T[] | null; error: unknown }>,
  ): Promise<T[]> {
    const out: T[] = [];
    for (let from = 0; ; from += PAGE) {
      const { data, error } = await build(from, from + PAGE - 1);
      if (error) throw error as Error;
      out.push(...(data ?? []));
      if (!data || data.length < PAGE) break;
    }
    return out;
  }

  const [logs, teams, cards, bookRows, colRows, flaggedOldest, flaggedCount] = await Promise.all([
    pageAll<{
      canvasser_id: string | null;
      team_id: string | null;
      log_date: string;
      leads_called_in: number | null;
      doors_knocked: number | null;
    }>((from, to) =>
      supabaseAdmin
        .from("daily_logs")
        .select("canvasser_id, team_id, log_date, leads_called_in, doors_knocked")
        .gte("log_date", baseStart)
        .lte("log_date", today)
        .order("id")
        .range(from, to),
    ),
    supabaseAdmin
      .from("teams")
      .select("id, name")
      .then((r) => r.data ?? []),
    pageAll<Record<string, unknown>>(
      (from, to) =>
        supabaseAdmin
          .from("block_cards")
          .select(CARD_COLUMNS)
          .gte("card_date", addDaysISO(today, -69))
          .lte("card_date", today)
          .order("monday_item_id")
          // The shared-constant column list defeats supabase-js's literal
          // parsing (the fetchCandidateCards precedent).
          .range(from, to) as unknown as PromiseLike<{
          data: Record<string, unknown>[] | null;
          error: unknown;
        }>,
    ),
    pageAll<{
      report_month: string;
      office: string | null;
      sale_amt: number;
      cancel_amt: number;
      date_sold: string | null;
      reps: string[];
      sales_count: string | null;
      wcc: string | null;
      customer_name: string | null;
      monday_item_id: string;
      phone: string | null;
    }>((from, to) =>
      supabaseAdmin
        .from("report_sales")
        .select(
          "monday_item_id, report_month, office, sale_amt, cancel_amt, date_sold, reps, sales_count, wcc, customer_name, phone",
        )
        .in("report_month", [monthStart, ...threeMonths])
        .order("monday_item_id")
        .range(from, to),
    ),
    pageAll<{
      customer_name: string | null;
      planned_amount: number;
      actual_amount: number;
      anticipated_date: string | null;
      collected_date: string | null;
      office: string | null;
    }>((from, to) =>
      supabaseAdmin
        .from("report_collections")
        .select(
          "customer_name, planned_amount, actual_amount, anticipated_date, collected_date, office",
        )
        .in("collection_month", [prevMonth, monthStart, nextMonth])
        .order("monday_item_id")
        .range(from, to),
    ),
    supabaseAdmin
      .from("time_entries")
      .select("log_date")
      .eq("needs_correction", true)
      .is("voided_at", null)
      .order("log_date", { ascending: true })
      .limit(1)
      .maybeSingle()
      .then((r) => r.data?.log_date ?? null),
    supabaseAdmin
      .from("time_entries")
      .select("id", { count: "exact", head: true })
      .eq("needs_correction", true)
      .is("voided_at", null)
      .then((r) => r.count ?? 0),
  ]);

  // Gross ticket + ranking value from the trailing 3 full months of book.
  const agg3 = aggregateReportYear(bookRows.filter((r) => threeMonths.includes(r.report_month)));
  const gross3 = agg3.totals.revenue + agg3.totals.cancelAmt;
  const avgTicket = agg3.totals.sold > 0 ? gross3 / agg3.totals.sold : 20_000;

  // ── Vans: leads/active-day, current week vs the 4 full prior weeks ──
  const teamName = new Map(teams.map((t: { id: string; name: string }) => [t.id, t.name]));
  type VanAgg = { leads: number; days: Set<string> };
  const vanBase = new Map<string, VanAgg>();
  const vanCur = new Map<string, VanAgg>();
  for (const l of logs) {
    if (!l.team_id) continue;
    const active = (l.leads_called_in ?? 0) + (l.doors_knocked ?? 0) > 0;
    if (!active) continue;
    const bucket = l.log_date >= wkStart ? vanCur : vanBase;
    const slot = bucket.get(l.team_id) ?? { leads: 0, days: new Set<string>() };
    slot.leads += l.leads_called_in ?? 0;
    slot.days.add(l.log_date);
    bucket.set(l.team_id, slot);
  }
  const vanInputs = [...vanBase.entries()]
    .filter(([id]) => vanCur.has(id))
    .map(([id, base]) => {
      const cur = vanCur.get(id)!;
      return {
        name: teamName.get(id) ?? "Van",
        baselinePerDay: base.days.size > 0 ? base.leads / base.days.size : 0,
        currentPerDay: cur.days.size > 0 ? cur.leads / cur.days.size : 0,
        activeDaysThisWeek: cur.days.size,
        leadValue: Math.round(avgTicket * 0.02), // rough rank weight only
      };
    });

  // ── Reps: close rate, trailing 14d vs the 8-week baseline before it ──
  const curWin = { start: addDaysISO(today, -13), end: today };
  const baseWin = { start: addDaysISO(today, -69), end: addDaysISO(today, -14) };
  const curReps = new Map(aggregateCloseKombat(cards as never, curWin).reps.map((r) => [r.rep, r]));
  const baseReps = new Map(
    aggregateCloseKombat(cards as never, baseWin).reps.map((r) => [r.rep, r]),
  );
  const repInputs = [...curReps.entries()]
    .filter(([name]) => baseReps.has(name))
    .map(([name, cur]) => {
      const base = baseReps.get(name)!;
      return {
        name,
        baseSits: base.pm + base.sold,
        baseSold: base.sold,
        curSits: cur.pm + cur.sold,
        curSold: cur.sold,
        avgTicket,
      };
    });

  // ── Office cancel spike: MTD vs prior 3 full months, per office ──
  const officeInputs = ["San Diego", "Orange County"].map((office) => {
    const mtd = bookRows.filter((r) => r.report_month === monthStart && r.office === office);
    const base = bookRows.filter(
      (r) => threeMonths.includes(r.report_month) && r.office === office,
    );
    const baseGross = base.reduce((s, r) => s + r.sale_amt + r.cancel_amt, 0);
    const baseCancel = base.reduce((s, r) => s + r.cancel_amt, 0);
    return {
      office,
      mtdCancel: mtd.reduce((s, r) => s + r.cancel_amt, 0),
      mtdGross: mtd.reduce((s, r) => s + r.sale_amt + r.cancel_amt, 0),
      baselinePct: baseGross > 0 ? baseCancel / baseGross : null,
    };
  });

  // ── Doors/rep sag (era-gated: needs 3 full baseline weeks of tracking) ──
  const eraLogs = logs.filter((l) => l.log_date >= DOORS_TRACKED_SINCE);
  const repDay = (rows: typeof logs) => {
    const days = new Set<string>();
    let doors = 0;
    for (const l of rows) {
      if ((l.doors_knocked ?? 0) <= 0 || !l.canvasser_id) continue;
      days.add(`${l.canvasser_id}|${l.log_date}`);
      doors += l.doors_knocked ?? 0;
    }
    return days.size > 0 ? doors / days.size : 0;
  };
  const eraBaselineStart = DOORS_TRACKED_SINCE > baseStart ? DOORS_TRACKED_SINCE : baseStart;
  const baselineWeeks = Math.floor(
    (Date.parse(wkStart) - Date.parse(eraBaselineStart)) / (7 * 86_400_000),
  );
  const doorInput = {
    baselinePerRepDay: repDay(eraLogs.filter((l) => l.log_date < wkStart)),
    currentPerRepDay: repDay(eraLogs.filter((l) => l.log_date >= wkStart)),
    baselineWeeks,
    dollarPerDoor: Math.round(avgTicket * 0.005),
  };

  // ── Payment aging + digest facts from the collections boards ──
  const agingRows = colRows.map((r) => ({
    customer: r.customer_name,
    remaining: Math.max(r.planned_amount - r.actual_amount, 0),
    anticipated_date: r.anticipated_date,
  }));
  const forward = buildForwardOutlook(colRows, { todayISO: today });
  const dueToday = colRows.filter(
    (r) => r.anticipated_date === today && r.planned_amount - r.actual_amount > 0,
  );

  const items = rankDeviations([
    ...detectVanLeadSag(vanInputs),
    ...detectRepCloseCollapse(repInputs),
    ...detectOfficeCancelSpike(officeInputs),
    ...detectDoorSag(doorInput),
    ...detectPaymentAging(agingRows, today),
  ]);

  const oldestDays =
    flaggedOldest !== null
      ? Math.round((Date.parse(today) - Date.parse(flaggedOldest)) / 86_400_000)
      : 0;
  const facts: DigestFacts = {
    yesterday: {
      banked: Math.round(
        colRows.filter((r) => r.collected_date === yday).reduce((s, r) => s + r.actual_amount, 0),
      ),
      soldBook: Math.round(
        bookRows.filter((r) => r.date_sold === yday).reduce((s, r) => s + r.sale_amt, 0),
      ),
      leads: logs
        .filter((l) => l.log_date === yday)
        .reduce((s, l) => s + (l.leads_called_in ?? 0), 0),
      doors: logs
        .filter((l) => l.log_date === yday)
        .reduce((s, l) => s + (l.doors_knocked ?? 0), 0),
    },
    today: {
      dueAmount: Math.round(dueToday.reduce((s, r) => s + (r.planned_amount - r.actual_amount), 0)),
      duePayments: dueToday.length,
      overdueBacklog: Math.round(forward.overdueBacklog),
    },
    deviations: items,
    staleFlaggedPunches:
      flaggedCount > 0 && oldestDays >= 7 ? { count: flaggedCount, oldestDays } : null,
  };

  return { items, facts };
}

/** Composed digest for the cron route — same engine, text out. */
export async function composeMorningDigest(): Promise<{
  title: string;
  body: string;
  facts: DigestFacts;
}> {
  const { facts } = await computeWhatChanged();
  return { ...composeDigest(facts), facts };
}
