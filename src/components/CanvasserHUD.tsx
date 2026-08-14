import { useRealtimeInvalidate } from "@/hooks/useRealtimeInvalidate";
import { weeklyPoints } from "@/lib/pay";
import { laTodayISO } from "@/lib/dates";
import { RankPill } from "@/components/RankPill";
import { metricText } from "@/components/arcade";
import { dailyLogKeys, sumLogCounters, useTodayLogs } from "@/hooks/useDailyLogs";
import { useCanvasserProfile } from "@/hooks/useCanvasserProfile";

/**
 * The canvasser HUD — a one-line score strip pinned inside the sticky header
 * so a canvasser mid-street never hunts for their number: today's points
 * (PM = 1, Sale = 2 — same weeklyPoints math as the pay engine reads),
 * today's called-in leads, and their SCCE rank. Renders ONLY for canvassers;
 * every other role gets zero extra DOM. Rides the shared today-logs and
 * canvasser-profile caches — zero extra fetches beyond what the Mission
 * page already loads.
 */
export function CanvasserHUD({ userId }: { userId: string }) {
  const today = laTodayISO();
  const logs = useTodayLogs(userId);
  const profile = useCanvasserProfile(userId);

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
  const points = weeklyPoints(totals.demos_sits, totals.sales);
  const called = totals.leads_called_in;

  return (
    <div className="border-t border-border/60 px-4 py-1.5 flex items-center justify-between gap-3 text-[10px] font-display uppercase tracking-widest">
      <RankPill rank={profile.data?.current_rank ?? "Jr. Silver"} />
      <div className="flex items-center gap-4 tabular-nums">
        <span className="text-muted-foreground">
          Leads Today · <span className={metricText(called, "text-neon")}>{called}</span>
        </span>
        <span className="text-muted-foreground">
          Pts Today · <span className={metricText(points, "text-victory")}>{points}</span>
        </span>
      </div>
    </div>
  );
}
