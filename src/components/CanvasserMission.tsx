import { useEffect } from "react";
import { useQuery } from "@tanstack/react-query";
import { supabase } from "@/integrations/supabase/client";
import { formatCurrency } from "@/lib/utils";
import { laMonthStartISO } from "@/lib/dates";
import { PAY_LOCK_MIN_ROLLING_AVG, VOLUME_BONUS_STEP } from "@/lib/pay";
import { getMonthlyPaychecks } from "@/lib/fleet.functions";
import { useRealtimeInvalidate } from "@/hooks/useRealtimeInvalidate";
import { useCanvasserProfile } from "@/hooks/useCanvasserProfile";
import { useCanvasserStats } from "@/hooks/useCanvasserStats";
import { ArcadeCard, NeonBar, TeamBadge } from "@/components/arcade";
import { Tabs, TabsList, TabsTrigger, TabsContent } from "@/components/ui/tabs";
import { RankPill, RANK_PERKS } from "@/components/RankPill";
import { PushAlertsCard } from "@/components/PushAlertsCard";
import { TimeClock } from "@/components/TimeClock";
import { PlanPanel } from "@/components/PlanPanel";
import { DailyLogPanel } from "@/components/DailyLogPanel";
import { CanvasserStats, GrindCounter } from "@/components/CanvasserStats";
import { PiggyBankHUD } from "@/components/PiggyBankHUD";
import { usePiggyBank } from "@/hooks/usePiggyBank";
import type { CanvasserStatsData } from "@/hooks/useCanvasserStats";
import { CalendarClock, DoorOpen, MessageSquare, PhoneCall } from "lucide-react";

/**
 * The canvasser Mission page — Stats, Playbook, and the Daily Log merged
 * into one screen (2026-08-14). Always-on header stack (time clock, pay,
 * SCCE rank), then three tabs in day order: Plan (goal → funnel back-solve),
 * Today (the live working surface: piggy bank, counters, desk log, leads —
 * tab VALUE stays "log" for deep links), Stats (week/MTD scoreboard).
 * Tab selection lives in the host route's ?tab= search param so /playbook and
 * /log deep links can land on the right tab. The host route owns the search
 * value + navigate (canvassers mount this on /dashboard, captains on /mission),
 * so this component is route-agnostic — it takes the raw ?tab value and a
 * setter as props rather than binding to one route's API.
 */

// "learn" left this list 2026-09-08 — Learn is a bottom-bar tab (/learn) now.
// Old ?tab=learn deep links coerce through isCanvasserTab → last-viewed tab.
export const CANVASSER_TABS = ["plan", "log", "stats"] as const;
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
  rawTab,
  setTab,
}: {
  userId: string;
  displayName: string | null;
  teamId: string | null;
  /** The host route's raw ?tab value (any type — coerced below). */
  rawTab: unknown;
  /** Writes the host route's ?tab (e.g. dashboard/mission navigate, replace). */
  setTab: (t: CanvasserTab) => void;
}) {
  // Foreign tab values reach here constantly — the logo link and old Stats
  // bookmarks carry ?tab=dispatch, and the search-less bottom-bar item and
  // swipe nav commit the validateSearch default ("dispatch") too. Coerce in
  // RENDER only (never rewrite the URL: an owner using View As would lose
  // their leadership tab), falling back to the last tab this session viewed
  // so returning to Mission via swipe/bottom bar doesn't reset to Log.
  const tab: CanvasserTab = isCanvasserTab(rawTab) ? rawTab : getStoredTab();
  useEffect(() => {
    try {
      sessionStorage.setItem(LAST_TAB_KEY, tab);
    } catch {
      /* private-mode quota — non-essential */
    }
  }, [tab]);

  // Desk confirmations land across browsers only via realtime — refresh the
  // status pills (Today tab) and MTD revenue (Stats tab) the moment Office
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
      {/* The old PLAYER name block is gone (audit 2026-09-11): the page a
          grinder opens to check money spent its best space telling them
          their own name. Van identity rides the TakeHome header instead. */}
      <div data-tour="mission-clock">
        <TimeClock userId={userId} />
      </div>
      <div data-tour="mission-pay">
        <TakeHomeWidget
          userId={userId}
          weeklyPay={stats.weeklyPay}
          weeklyGoal={stats.weeklyGoal}
          hourlyRate={stats.hourlyRate}
          weekPoints={stats.weekPoints}
          teamName={myTeam.id ? myTeam.name : null}
          teamColor={myTeam.color}
        />
      </div>
      <SCCERankBanner userId={userId} />
      <PushAlertsCard
        title="Alerts"
        description="Turf drops and schedule changes, straight to your phone."
      />

      <Tabs value={tab} onValueChange={(v) => setTab(v as CanvasserTab)}>
        <div
          className="-mx-4 px-4 sm:mx-0 sm:px-0 overflow-x-auto scrollbar-hide"
          data-tour="mission-tabs"
        >
          <TabsList className="flex w-max min-w-full flex-nowrap whitespace-nowrap md:grid md:w-full md:grid-cols-3 bg-surface border border-border p-1 h-auto">
            <ArcadeTab value="plan">Plan</ArcadeTab>
            {/* value stays "log" — /log's redirect, tour search params, and
                the /mission default all deep-link it; only the label moved
                to "Today" (owner merge 2026-09-12). */}
            <ArcadeTab value="log">Today</ArcadeTab>
            <ArcadeTab value="stats">Stats</ArcadeTab>
          </TabsList>
        </div>

        <TabsContent value="plan" className="mt-6">
          <PlanPanel userId={userId} />
        </TabsContent>

        <TabsContent value="log" className="mt-6">
          <TodayPanel userId={userId} stats={stats} />
        </TabsContent>

        <TabsContent value="stats" className="mt-6">
          <CanvasserStats stats={stats} userId={userId} onEditGoal={() => setTab("plan")} />
        </TabsContent>
      </Tabs>
    </div>
  );
}

/** The TODAY tab — the live working surface (owner merge 2026-09-12: today's
 *  numbers used to be split across Log and Stats). Piggy bank + the big
 *  counters up top, the Desk Log below. Lives HERE, not inside
 *  DailyLogPanel, so the leadership /log route keeps the bare desk panel
 *  without pulling piggy/funnel queries for non-canvassing roles. */
function TodayPanel({ userId, stats }: { userId: string; stats: CanvasserStatsData }) {
  // Same hook as Active Run's map pill — the two surfaces can never disagree
  // (every underlying query is already warm from the header + Stats).
  const piggy = usePiggyBank(userId);
  const today = stats.today;
  return (
    <div className="space-y-6">
      <PiggyBankHUD
        variant="card"
        dollars={piggy.dollars}
        perKnock={piggy.perKnock}
        knocks={piggy.knocks}
        source={piggy.source}
      />
      <div>
        <div className="grid grid-cols-2 sm:grid-cols-4 gap-3">
          <GrindCounter
            label="Doors"
            counterLabel="DOORS · TODAY"
            size="md"
            value={today.doors_knocked}
            icon={<DoorOpen className="w-4 h-4" />}
            accent="#ff2d55"
          />
          <GrindCounter
            label="Talked"
            counterLabel="TALKED · TODAY"
            size="md"
            value={today.people_talked_to}
            icon={<MessageSquare className="w-4 h-4" />}
            accent="var(--accent)"
          />
          <GrindCounter
            label="Leads"
            counterLabel="LEADS · TODAY"
            size="md"
            value={today.leads_called_in}
            icon={<PhoneCall className="w-4 h-4" />}
            accent="var(--neon)"
          />
          {/* Next-day + future confirms merged (audit P1-6): both mean "a
              confirmed appointment is booked" — one tile, one number. */}
          <GrindCounter
            label="Booked"
            counterLabel="BOOKED · TODAY"
            size="md"
            value={today.next_days + today.future_leads}
            icon={<CalendarClock className="w-4 h-4" />}
            accent="var(--victory)"
          />
        </div>
        <p className="mt-2 text-[10px] text-muted-foreground">
          Counts live as pins land on Active Run. Missed pins on a dead-phone day? Tell your
          captain.
        </p>
      </div>
      <DailyLogPanel canEditMondayUrl={false} />
    </div>
  );
}

function ArcadeTab({ value, children }: { value: string; children: React.ReactNode }) {
  return (
    <TabsTrigger
      value={value}
      data-tour={`tab-${value}`}
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
          <RankPill rank={rank} size="md" tappable />
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
  weeklyGoal,
  hourlyRate,
  weekPoints,
  teamName,
  teamColor,
}: {
  userId: string;
  weeklyPay: number;
  weeklyGoal: number;
  hourlyRate: number;
  weekPoints: number;
  teamName: string | null;
  teamColor: string;
}) {
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

  // The gap to the weekly goal, welded to the money headline (audit
  // 2026-09-11): the number a grinder manages is dollars REMAINING, and it
  // was previously two taps away inside the Plan tab.
  const toGo = Math.max(0, weeklyGoal - weeklyPay);
  const pct = weeklyGoal > 0 ? Math.min(1, weeklyPay / weeklyGoal) : 0;

  return (
    <div className="rounded-xl border border-victory/40 bg-[color-mix(in_oklab,var(--victory)_8%,var(--surface))] p-5 sm:p-6">
      <div className="flex flex-wrap items-start justify-between gap-4">
        <div className="min-w-0">
          <div className="text-[10px] font-display uppercase tracking-widest text-victory/80">
            Weekly Pay · All Sources
          </div>
          <div className="mt-2 font-display text-4xl sm:text-5xl text-victory leading-none">
            {formatCurrency(weeklyPay)}
          </div>
        </div>
        {teamName && (
          <div className="shrink-0">
            <TeamBadge name={teamName} color={teamColor} />
          </div>
        )}
      </div>
      {weeklyGoal > 0 && (
        <div className="mt-4">
          <NeonBar pct={pct * 100} accent="var(--victory)" />
          <div className="mt-1.5 text-[10px] font-display uppercase tracking-widest text-muted-foreground">
            {toGo > 0 ? (
              <>
                <span className="text-victory">{formatCurrency(weeklyGoal)}</span> weekly goal ·{" "}
                <span className="text-[var(--warning)]">{formatCurrency(toGo)}</span> to go
              </>
            ) : (
              <span className="text-victory">Weekly goal hit — everything now is gravy 🏆</span>
            )}
          </div>
        </div>
      )}
      <div className="mt-3 text-[10px] font-display uppercase tracking-widest text-muted-foreground">
        ${hourlyRate}/hr · {weekPoints} pts this week
      </div>
      {monthly && Number(monthly.sale_price_total) > 0 && (
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
  );
}
