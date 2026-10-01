// Shared Weekly Action Plan data + assembly (owner directive 2026-10-01).
// One queryFn for the Plan tab, the weekly popup, the tab badge and the
// leadership view — react-query dedupes, so mounting all four costs one
// fetch. Reads are mirror-table only (production_jobs + overrides); the
// plan itself is computed client-side by the pure action-plan engine.

import { useMemo } from "react";
import { useQuery } from "@tanstack/react-query";
import { supabase } from "@/integrations/supabase/client";
import { buildRepMatcher } from "@/lib/rep-identity";
import { laTodayISO, planWeekStartISO } from "@/lib/dates";
import { buildWeeklyPlan, type PlanJob, type WeeklyPlan } from "@/lib/action-plan";
import type { HomeownerOverride } from "@/lib/production-jobs";

const PAGE = 1000;

export type OverrideRow = HomeownerOverride & {
  monday_item_id: string;
};

/** Plan clock: on an LA Sunday both values are the upcoming Monday, so every
 *  state/score/route computation shows Monday's truth (spec §1/§11). */
export function planClock(): { planWeekStart: string; anchorISO: string; isSundayPreview: boolean } {
  const planWeekStart = planWeekStartISO();
  const today = laTodayISO();
  const isSundayPreview = planWeekStart > today;
  return { planWeekStart, anchorISO: isSundayPreview ? planWeekStart : today, isSundayPreview };
}

export function useProductionJobs(enabled = true) {
  return useQuery({
    queryKey: ["production_jobs"],
    enabled,
    staleTime: 60_000,
    queryFn: async ({ signal }): Promise<PlanJob[]> => {
      const rows: PlanJob[] = [];
      for (let from = 0; ; from += PAGE) {
        const { data, error } = await supabase
          .from("production_jobs")
          .select(
            "monday_item_id, group_id, group_title, homeowner_name, reps, pm_name, projects, reloads, reloaded, advantage_plus, address, lat, lng, zip, sale_amount, schedule_start, schedule_end, prev_schedule_start, prev_schedule_end, completion_date, delayed_until, status_label, reviews_status, referral_status, homeowner_status, homeowner_status_reason, homeowner_status_note_date",
          )
          .order("monday_item_id")
          .range(from, from + PAGE - 1)
          .abortSignal(signal);
        if (error) throw error;
        rows.push(...((data ?? []) as PlanJob[]));
        if (!data || data.length < PAGE) break;
      }
      return rows;
    },
  });
}

export function useProductionOverrides(enabled = true) {
  return useQuery({
    queryKey: ["production_job_overrides"],
    enabled,
    staleTime: 60_000,
    queryFn: async ({ signal }): Promise<OverrideRow[]> => {
      // Deliberately narrow: `note` (leadership commentary) and `set_by`
      // never reach rep browsers, even though RLS would allow them today.
      const { data, error } = await supabase
        .from("production_job_overrides")
        .select("monday_item_id, homeowner_status, based_on_note_date")
        .abortSignal(signal);
      if (error) throw error;
      return (data ?? []) as OverrideRow[];
    },
  });
}

export type WeeklyPlanResult = {
  status: "loading" | "error" | "ready";
  plan: WeeklyPlan | null;
  /** The board rep name resolved as "me" (null = no safe match). */
  matchedName: string | null;
  /** Every rep name present on the mirrored jobs (leadership roster). */
  allRepNames: string[];
  planWeekStart: string;
  anchorISO: string;
  isSundayPreview: boolean;
};

/** Assemble the weekly plan for one display name (the signed-in rep, a View
 *  As preview, or a leadership-picked board name). */
export function useWeeklyPlan(displayName: string | null | undefined, enabled = true): WeeklyPlanResult {
  const jobsQuery = useProductionJobs(enabled);
  const overridesQuery = useProductionOverrides(enabled);
  const { planWeekStart, anchorISO, isSundayPreview } = planClock();

  return useMemo(() => {
    const status: WeeklyPlanResult["status"] =
      jobsQuery.isError || overridesQuery.isError
        ? "error"
        : jobsQuery.isSuccess && overridesQuery.isSuccess
          ? "ready"
          : "loading";
    const jobs = jobsQuery.data ?? [];
    const names = new Set<string>();
    for (const j of jobs) for (const r of j.reps) names.add(r);
    const allRepNames = [...names].sort((a, b) => a.localeCompare(b));
    if (status !== "ready") {
      return { status, plan: null, matchedName: null, allRepNames, planWeekStart, anchorISO, isSundayPreview };
    }
    // A separate matcher for THIS data pool (Close Kombat doctrine: one
    // matcher per pool — the Block-board matcher must not leak in here).
    const matcher = buildRepMatcher(displayName, allRepNames);
    const overrides = new Map<string, HomeownerOverride>(
      (overridesQuery.data ?? []).map((o) => [
        o.monday_item_id,
        { homeowner_status: o.homeowner_status, based_on_note_date: o.based_on_note_date },
      ]),
    );
    const plan = buildWeeklyPlan({
      jobs,
      overrides,
      isMine: matcher.isMe,
      anchorISO,
      planWeekStart,
    });
    return {
      status,
      plan,
      matchedName: matcher.matched,
      allRepNames,
      planWeekStart,
      anchorISO,
      isSundayPreview,
    };
  }, [
    jobsQuery.isError,
    jobsQuery.isSuccess,
    jobsQuery.data,
    overridesQuery.isError,
    overridesQuery.isSuccess,
    overridesQuery.data,
    displayName,
    planWeekStart,
    anchorISO,
    isSundayPreview,
  ]);
}
