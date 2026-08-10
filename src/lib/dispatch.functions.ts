import { createServerFn } from "@tanstack/react-start";
import { requireSupabaseAuth } from "@/integrations/supabase/auth-middleware";
import { COMMISSION_BASE, weeklyPoints } from "@/lib/pay";
import { addDaysISO, laMidnightUtcISO, laTodayISO } from "@/lib/dates";
import { DEFAULT_OFFICE } from "@/lib/offices";
import { EMPTY_AGGREGATE, type FunnelAggregate } from "@/lib/funnel";

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
          "canvasser_id, demos_sits, sales, no_demo, future_leads, ctc, non_core, one_legs, unmarked, office_location, log_date",
        )
        .gte("log_date", data.log_start)
        .lte("log_date", data.log_end),
      // Two-sided superset fetch; the COALESCE(reviewed_at, created_at)
      // re-window below is the authoritative filter (pay-engine parity).
      supabaseAdmin
        .from("leads")
        .select("canvasser_id, sale_amount, created_at, reviewed_at, monday_item_id")
        .eq("status", "confirmed")
        .or(
          `and(created_at.gte.${data.vol_start},created_at.lt.${data.vol_end}),and(reviewed_at.gte.${data.vol_start},reviewed_at.lt.${data.vol_end})`,
        ),
    ]);
    if (logsR.error) throw logsR.error;
    if (leadsR.error) throw leadsR.error;

    const points: Record<string, number> = {};
    const results: Record<string, DispatchResults> = {};
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
    });
    for (const l of logsR.data ?? []) {
      if (!l.canvasser_id) continue;
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
      }
    }

    const volStartMs = Date.parse(data.vol_start);
    const volEndMs = Date.parse(data.vol_end);
    const volume: Record<string, number> = {};
    const counted: Array<{ cid: string; amt: number; mid: string | null }> = [];
    for (const l of leadsR.data ?? []) {
      if (!l.canvasser_id) continue;
      const at = Date.parse(l.reviewed_at ?? l.created_at ?? "");
      if (Number.isNaN(at) || at < volStartMs || at >= volEndMs) continue;
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

    return { points, volume, results, officePoints, officeVolume, officeResults };
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

    const [logsR, salesR] = await Promise.all([
      supabaseAdmin
        .from("daily_logs")
        .select("doors_knocked, confirmed_leads, demos_sits, sales")
        .gte("log_date", since),
      supabaseAdmin
        .from("leads")
        .select("sale_amount")
        .eq("status", "confirmed")
        .eq("is_sale", true)
        .gte("created_at", laMidnightUtcISO(since)),
    ]);
    if (logsR.error) throw logsR.error;
    if (salesR.error) throw salesR.error;

    const aggregate: FunnelAggregate = (logsR.data ?? []).reduce(
      (a, r) => ({
        doors: a.doors + (r.doors_knocked ?? 0),
        confirmed: a.confirmed + (r.confirmed_leads ?? 0),
        sits: a.sits + (r.demos_sits ?? 0),
        sales: a.sales + (r.sales ?? 0),
      }),
      { ...EMPTY_AGGREGATE },
    );

    const saleRows = salesR.data ?? [];
    const revenue = saleRows.reduce((a, r) => a + Number(r.sale_amount ?? 0), 0);
    const avgSale = saleRows.length > 0 ? revenue / saleRows.length : 0;

    return { aggregate, companyAvgCommission: avgSale * COMMISSION_BASE };
  });
