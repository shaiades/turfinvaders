import { useEffect } from "react";
import { useQuery } from "@tanstack/react-query";
import { supabase } from "@/integrations/supabase/client";
import { useRealtimeInvalidate } from "@/hooks/useRealtimeInvalidate";
import { useAuth } from "@/hooks/useAuth";
import { useCanvasserStats } from "@/hooks/useCanvasserStats";
import { Tabs, TabsList, TabsTrigger, TabsContent } from "@/components/ui/tabs";
import { PushAlertsCard } from "@/components/PushAlertsCard";
import { TimeClock } from "@/components/TimeClock";
import { WeekAttestationCard } from "@/components/WeekAttestationCard";
import { DayOffRequestCard } from "@/components/DayOffRequestCard";
import { PlanPanel } from "@/components/PlanPanel";
import { DailyLogPanel } from "@/components/DailyLogPanel";
import { CanvasserStats, GrindCounter } from "@/components/CanvasserStats";
import { FighterCard } from "@/components/FighterCard";
import { PaycheckCard } from "@/components/PaycheckCard";
import type { CanvasserStatsData } from "@/hooks/useCanvasserStats";
import { CalendarClock, DoorOpen, MessageSquare, PhoneCall } from "lucide-react";

/**
 * The canvasser Mission page — Stats, Playbook, and the Daily Log merged into
 * one screen (2026-08-14). Always-on header stack — time clock, then the ONE
 * Fighter card (identity + SCCE rank + arcade level + badges) and the ONE
 * Paycheck card (week/month take-home) that the 2026-10-05 consolidation
 * collapsed the old TakeHome / SCCE-rank / MyFighter / PaycheckHud panels into
 * — then three tabs in day order: Plan (goal → funnel back-solve), Today (the
 * live working surface: counters + desk log — tab VALUE stays "log" for deep
 * links), Stats (the pure analytics scoreboard: funnel, at-the-door, leads/day).
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
      {/* The login photo request now lives app-wide in AppShell (owner
          2026-10-05) so it fires right after sign-in on any page — the
          MyFighterCard below stays as the always-available control. */}
      {/* The old PLAYER name block is gone (audit 2026-09-11): the page a
          grinder opens to check money spent its best space telling them
          their own name. Van identity rides the Paycheck card instead. */}
      <div data-tour="mission-clock">
        <TimeClock userId={userId} />
      </div>
      {/* Weekly sign-off on LAST week's hours (CA defense for manager /
          captain-entered punches). Renders nothing until the attestation
          table ships, when the week was empty, or once signed. */}
      <WeekAttestationCard userId={userId} />
      {/* Self-serve day-off requests (captain approves). Ships dark until
          the day_off_requests table lands. */}
      <DayOffRequestCard userId={userId} />
      {/* ONE Fighter card (identity + rank + level + badges) at the top, then
          the ONE Paycheck card — the two cards the consolidation merged the
          old TakeHome / SCCE-rank / MyFighter / PaycheckHud panels into. */}
      <FighterCard userId={userId} displayName={displayName} />
      <div data-tour="mission-pay">
        <PaycheckCard
          userId={userId}
          stats={stats}
          teamName={myTeam.id ? myTeam.name : null}
          teamColor={myTeam.color}
          onEditGoal={() => setTab("plan")}
        />
      </div>
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

        <TabsContent value="stats" className="mt-6 space-y-5">
          <CanvasserStats stats={stats} userId={userId} onEditGoal={() => setTab("plan")} />
        </TabsContent>
      </Tabs>
    </div>
  );
}

/** The TODAY tab — the live working surface (owner merge 2026-09-12: today's
 *  numbers used to be split across Log and Stats). The big live counters up
 *  top, the Desk Log below. Projected money lives on the Active Run map pill
 *  and the cinematic Wrap now (consolidation 2026-10-05), not here. Lives HERE,
 *  not inside DailyLogPanel, so the leadership /log route keeps the bare desk
 *  panel without pulling funnel queries for non-canvassing roles. */
function TodayPanel({ userId, stats }: { userId: string; stats: CanvasserStatsData }) {
  const { role } = useAuth();
  const today = stats.today;
  return (
    <div className="space-y-6">
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
          Counts live as pins land on Active Run.
          {role === "captain"
            ? " Missed pins on a dead-phone day? You're the captain — flag it to the office."
            : " Missed pins on a dead-phone day? Tell your captain."}
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
