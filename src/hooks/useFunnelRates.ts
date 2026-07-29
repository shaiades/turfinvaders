import { useQuery } from "@tanstack/react-query";
import { supabase } from "@/integrations/supabase/client";
import { addDaysISO, laTodayISO } from "@/lib/dates";
import {
  EMPTY_AGGREGATE,
  deriveRates,
  personalRatesQualify,
  ratesUsable,
  type ConversionRates,
  type FunnelAggregate,
} from "@/lib/funnel";
import { getFunnelBaseline } from "@/lib/dispatch.functions";

/**
 * The ONE source of conversion rates for the canvasser page — shared by the
 * monthly Mission (CanvasserPersonalDashboard) and the WeeklyPlaybook so
 * their numbers can never disagree on rates. Personal 60-day history wins
 * when it has enough volume AND every rate is derivable from it; otherwise
 * the company-wide baseline (server fn — real averages, not RLS-scoped
 * self-data). `rates: null` means neither source can support the math —
 * consumers render their explanatory empty state, never invented constants.
 */
export function useFunnelRates(userId: string): {
  rates: ConversionRates | null;
  source: "personal" | "company";
  personalAggregate: FunnelAggregate;
  sampleDoors: number;
  companyAvgCommission: number;
  isLoading: boolean;
} {
  const personalQ = useQuery({
    queryKey: ["funnel", "personal", userId],
    queryFn: async () => {
      const since = addDaysISO(laTodayISO(), -60);
      const { data, error } = await supabase
        .from("daily_logs")
        .select("doors_knocked, confirmed_leads, demos_sits, sales")
        .eq("canvasser_id", userId)
        .gte("log_date", since);
      if (error) throw error;
      return (data ?? []).reduce<FunnelAggregate>(
        (a, r) => ({
          doors: a.doors + (r.doors_knocked ?? 0),
          confirmed: a.confirmed + (r.confirmed_leads ?? 0),
          sits: a.sits + (r.demos_sits ?? 0),
          sales: a.sales + (r.sales ?? 0),
        }),
        { ...EMPTY_AGGREGATE },
      );
    },
  });

  const baselineQ = useQuery({
    queryKey: ["funnel", "baseline"],
    queryFn: async () => getFunnelBaseline(),
  });

  const personal = personalQ.data ?? EMPTY_AGGREGATE;
  const company = baselineQ.data?.aggregate ?? EMPTY_AGGREGATE;

  const personalRates = deriveRates(personal);
  const companyRates = deriveRates(company);
  // Personal must both qualify on volume AND yield usable rates — 200 doors
  // with zero sales must fall back to the baseline, not to "unavailable".
  const usePersonal = personalRatesQualify(personal) && ratesUsable(personalRates);

  return {
    rates: usePersonal ? personalRates : ratesUsable(companyRates) ? companyRates : null,
    source: usePersonal ? "personal" : "company",
    personalAggregate: personal,
    sampleDoors: personal.doors,
    companyAvgCommission: baselineQ.data?.companyAvgCommission ?? 0,
    isLoading: personalQ.isLoading || baselineQ.isLoading,
  };
}

export type ProfileGoals = {
  monthly_goal: number | null;
  weekly_income_goal: number | null;
  avg_commission: number | null;
};

/** Both goal panels (Mission + Playbook) read this ONE query and both goal
 *  mutations invalidate it — editing a goal in either panel updates both. */
export function useProfileGoals(userId: string) {
  return useQuery({
    queryKey: ["profile_goals", userId],
    queryFn: async () => {
      const { data, error } = await supabase
        .from("profiles")
        .select("monthly_goal, weekly_income_goal, avg_commission")
        .eq("id", userId)
        .maybeSingle();
      if (error) throw error;
      return data as ProfileGoals | null;
    },
  });
}
