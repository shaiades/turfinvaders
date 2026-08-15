import { useEffect } from "react";
import { getRouteApi } from "@tanstack/react-router";
import { useQuery } from "@tanstack/react-query";
import { supabase } from "@/integrations/supabase/client";
import { formatCurrency } from "@/lib/utils";
import { laMonthStartISO } from "@/lib/dates";
import { PAY_LOCK_MIN_ROLLING_AVG, VOLUME_BONUS_STEP } from "@/lib/pay";
import { getMonthlyPaychecks } from "@/lib/fleet.functions";
import { useRealtimeInvalidate } from "@/hooks/useRealtimeInvalidate";
import { useCanvasserProfile } from "@/hooks/useCanvasserProfile";
import { useCanvasserStats } from "@/hooks/useCanvasserStats";
import { ArcadeCard, TeamBadge } from "@/components/arcade";
import { Tabs, TabsList, TabsTrigger, TabsContent } from "@/components/ui/tabs";
import { RankPill, RANK_PERKS } from "@/components/RankPill";
import { TimeClock } from "@/components/TimeClock";
import { PlanPanel } from "@/components/PlanPanel";
import { DailyLogPanel } from "@/components/DailyLogPanel";
import { CanvasserStats } from "@/components/CanvasserStats";
import { LearnPanel } from "@/components/LearnPanel";

/**
 * The canvasser Mission page — Stats, Playbook, and the Daily Log merged
 * into one screen (2026-08-14). Always-on header stack (time clock, pay,
 * SCCE rank), then three tabs in day order: Plan (goal → funnel back-solve),
 * Log (today's counts + lead submission), Stats (today/week/MTD review).
 * Tab selection lives in /dashboard's ?tab= search param so /playbook and
 * /log deep links can land on the right tab.
 */

const dashboardRoute = getRouteApi("/_authenticated/dashboard");

export const CANVASSER_TABS = ["plan", "log", "stats", "learn"] as const;
export type CanvasserTab = (typeof CANVASSER_TABS)[number];
export const isCanvasserTab = (t: unknown): t is CanvasserTab =>
  (CANVASSER_TABS as readonly unknown[]).includes(t);

const LAST_TAB_KEY = "mission.last_tab";
function getStoredTab(): CanvasserTab {
  try {
    const stored = sessionStorage.getItem(LAST_TAB_KEY);
    return isCanvasserTab(stored) ? stored : "log";
  } catch {
    return "log";
  }
}

export function CanvasserMission({
  userId,
  displayName,
  teamId,
}: {
  userId: string;
  displayName: string | null;
  teamId: string | null;
}) {
  const { tab: rawTab } = dashboardRoute.useSearch();
  const navigate = dashboardRoute.useNavigate();
  // Foreign tab values reach here constantly — the logo link and old Stats
  // bookmarks carry ?tab=dispatch, and the search-less bottom-bar item and
  // swipe nav commit the validateSearch default ("dispatch") too. Coerce in
  // RENDER only (never rewrite the URL: an owner using View As would lose
  // their leadership tab), falling back to the last tab this session viewed
  // so returning to Mission via swipe/bottom bar doesn't reset to Log.
  const tab: CanvasserTab = isCanvasserTab(rawTab) ? rawTab : getStoredTab();
  const setTab = (t: CanvasserTab) => navigate({ search: { tab: t }, replace: true });
  useEffect(() => {
    try {
      sessionStorage.setItem(LAST_TAB_KEY, tab);
    } catch {
      /* private-mode quota — non-essential */
    }
  }, [tab]);

  // Desk confirmations land across browsers only via realtime — refresh the
  // status pills (Log tab) and MTD revenue (Stats tab) the moment Office
  // Staff confirms or denies.
  useRealtimeInvalidate({
    channel: "canvasser-leads-live",
    tables: ["leads"],
    invalidateKeys: [
      ["my_leads", userId],
      ["my_confirmed_sales", "mtd", userId],
    ],
  });

  const teamQuery = useQuery({
    enabled: !!teamId,
    queryKey: ["canvasser_team", teamId],
    queryFn: async () => {
      const { data, error } = await supabase
        .from("teams")
        .select("id, name, color")
        .eq("id", teamId!)
        .maybeSingle();
      if (error) throw error;
      return data;
    },
  });
  const myTeam = teamQuery.data ?? { id: "", name: "Unassigned", color: "#10b981" };

  const stats = useCanvasserStats(userId);

  return (
    <div className="space-y-6">
      <div>
        <div className="text-[10px] font-display uppercase tracking-widest text-muted-foreground">
          Player
        </div>
        <h1 className="font-display text-2xl text-foreground mt-1">
          {(displayName ?? "You").toUpperCase()}
        </h1>
        {myTeam.id && (
          <div className="mt-2 flex items-center gap-2">
            <TeamBadge name={myTeam.name} color={myTeam.color} />
          </div>
        )}
      </div>

      <TimeClock userId={userId} />
      <TakeHomeWidget
        userId={userId}
        weeklyPay={stats.weeklyPay}
        hourlyRate={stats.hourlyRate}
        weekPoints={stats.weekPoints}
      />
      <SCCERankBanner userId={userId} />

      <Tabs value={tab} onValueChange={(v) => setTab(v as CanvasserTab)}>
        <div className="-mx-4 px-4 sm:mx-0 sm:px-0 overflow-x-auto scrollbar-hide">
          <TabsList className="flex w-max min-w-full flex-nowrap whitespace-nowrap md:grid md:w-full md:grid-cols-4 bg-surface border border-border p-1 h-auto">
            <ArcadeTab value="plan">Plan</ArcadeTab>
            <ArcadeTab value="log">Log</ArcadeTab>
            <ArcadeTab value="stats">Stats</ArcadeTab>
            <ArcadeTab value="learn">Learn</ArcadeTab>
          </TabsList>
        </div>

        <TabsContent value="plan" className="mt-6">
          <PlanPanel userId={userId} />
        </TabsContent>

        <TabsContent value="log" className="mt-6">
          <DailyLogPanel canEditMondayUrl={false} />
        </TabsContent>

        <TabsContent value="stats" className="mt-6">
          <CanvasserStats stats={stats} onEditGoal={() => setTab("plan")} />
        </TabsContent>

        <TabsContent value="learn" className="mt-6">
          <LearnPanel />
        </TabsContent>
      </Tabs>
    </div>
  );
}

function ArcadeTab({ value, children }: { value: string; children: React.ReactNode }) {
  return (
    <TabsTrigger
      value={value}
      className="font-display text-[10px] uppercase tracking-widest data-[state=active]:bg-[color-mix(in_oklab,var(--neon)_15%,transparent)] data-[state=active]:text-neon data-[state=active]:shadow-[0_0_18px_-4px_var(--neon)] py-2.5"
    >
      {children}
    </TabsTrigger>
  );
}

/** Pay-lock states → banner copy (config-dict twin of PayrollLedger's
 *  PAY_LOCK_META; "active" renders nothing). */
const PAY_LOCK_BANNERS: Record<
  string,
  { border: string; title: string; titleClass: string; body: string }
> = {
  warned: {
    border: "border-warning/50 bg-warning/10",
    title: "⚠ Pay Lock Warning",
    titleClass: "text-warning",
    body: ` — your rolling 4-week sit average is below ${PAY_LOCK_MIN_ROLLING_AVG}. A second violation within 90 days reverts your comp to the weekly tier reset (rank retained).`,
  },
  reverted: {
    border: "border-destructive/50 bg-destructive/10",
    title: "Pay Lock Reverted",
    titleClass: "text-destructive",
    body: " — you're currently paid on the weekly point tiers. Reinstatement: 3 consecutive weeks at 7+ sits.",
  },
};

function SCCERankBanner({ userId }: { userId: string }) {
  const { data } = useCanvasserProfile(userId);
  const rank = data?.current_rank ?? "Jr. Silver";
  const banner = PAY_LOCK_BANNERS[data?.pay_lock_status ?? "active"];
  return (
    <>
      {banner && (
        <div className={`rounded-xl border p-4 text-xs ${banner.border}`}>
          <span className={`font-display uppercase tracking-widest ${banner.titleClass}`}>
            {banner.title}
          </span>
          <span className="text-muted-foreground">{banner.body}</span>
        </div>
      )}
      <ArcadeCard className="flex flex-wrap items-center justify-between gap-4">
        <div className="flex items-center gap-3 min-w-0">
          <RankPill rank={rank} size="md" />
          <div className="min-w-0">
            <div className="text-[10px] font-display uppercase tracking-widest text-muted-foreground">
              SCCE Rank
            </div>
            <div className="text-xs text-muted-foreground truncate">{RANK_PERKS[rank] ?? ""}</div>
          </div>
        </div>
        <div className="flex flex-wrap items-center gap-x-4 gap-y-1 text-[10px] font-display uppercase tracking-widest text-muted-foreground">
          <span>
            3+ sits wks ·{" "}
            <span className="text-neon">{data?.consecutive_weeks_3_plus_sits ?? 0}</span>
          </span>
          <span>
            7+ sits wks ·{" "}
            <span className="text-victory">{data?.consecutive_weeks_7_plus_sits ?? 0}</span>
          </span>
          <span>
            4-wk avg ·{" "}
            <span className="text-accent">{(data?.rolling_4_week_sit_avg ?? 0).toFixed(1)}</span>
          </span>
          <span>
            recruits · <span className="text-foreground">{data?.recruits_count ?? 0}</span>
          </span>
        </div>
      </ArcadeCard>
    </>
  );
}

function TakeHomeWidget({
  userId,
  weeklyPay,
  hourlyRate,
  weekPoints,
}: {
  userId: string;
  weeklyPay: number;
  hourlyRate: number;
  weekPoints: number;
}) {
  // Shares SCCERankBanner's query — one profile fetch feeds the whole page.
  const { data } = useCanvasserProfile(userId);
  const rank = data?.current_rank ?? "Jr. Silver";

  // Authoritative MTD volume bonus from the pay engine (calc_monthly_paycheck)
  // — the same source the owner's payroll screen pays from. Hidden on error
  // rather than showing a possibly-wrong dollar figure. The key is shared
  // with useMyEarnings ON PURPOSE — one fetch, one cache entry, zero chance
  // of two different month figures on the page.
  const monthStart = laMonthStartISO();
  const { data: monthly } = useQuery({
    queryKey: ["takehome_volume_bonus", userId, monthStart],
    queryFn: async () => {
      const { results } = await getMonthlyPaychecks({
        data: { month_start: monthStart, canvasser_ids: [userId] },
      });
      return results[0]?.paycheck ?? null;
    },
  });

  return (
    <div className="rounded-xl border border-victory/40 bg-[color-mix(in_oklab,var(--victory)_8%,var(--surface))] p-5 sm:p-6">
      <div className="flex flex-wrap items-center justify-between gap-6">
        <div>
          <div className="text-[10px] font-display uppercase tracking-widest text-victory/80">
            Weekly Pay · All Sources
          </div>
          <div className="mt-2 font-display text-4xl sm:text-5xl text-victory leading-none">
            {formatCurrency(weeklyPay)}
          </div>
          <div className="mt-2 text-[10px] font-display uppercase tracking-widest text-muted-foreground">
            ${hourlyRate}/hr · {weekPoints} pts this week
          </div>
          {monthly && (
            <div className="mt-1 text-[10px] font-display uppercase tracking-widest text-muted-foreground">
              Volume bonus earned this month ·{" "}
              <span className={Number(monthly.volume_bonus) > 0 ? "text-victory" : ""}>
                {formatCurrency(Number(monthly.volume_bonus))}
              </span>
              {" (paid next month) · "}
              {formatCurrency(
                VOLUME_BONUS_STEP - (Number(monthly.sale_price_total) % VOLUME_BONUS_STEP),
              )}{" "}
              to next $1,500
            </div>
          )}
          {monthly && (
            <div className="mt-1 text-[10px] font-display uppercase tracking-widest text-muted-foreground">
              Month take-home so far ·{" "}
              <span className="text-victory">{formatCurrency(Number(monthly.total_pay))}</span>
            </div>
          )}
        </div>
        <div className="text-right">
          <div className="text-[10px] font-display uppercase tracking-widest text-muted-foreground">
            Current Rank
          </div>
          <div className="mt-2 flex justify-end">
            <RankPill rank={rank} />
          </div>
        </div>
      </div>
    </div>
  );
}
