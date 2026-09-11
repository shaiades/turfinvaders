import { useRealtimeInvalidate } from "@/hooks/useRealtimeInvalidate";
import {
  HOURLY_MID,
  HOURLY_TOP,
  POINTS_TIER_MID,
  POINTS_TIER_TOP,
  payRateForPoints,
  weeklyPoints,
} from "@/lib/pay";
import { addDaysISO, laWeekStartISO } from "@/lib/dates";
import { RankPill } from "@/components/RankPill";
import { metricText } from "@/components/arcade";
import { dailyLogKeys, sumLogCounters, useSixtyDayLogs, useTodayLogs } from "@/hooks/useDailyLogs";
import { useCanvasserProfile } from "@/hooks/useCanvasserProfile";
import { useOpenShift, useTodayShifts } from "@/hooks/useTimeClockSelf";

/**
 * The canvasser HUD — a one-line score strip pinned inside the sticky header
 * so a canvasser mid-street never hunts for their number. Points are
 * WEEK-scoped (audit 2026-09-11): the pay tiers read weekly points, so the
 * ever-present number is the one that actually moves the hourly rate, with
 * the distance to the next tier beside it. Leads stay today-scoped — the
 * day's leading indicator. Renders ONLY for canvassers; rides the shared
 * self caches (today logs, 60d logs, profile, punch state) — zero fetches
 * beyond what Mission already loads.
 *
 * OFF CLOCK alarm: production with no punch never counts (dispatch roster,
 * donut protection, base pay all gate on the punch), so knocked doors with
 * zero punched time today is the one state worth shouting about.
 */
export function CanvasserHUD({ userId }: { userId: string }) {
  const logs = useTodayLogs(userId);
  const sixty = useSixtyDayLogs(userId);
  const profile = useCanvasserProfile(userId);
  const openShift = useOpenShift(userId);
  const todayShifts = useTodayShifts(userId);

  // New pings land on the HUD the moment they hit daily_logs. Invalidate the
  // whole self prefix, not just today's key — the 60d cache feeds the Stats
  // aggregates and Plan-tab funnel rates, and a cross-device write must
  // reach those too.
  useRealtimeInvalidate({
    channel: "canvasser-hud",
    tables: ["daily_logs"],
    invalidateKeys: [dailyLogKeys.all(userId)],
  });

  const totals = sumLogCounters(logs.data);
  const called = totals.leads_called_in;

  // Mon–Sat week window, matching calc_weekly_paycheck.
  const wkStart = laWeekStartISO();
  const wkEnd = addDaysISO(wkStart, 5);
  const weekRows = (sixty.data ?? []).filter((r) => r.log_date >= wkStart && r.log_date <= wkEnd);
  const wk = sumLogCounters(weekRows);
  const wkPts = weeklyPoints(wk.demos_sits, wk.sales);

  const rank = profile.data?.current_rank ?? "Jr. Silver";
  const rankForRates = profile.data?.pay_lock_status === "reverted" ? null : rank;
  const rateLocked = payRateForPoints(0, rankForRates) === HOURLY_TOP;
  const tierHint = rateLocked
    ? `$${HOURLY_TOP}/hr locked`
    : wkPts >= POINTS_TIER_TOP
      ? `$${HOURLY_TOP}/hr max`
      : wkPts >= POINTS_TIER_MID
        ? `${POINTS_TIER_TOP - wkPts} to $${HOURLY_TOP}/hr`
        : `${POINTS_TIER_MID - wkPts} to $${HOURLY_MID}/hr`;

  // Zero ≠ error: a dead fetch must not flash a live-looking 0 mid-street —
  // it reads as a muted dash until the next successful refetch.
  const broken = logs.isError || profile.isError;
  const wkBroken = sixty.isError;

  // Alarm only when punch state is KNOWN: doors on the board, no open shift,
  // and no billable time today. Pending/error punch reads stay silent —
  // never cry wolf off missing data.
  const billableToday = (todayShifts.data ?? []).reduce(
    (a, r) => a + Number(r.billable_hours ?? 0),
    0,
  );
  const offClock =
    openShift.isSuccess &&
    todayShifts.isSuccess &&
    !openShift.data &&
    billableToday === 0 &&
    totals.doors_knocked > 0;

  return (
    <div
      data-tour="hud"
      className="border-t border-border/60 px-4 py-1.5 flex items-center justify-between gap-3 text-[10px] font-display uppercase tracking-widest"
    >
      {offClock ? (
        <span className="animate-pulse rounded-full border border-[var(--destructive)] px-2 py-0.5 text-[var(--destructive)]">
          ⚠ Off the clock
        </span>
      ) : (
        <RankPill rank={rank} tappable />
      )}
      <div className="flex items-center gap-3 tabular-nums">
        <span className="text-muted-foreground">
          Leads ·{" "}
          <span className={broken ? "text-muted-foreground/40" : metricText(called, "text-neon")}>
            {broken ? "—" : called}
          </span>
        </span>
        <span className="text-muted-foreground">
          Wk Pts ·{" "}
          <span
            className={wkBroken ? "text-muted-foreground/40" : metricText(wkPts, "text-victory")}
          >
            {wkBroken ? "—" : wkPts}
          </span>
        </span>
        {!wkBroken && (
          <span className="hidden min-[400px]:inline text-muted-foreground/70">{tierHint}</span>
        )}
      </div>
    </div>
  );
}
