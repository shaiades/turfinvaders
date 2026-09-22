import { useCallback, useMemo } from "react";
import { useQuery } from "@tanstack/react-query";
import { supabase } from "@/integrations/supabase/client";
import { addDaysISO, weekStartOfISO } from "@/lib/dates";
import { getClockPresence } from "@/lib/dispatch.functions";
import { isRecentlyActive, lastActiveMap, SUSPENSION_RECENCY_DAYS } from "@/lib/suspension";
import { isLeadSourceName } from "@/lib/lead-sources";

/**
 * The Daily Wrap's row-building, extracted (2026-09-22) so the wrap PAGE and
 * the end-of-day recap CUTSCENE (EodRecapFx) share one truth about who counts
 * and what a day's leads are — the pseudo-source roster filter, the
 * graced/active/tracked/recent flags, and the confirmed+submitted formula.
 * Parameterized by the anchor day: the wrap passes the live report anchor
 * (`reportDates().today`), the recap passes the completed report day, so the
 * two never share a cache entry but always share the rules. Query keys keep
 * the ["daily_wrap", …] prefix so useRosterActions' prefix invalidation
 * covers both surfaces.
 */

export type WrapRow = {
  id: string;
  name: string;
  todayLeads: number;
  ydayLeads: number;
  /** Leads on the day BEFORE yday — the second judged day of the zero lists. */
  yday2Leads: number;
  weekPoints: number;
  recent: boolean;
  tracked: boolean;
  /** false = archived/removed — off the zero lists, but earned awards stay. */
  active: boolean;
  /** First-week rookie with no credited day yet — off the zero lists. */
  graced: boolean;
};

/** Rows for the wrap/recap, anchored to `anchorISO` (the "today" slot):
 *  todayLeads = leads on the anchor, ydayLeads = anchor-1, yday2Leads =
 *  anchor-2; weekPoints scoped to the anchor's LA week. */
export function useDailyWrapRows(anchorISO: string, enabled = true) {
  const yday = addDaysISO(anchorISO, -1);
  const yday2 = addDaysISO(yday, -1);
  const wkStart = weekStartOfISO(anchorISO);
  return useQuery({
    queryKey: ["daily_wrap", anchorISO],
    enabled,
    queryFn: async (): Promise<WrapRow[]> => {
      // Fetch back far enough to judge 7-day recency even on a Monday/Tuesday,
      // when wkStart is only 0–1 days back.
      const cutoff = addDaysISO(anchorISO, -SUSPENSION_RECENCY_DAYS);
      const metricsStart = cutoff < wkStart ? cutoff : wkStart;
      const [profilesR, metricsR] = await Promise.all([
        supabase
          .from("profiles")
          .select("id, display_name, status, created_at, suspension_tracked, is_active")
          .neq("status", "inactive"),
        supabase
          .from("daily_metrics")
          .select("canvasser_id, metric_date, leads_confirmed, leads_submitted, pitch_missed, sales")
          .gte("metric_date", metricsStart),
      ]);
      const profiles = profilesR.data ?? [];
      const metrics = metricsR.data ?? [];

      const byUser = new Map<string, { today: number; yday: number; yday2: number; pts: number }>();
      for (const m of metrics) {
        const rec = byUser.get(m.canvasser_id) ?? { today: 0, yday: 0, yday2: 0, pts: 0 };
        const leads = (m.leads_confirmed ?? 0) + (m.leads_submitted ?? 0);
        if (m.metric_date === anchorISO) rec.today += leads;
        if (m.metric_date === yday) rec.yday += leads;
        if (m.metric_date === yday2) rec.yday2 += leads;
        // Points stay week-scoped even though the fetch may reach further back.
        if (m.metric_date >= wkStart) rec.pts += (m.pitch_missed ?? 0) * 1 + (m.sales ?? 0) * 2;
        byUser.set(m.canvasser_id, rec);
      }
      const lastMap = lastActiveMap(metrics);
      // Pseudo lead-source channels (Job Walk, Upsell, …) live in profiles
      // but are the office's credit, never canvassers (owner rule, PR
      // #133/#172) — they must not appear as winners, bosses, or doughnuts.
      const people = profiles.filter((p) => !isLeadSourceName(p.display_name));
      return people.map((p) => {
        const r = byUser.get(p.id) ?? { today: 0, yday: 0, yday2: 0, pts: 0 };
        return {
          id: p.id,
          name: p.display_name ?? "Unknown",
          todayLeads: r.today,
          ydayLeads: r.yday,
          yday2Leads: r.yday2,
          weekPoints: r.pts,
          recent: isRecentlyActive(anchorISO, [p.id], lastMap, (p.created_at ?? "").slice(0, 10)),
          tracked: p.suspension_tracked !== false,
          // Archive writes is_active, never the status enum — an archived rep
          // must leave the zero lists immediately but keep any earned awards.
          active: p.is_active !== false,
          // 1-week rookie grace (owner decision 2026-09-09) — display-side only;
          // real suspension tracking in lib/suspension.ts is untouched. The
          // metrics fetch reaches at least `cutoff` back, so lastMap covers a
          // graced rookie's whole tenure.
          graced: (p.created_at ?? "").slice(0, 10) >= cutoff && !lastMap.has(p.id),
        };
      });
    },
  });
}

/** Clock presence for the given PT days, via the getClockPresence server fn
 *  (canvassers can only read their own time_entries directly). `clockReady`
 *  is SUCCESS only — on error the zero lists must stay empty: missing data
 *  never flags a person. `clockSettled` also covers the error path, for
 *  callers that must decide once the fetch has concluded either way. */
export function useClockPresence(dates: string[], enabled = true) {
  const clockQ = useQuery({
    queryKey: ["daily_wrap", "clock", dates],
    enabled,
    queryFn: async () => getClockPresence({ data: { dates } }),
  });
  const clockedSets = useMemo(() => {
    const m = new Map<string, Set<string>>();
    for (const [d, ids] of Object.entries(clockQ.data?.byDate ?? {})) m.set(d, new Set(ids));
    return m;
  }, [clockQ.data]);
  const clockedOn = useCallback(
    (id: string, day: string) => clockedSets.get(day)?.has(id) ?? false,
    [clockedSets],
  );
  return {
    clockReady: clockQ.isSuccess,
    clockSettled: clockQ.isSuccess || clockQ.isError,
    clockedOn,
  };
}
