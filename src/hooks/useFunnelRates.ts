import { useMemo } from "react";
import { useQuery } from "@tanstack/react-query";
import {
  EMPTY_AGGREGATE,
  deriveRates,
  personalRatesQualify,
  ratesUsable,
  type ConversionRates,
  type FunnelAggregate,
} from "@/lib/funnel";
import { getFunnelBaseline } from "@/lib/dispatch.functions";
import { useSixtyDayLogs } from "@/hooks/useDailyLogs";
import { useCanvasserProfile } from "@/hooks/useCanvasserProfile";

/**
 * The ONE source of conversion rates for the canvasser Mission page — both
 * horizons of the Plan tab's back-solve (PlanPanel) run on these rates so
 * they can never disagree. Personal 60-day history wins
 * when it has enough volume AND every rate is derivable from it; otherwise
 * the company-wide baseline (server fn — real averages, not RLS-scoped
 * self-data). `rates: null` means neither source can support the math —
 * consumers render their explanatory empty state, never invented constants.
 *
 * Personal history rides the shared useSixtyDayLogs cache — the same rows
 * the Stats aggregates read, so rate derivation costs zero extra fetches.
 */
export function useFunnelRates(userId: string): {
  rates: ConversionRates | null;
  source: "personal" | "company";
  personalAggregate: FunnelAggregate;
  sampleDoors: number;
  companyAvgCommission: number;
  isLoading: boolean;
} {
  const logsQ = useSixtyDayLogs(userId);

  const personal = useMemo(
    () =>
      (logsQ.data ?? []).reduce<FunnelAggregate>(
        (a, r) => ({
          doors: a.doors + (r.doors_knocked ?? 0),
          confirmed: a.confirmed + (r.confirmed_leads ?? 0),
          sits: a.sits + (r.demos_sits ?? 0),
          sales: a.sales + (r.sales ?? 0),
        }),
        { ...EMPTY_AGGREGATE },
      ),
    [logsQ.data],
  );

  const baselineQ = useQuery({
    queryKey: ["funnel", "baseline"],
    queryFn: async () => getFunnelBaseline(),
  });

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
    isLoading: logsQ.isLoading || baselineQ.isLoading,
  };
}
