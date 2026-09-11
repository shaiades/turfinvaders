import { useMemo } from "react";
import { useQuery } from "@tanstack/react-query";
import {
  DOORS_TRACKED_SINCE,
  EMPTY_SPLIT,
  deriveSplitRates,
  personalRatesQualify,
  ratesUsable,
  type ConversionRates,
  type SplitFunnelInputs,
} from "@/lib/funnel";
import { getFunnelBaseline } from "@/lib/dispatch.functions";
import { useSixtyDayLogs } from "@/hooks/useDailyLogs";
import { useSixtyDaySelfMetrics } from "@/hooks/useSelfMetrics";

/**
 * The ONE source of conversion rates for the canvasser page — both horizons
 * of the Plan tab's back-solve AND the piggy bank's value-per-door run on
 * these rates so they can never disagree. Personal history wins when it has
 * enough volume; otherwise the company-wide baseline (server fn — real
 * averages, not RLS-scoped self-data). `rates: null` means neither source
 * can support the math — consumers render their explanatory empty state,
 * never invented constants.
 *
 * Stage sourcing (2026-09-11 audit): confirms come from daily_metrics — the
 * office pipeline; daily_logs.confirmed_leads has NEVER been written, which
 * is why rates were null for everyone since launch. Sits/sales stay on
 * daily_logs, and the lead-per-door pair uses the pin era only
 * (DOORS_TRACKED_SINCE) — doors barely exist before the knock trigger.
 */
export function useFunnelRates(userId: string): {
  rates: ConversionRates | null;
  source: "personal" | "company";
  /** Pin-era doors backing the personal rates (the qualify denominator). */
  sampleDoors: number;
  companyAvgCommission: number;
  isLoading: boolean;
} {
  const logsQ = useSixtyDayLogs(userId);
  const metricsQ = useSixtyDaySelfMetrics(userId);

  const personal = useMemo(() => {
    // Pair-matched like the company baseline: era confirms count only on
    // days this rep actually logged doors — an office-fed confirm on a day
    // off must not inflate their own lead-per-door.
    const split: SplitFunnelInputs = { ...EMPTY_SPLIT };
    const doorDays = new Set<string>();
    for (const r of logsQ.data ?? []) {
      split.sits += r.demos_sits ?? 0;
      split.sales += r.sales ?? 0;
      if (r.log_date >= DOORS_TRACKED_SINCE && (r.doors_knocked ?? 0) > 0) {
        split.eraDoors += r.doors_knocked ?? 0;
        doorDays.add(r.log_date);
      }
    }
    for (const m of metricsQ.data ?? []) {
      split.confirmed += m.leads_confirmed ?? 0;
      if (m.metric_date >= DOORS_TRACKED_SINCE && doorDays.has(m.metric_date)) {
        split.eraConfirmed += m.leads_confirmed ?? 0;
      }
    }
    return split;
  }, [logsQ.data, metricsQ.data]);

  const baselineQ = useQuery({
    queryKey: ["funnel", "baseline"],
    // 60-day company aggregate — refetching the server fn on every window
    // focus is pure waste on the field route, which refocuses all shift.
    staleTime: 15 * 60_000,
    queryFn: async () => getFunnelBaseline(),
  });

  const company = baselineQ.data?.split ?? EMPTY_SPLIT;

  const personalRates = deriveSplitRates(personal);
  const companyRates = deriveSplitRates(company);
  // Personal must both qualify on volume AND yield usable rates — 200 doors
  // with zero sales must fall back to the baseline, not to "unavailable".
  const usePersonal =
    personalRatesQualify({
      doors: personal.eraDoors,
      confirmed: personal.confirmed,
      sits: personal.sits,
      sales: personal.sales,
    }) && ratesUsable(personalRates);

  return {
    rates: usePersonal ? personalRates : ratesUsable(companyRates) ? companyRates : null,
    source: usePersonal ? "personal" : "company",
    sampleDoors: personal.eraDoors,
    companyAvgCommission: baselineQ.data?.companyAvgCommission ?? 0,
    isLoading: logsQ.isLoading || metricsQ.isLoading || baselineQ.isLoading,
  };
}
