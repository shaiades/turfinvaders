import { useRef } from "react";
import { laTodayISO } from "@/lib/dates";
import { expectedValuePerDoor, resolveAvgCommission } from "@/lib/funnel";
import { DEFAULT_AVG_COMMISSION, DEFAULT_WEEKLY_GOAL } from "@/hooks/useCanvasserStats";
import { useCanvasserProfile } from "@/hooks/useCanvasserProfile";
import { useFunnelRates } from "@/hooks/useFunnelRates";
import { useMyEarnings } from "@/hooks/useMyEarnings";
import { sumLogCounters, useTodayLogs } from "@/hooks/useDailyLogs";
import { useMyPinsToday } from "@/hooks/useFieldPins";

/**
 * The piggy-bank feed: PROJECTED dollars banked today — knocks × the
 * expected commission value of one door (live funnel rates × avg
 * commission). Projected only, never payroll: real money comes exclusively
 * from calc_weekly_paycheck, and every surface must say "projected".
 *
 * Deliberately composed from the four cheap primitives instead of
 * useCanvasserStats, which would drag two paycheck RPCs, the MTD sales
 * query, and clocked hours onto the field route.
 */
export type PiggyBank = {
  /** max(server doors_knocked, valid pins incl. optimistic) — instant on
   *  tap, converges to server truth, and counts manually-logged doors. */
  knocks: number;
  /** Expected $ per door right now; null = rates unavailable (doors-only mode). */
  perKnock: number | null;
  /** Latched bank total; null = doors-only mode. */
  dollars: number | null;
  /** Knocks still needed THIS WEEK to close the income-goal gap at the
   *  current per-knock value; null when rates or earnings are unavailable,
   *  0 when the goal is already covered. */
  paceKnocks: number | null;
  source: "personal" | "company";
  isLoading: boolean;
};

export function usePiggyBank(userId: string | undefined): PiggyBank {
  const { query: pinsQuery } = useMyPinsToday(userId);
  const todayLogs = useTodayLogs(userId);
  const profile = useCanvasserProfile(userId);
  const funnel = useFunnelRates(userId ?? "");

  // Remote drops are stat-dead in the bump trigger; legacy null flags count,
  // matching the trigger. Optimistic rows are in this array already.
  const validPins = (pinsQuery.data ?? []).filter((p) => !p.is_remote_drop).length;
  const serverDoors = sumLogCounters(todayLogs.data).doors_knocked;
  const knocks = Math.max(validPins, serverDoors);

  const perKnock = expectedValuePerDoor(
    funnel.rates,
    resolveAvgCommission(
      profile.data?.avg_commission,
      funnel.companyAvgCommission,
      DEFAULT_AVG_COMMISSION,
    ),
  );

  // Latch between knocks: the bank total only moves when knocks moves (or
  // when a null rate first resolves). Rate churn between knocks — baseline
  // refetch, an avg_commission edit, personal/company source flip — is
  // absorbed into the next knock's tick instead of visibly shrinking the
  // bank. Nothing is persisted; every recompute uses live column-traceable
  // data. Day rollover resets the latch with the LA-day-scoped caches.
  const day = laTodayISO();
  const latch = useRef<{ day: string; knocks: number; dollars: number | null }>({
    day: "",
    knocks: -1,
    dollars: null,
  });
  if (
    latch.current.day !== day ||
    latch.current.knocks !== knocks ||
    (latch.current.dollars === null && perKnock !== null)
  ) {
    latch.current = {
      day,
      knocks,
      dollars: perKnock === null ? null : knocks * perKnock,
    };
  }

  // Pace: how many knocks the rest of the week must produce at today's
  // per-knock value to cover what the weekly goal still needs. weekEarned is
  // pay-engine truth (shared cache with Mission — one fetch per session).
  const earnings = useMyEarnings(userId ?? "");
  const weeklyGoal =
    Number(profile.data?.weekly_income_goal ?? 0) || DEFAULT_WEEKLY_GOAL;
  const paceKnocks =
    perKnock !== null && perKnock > 0 && !earnings.isLoading
      ? Math.max(0, Math.ceil(Math.max(0, weeklyGoal - earnings.weekEarned) / perKnock))
      : null;

  return {
    knocks,
    perKnock,
    dollars: latch.current.dollars,
    paceKnocks,
    source: funnel.source,
    isLoading: funnel.isLoading || (pinsQuery.isLoading && todayLogs.isLoading),
  };
}
