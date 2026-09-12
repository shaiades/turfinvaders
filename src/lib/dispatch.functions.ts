import { createServerFn } from "@tanstack/react-start";
import { requireSupabaseAuth } from "@/integrations/supabase/auth-middleware";
import { COMMISSION_BASE, weeklyPoints } from "@/lib/pay";
import { addDaysISO, laMidnightUtcISO, laTodayISO } from "@/lib/dates";
import { DEFAULT_OFFICE } from "@/lib/offices";
import { DOORS_TRACKED_SINCE, EMPTY_SPLIT, type SplitFunnelInputs } from "@/lib/funnel";

/**
 * Aggregated per-canvasser production for the Fleet Dispatch board.
 *
 * Deliberately readable by EVERY authenticated user (owner decision,
 * 2026-07-28: "everyone should be able to see everyone's production").
 * daily_logs and leads rows stay RLS-locked (see migration 20260629213023 —
 * the visibility toggle "only controls production-metric peer views in the
 * app layer"; this function IS that app layer). Only aggregate totals per
 * canvasser leave the server — never raw rows, addresses, or lead details.
 */
/** Per-canvasser lead-result cells for the dispatch board's continuous row —
 *  same math as the Executive Weekly Results table (leadsSum / sits-minus-sales /
 *  future_leads-as-resets), summed over the selected log window. */
export type DispatchResults = {
  lds: number;
  sit: number;
  rs: number;
  bo: number;
  ctc: number;
  nc: number;
  ol: number;
  sal: number;
  /** Door-work counters (the board's "Door Work" group) — raw daily_logs
   *  field activity (map pins + Mission Log), unlike the lead results above. */
  drs: number;
  tlk: number;
  ni: number;
  rnt: number;
};

export const getDispatchProduction = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((data: unknown) => {
    const obj = data && typeof data === "object" ? (data as Record<string, unknown>) : {};
    const day = /^\d{4}-\d{2}-\d{2}$/;
    const log_start = typeof obj.log_start === "string" ? obj.log_start : "";
    const log_end = typeof obj.log_end === "string" ? obj.log_end : "";
    if (!day.test(log_start) || !day.test(log_end)) throw new Error("Invalid log window");
    const vol_start = typeof obj.vol_start === "string" ? obj.vol_start : "";
    const vol_end = typeof obj.vol_end === "string" ? obj.vol_end : "";
    if (Number.isNaN(Date.parse(vol_start)) || Number.isNaN(Date.parse(vol_end))) {
      throw new Error("Invalid volume window");
    }
    return { log_start, log_end, vol_start, vol_end };
  })
  .handler(async ({ data }) => {
    const { supabaseAdmin } = await import("@/integrations/supabase/client.server");

    const [logsR, leadsR] = await Promise.all([
      supabaseAdmin
        .from("daily_logs")
        .select(
          "canvasser_id, demos_sits, sales, no_demo, future_leads, ctc, non_core, one_legs, unmarked, doors_knocked, people_talked_to, not_interested, renters, office_location, log_date, team_id",
        )
        .gte("log_date", data.log_start)
        .lte("log_date", data.log_end),
      // Two-sided superset fetch; the COALESCE(reviewed_at, created_at)
      // re-window below is the authoritative filter (pay-engine parity).
      supabaseAdmin
        .from("leads")
        .select("canvasser_id, sale_amount, created_at, reviewed_at, monday_item_id, team_id")
        .eq("status", "confirmed")
        .or(
          `and(created_at.gte.${data.vol_start},created_at.lt.${data.vol_end}),and(reviewed_at.gte.${data.vol_start},reviewed_at.lt.${data.vol_end})`,
        ),
    ]);
    if (logsR.error) throw logsR.error;
    if (leadsR.error) throw leadsR.error;

    const points: Record<string, number> = {};
    const results: Record<string, DispatchResults> = {};
    // Van-at-the-time attribution for people no longer on a roster: the
    // latest daily_logs.team_id snapshot in the log window per canvasser
    // (leads snapshot fills in below for confirm-only weeks). The board
    // buckets removed/archived reps' history by this, never by the live
    // profiles.team_id that removal already nulled.
    const snapshotTeam: Record<string, string> = {};
    const snapshotDate: Record<string, string> = {};
    // Office-sliced mirrors of the same aggregates, for the cross-office
    // Confirmation van (owner, 2026-08-10): each office tab shows only that
    // office's share. daily_logs rows carry the office they were counted
    // for, so the slice is exact, never inferred.
    const officePoints: Record<string, Record<string, number>> = {};
    const officeResults: Record<string, Record<string, DispatchResults>> = {};
    const emptyResults = (): DispatchResults => ({
      lds: 0,
      sit: 0,
      rs: 0,
      bo: 0,
      ctc: 0,
      nc: 0,
      ol: 0,
      sal: 0,
      drs: 0,
      tlk: 0,
      ni: 0,
      rnt: 0,
    });
    for (const l of logsR.data ?? []) {
      if (!l.canvasser_id) continue;
      if (
        l.team_id &&
        l.log_date &&
        (!(l.canvasser_id in snapshotTeam) || l.log_date > snapshotDate[l.canvasser_id])
      ) {
        snapshotTeam[l.canvasser_id] = l.team_id;
        snapshotDate[l.canvasser_id] = l.log_date;
      }
      const office = l.office_location ?? DEFAULT_OFFICE;
      const pts = weeklyPoints(l.demos_sits ?? 0, l.sales ?? 0);
      if (pts > 0) {
        points[l.canvasser_id] = (points[l.canvasser_id] ?? 0) + pts;
        const po = (officePoints[office] ??= {});
        po[l.canvasser_id] = (po[l.canvasser_id] ?? 0) + pts;
      }
      const r = (results[l.canvasser_id] ??= emptyResults());
      const ro = ((officeResults[office] ??= {})[l.canvasser_id] ??= emptyResults());
      for (const t of [r, ro]) {
        t.lds +=
          (l.demos_sits ?? 0) +
          (l.no_demo ?? 0) +
          (l.ctc ?? 0) +
          (l.future_leads ?? 0) +
          (l.unmarked ?? 0);
        // demos_sits includes sold sits; the board splits them (Weekly Results parity).
        t.sit += Math.max(0, (l.demos_sits ?? 0) - (l.sales ?? 0));
        t.sal += l.sales ?? 0;
        t.rs += l.future_leads ?? 0;
        t.bo += l.no_demo ?? 0;
        t.ctc += l.ctc ?? 0;
        t.nc += l.non_core ?? 0;
        t.ol += l.one_legs ?? 0;
        t.drs += l.doors_knocked ?? 0;
        t.tlk += l.people_talked_to ?? 0;
        t.ni += l.not_interested ?? 0;
        t.rnt += l.renters ?? 0;
      }
    }

    const volStartMs = Date.parse(data.vol_start);
    const volEndMs = Date.parse(data.vol_end);
    const volume: Record<string, number> = {};
    const counted: Array<{ cid: string; amt: number; mid: string | null }> = [];
    const leadSnapAt: Record<string, number> = {};
    for (const l of leadsR.data ?? []) {
      if (!l.canvasser_id) continue;
      const at = Date.parse(l.reviewed_at ?? l.created_at ?? "");
      if (Number.isNaN(at) || at < volStartMs || at >= volEndMs) continue;
      // Fallback snapshot for confirm-only weeks: a lead's team_id only
      // places someone whose window has no daily_logs snapshot at all.
      if (l.team_id && !(l.canvasser_id in snapshotDate) && at >= (leadSnapAt[l.canvasser_id] ?? 0)) {
        snapshotTeam[l.canvasser_id] = l.team_id;
        leadSnapAt[l.canvasser_id] = at;
      }
      const amt = Number(l.sale_amount ?? 0);
      volume[l.canvasser_id] = (volume[l.canvasser_id] ?? 0) + amt;
      counted.push({
        cid: l.canvasser_id,
        amt,
        mid: l.monday_item_id ? String(l.monday_item_id) : null,
      });
    }

    // Volume office resolution for the office slices: block_cards knows
    // current-week cards; rotated-away pulses fall back to their
    // Card_Outcome_Recorded marker; manual leads bucket under the default
    // office. Only the Confirmation van reads the slices, so a fallback miss
    // can never move numbers on a regular van.
    const officeByMid = new Map<string, string>();
    const mids = [...new Set(counted.map((c) => c.mid).filter((m): m is string => !!m))];
    if (mids.length > 0) {
      const cardsR = await supabaseAdmin
        .from("block_cards")
        .select("monday_item_id, office_location")
        .in("monday_item_id", mids);
      for (const c of cardsR.data ?? []) {
        if (c.office_location) officeByMid.set(String(c.monday_item_id), c.office_location);
      }
      const missing = mids.filter((m) => !officeByMid.has(m));
      if (missing.length > 0) {
        const markersR = await supabaseAdmin
          .from("webhook_logs")
          .select("data, created_at")
          .eq("step", "Card_Outcome_Recorded")
          .in("data->>pulseId", missing)
          .order("created_at", { ascending: true });
        for (const m of markersR.data ?? []) {
          const d = m.data as { pulseId?: string; office_location?: string | null } | null;
          if (d?.pulseId && d.office_location)
            officeByMid.set(String(d.pulseId), d.office_location);
        }
      }
    }
    const officeVolume: Record<string, Record<string, number>> = {};
    for (const c of counted) {
      const office = (c.mid && officeByMid.get(c.mid)) || DEFAULT_OFFICE;
      const vo = (officeVolume[office] ??= {});
      vo[c.cid] = (vo[c.cid] ?? 0) + c.amt;
    }

    return {
      points,
      volume,
      results,
      officePoints,
      officeVolume,
      officeResults,
      snapshotTeam,
    };
  });

/**
 * Clock-in presence for a set of LA work days — which user_ids hold a
 * non-voided time_entries row on each log_date (log_date is the Pacific day
 * of the punch-in; the payroll triggers maintain it). Powers the owner's
 * 2026-09-11 rule: the daily dispatch roster and every donut/suspension
 * list count only people who clocked in for the day.
 *
 * Runs on the service client because plain canvassers can only SELECT their
 * own time_entries while the leaderboard and Daily Wrap are all-viewer
 * surfaces. Ships presence ONLY — never punch times, hours, or pay.
 */
export const getClockPresence = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((data: unknown) => {
    const obj = data && typeof data === "object" ? (data as Record<string, unknown>) : {};
    const day = /^\d{4}-\d{2}-\d{2}$/;
    const raw = Array.isArray(obj.dates) ? obj.dates : [];
    if (raw.length === 0 || raw.length > 31) throw new Error("Invalid dates");
    const dates = [
      ...new Set(
        raw.map((d) => {
          if (typeof d !== "string" || !day.test(d)) throw new Error("Invalid dates");
          return d;
        }),
      ),
    ];
    return { dates };
  })
  .handler(async ({ data }) => {
    const { supabaseAdmin } = await import("@/integrations/supabase/client.server");
    const byDate: Record<string, string[]> = {};
    const seen = new Set<string>();
    // Paged: lunch splits mean several entries per person per day, and the
    // suspension window's 15 days × roster can pass PostgREST's 1,000-row
    // cap — a truncated fetch would silently hide clocked-in reps.
    const PAGE = 1000;
    for (let from = 0; ; from += PAGE) {
      const { data: rows, error } = await supabaseAdmin
        .from("time_entries")
        .select("user_id, log_date")
        .in("log_date", data.dates)
        .is("voided_at", null)
        .order("id", { ascending: true })
        .range(from, from + PAGE - 1);
      if (error) throw error;
      for (const r of rows ?? []) {
        const key = `${r.log_date}|${r.user_id}`;
        if (seen.has(key)) continue;
        seen.add(key);
        (byDate[r.log_date] ??= []).push(r.user_id);
      }
      if ((rows ?? []).length < PAGE) break;
    }
    // Who is ON the clock right now — open (un-clocked-out) shifts. Small
    // set (≤ headcount), one page is plenty; used for the per-row live dot.
    const { data: openRows, error: openErr } = await supabaseAdmin
      .from("time_entries")
      .select("user_id")
      .is("clock_out", null)
      .is("voided_at", null)
      .limit(1000);
    if (openErr) throw openErr;
    const openNow = [...new Set((openRows ?? []).map((r) => r.user_id as string))];
    return { byDate, openNow };
  });

/**
 * Company-wide funnel baseline for the canvasser page's shared rate engine
 * (owner decision, 2026-07-29: new reps see honest company averages, not
 * hardcoded starter rates and not their own RLS-scoped rows mislabeled as
 * "company"). Same transparency contract as getDispatchProduction: any
 * authenticated user, aggregates only — never raw rows.
 *
 * companyAvgCommission is the 60-day average confirmed sale price × the base
 * 1% commission rate (conservative; the 2% tier is deliberately ignored).
 */
export const getFunnelBaseline = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .handler(async () => {
    const { supabaseAdmin } = await import("@/integrations/supabase/client.server");
    const since = addDaysISO(laTodayISO(), -60);
    const PAGE = 1000;

    // Page every read — the unpaged select silently truncates at 1000 rows,
    // and the 60-day company window is already past 700 daily_logs rows
    // (the same failure class that dropped June's boards, PR #161).
    async function pageAll<T>(
      build: (from: number, to: number) => PromiseLike<{ data: T[] | null; error: unknown }>,
    ): Promise<T[]> {
      const out: T[] = [];
      for (let from = 0; ; from += PAGE) {
        const { data, error } = await build(from, from + PAGE - 1);
        if (error) throw error;
        out.push(...(data ?? []));
        if ((data ?? []).length < PAGE) break;
      }
      return out;
    }

    // Sits + sales live in daily_logs; confirms live in daily_metrics (the
    // office pipeline — daily_logs.confirmed_leads has never been written);
    // the door pair is pin-era only. See SplitFunnelInputs in lib/funnel.
    const [logRows, metricRows, saleRows] = await Promise.all([
      pageAll<{
        canvasser_id: string;
        log_date: string;
        doors_knocked: number | null;
        demos_sits: number | null;
        sales: number | null;
      }>((from, to) =>
        supabaseAdmin
          .from("daily_logs")
          .select("canvasser_id, log_date, doors_knocked, demos_sits, sales")
          .gte("log_date", since)
          .range(from, to),
      ),
      pageAll<{ canvasser_id: string; metric_date: string; leads_confirmed: number | null }>(
        (from, to) =>
          supabaseAdmin
            .from("daily_metrics")
            .select("canvasser_id, metric_date, leads_confirmed")
            .gte("metric_date", since)
            .range(from, to),
      ),
      pageAll<{ sale_amount: number | null }>((from, to) =>
        supabaseAdmin
          .from("leads")
          .select("sale_amount")
          .eq("status", "confirmed")
          .eq("is_sale", true)
          .gte("created_at", laMidnightUtcISO(since))
          .range(from, to),
      ),
    ]);

    // The era pair is PAIR-MATCHED: confirms count only on (rep, day)
    // combinations that actually logged doors. Pin adoption is partial, so
    // dividing everyone's confirms by only the pin-users' doors would
    // inflate lead-per-door ~10x — matched pairs keep both sides of the
    // fraction describing the same people on the same days.
    const split: SplitFunnelInputs = { ...EMPTY_SPLIT };
    const doorDays = new Set<string>();
    for (const r of logRows) {
      split.sits += r.demos_sits ?? 0;
      split.sales += r.sales ?? 0;
      if (r.log_date >= DOORS_TRACKED_SINCE && (r.doors_knocked ?? 0) > 0) {
        split.eraDoors += r.doors_knocked ?? 0;
        doorDays.add(`${r.canvasser_id}:${r.log_date}`);
      }
    }
    for (const m of metricRows) {
      split.confirmed += m.leads_confirmed ?? 0;
      if (
        m.metric_date >= DOORS_TRACKED_SINCE &&
        doorDays.has(`${m.canvasser_id}:${m.metric_date}`)
      ) {
        split.eraConfirmed += m.leads_confirmed ?? 0;
      }
    }

    const revenue = saleRows.reduce((a, r) => a + Number(r.sale_amount ?? 0), 0);
    const avgSale = saleRows.length > 0 ? revenue / saleRows.length : 0;

    return { split, companyAvgCommission: avgSale * COMMISSION_BASE };
  });
