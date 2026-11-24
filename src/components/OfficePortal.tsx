import { useAuth } from "@/hooks/useAuth";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { TimeClock } from "@/components/TimeClock";
import { WeekAttestationCard } from "@/components/WeekAttestationCard";
import { OfficeWeekSummary } from "@/components/OfficeWeekSummary";
import { DayOffRequestCard } from "@/components/DayOffRequestCard";
import { ProductionTeamPanel } from "@/components/ProductionTeamPanel";

export type OfficeTab = "clock" | "timeoff" | "team";

/** The Office Portal (owner ask 2026-11-23): the whole app for office
 *  workers — receptionist, production, back-office. Deliberately minimal:
 *  the clock (with lunch + CA meal/rest attestations enforced by the DB),
 *  last week's sign-off, this week's hours, and time-off requests. All
 *  heavy lifting is the existing components; this page only lays them out
 *  clean and mobile-first. */
export function OfficePortal({
  tab,
  onTabChange,
}: {
  tab: OfficeTab;
  onTabChange: (t: OfficeTab) => void;
}) {
  const { user, displayName, realRole } = useAuth();
  const userId = user?.id;
  // The Production tab is the manager's console (owners see it for View As
  // and setup). Guard on the REAL role so View As can't grant it.
  const showTeam = realRole === "production_manager" || realRole === "owner";
  if (!userId) return <div className="text-sm text-muted-foreground">Loading…</div>;

  return (
    <div
      className={`mx-auto w-full space-y-3 ${showTeam && tab === "team" ? "max-w-2xl" : "max-w-lg"}`}
    >
      <div className="px-1">
        <h1 className="font-display text-base md:text-lg uppercase tracking-widest">Office</h1>
        {displayName ? <p className="text-xs text-muted-foreground">{displayName}</p> : null}
      </div>

      <Tabs
        value={tab === "team" && !showTeam ? "clock" : tab}
        onValueChange={(v) =>
          onTabChange(v === "timeoff" ? "timeoff" : v === "team" ? "team" : "clock")
        }
      >
        <TabsList className="w-full">
          <TabsTrigger
            value="clock"
            className="flex-1 font-display text-[10px] uppercase tracking-widest"
          >
            Time Clock
          </TabsTrigger>
          <TabsTrigger
            value="timeoff"
            className="flex-1 font-display text-[10px] uppercase tracking-widest"
          >
            Time Off
          </TabsTrigger>
          {showTeam ? (
            <TabsTrigger
              value="team"
              className="flex-1 font-display text-[10px] uppercase tracking-widest"
            >
              Production
            </TabsTrigger>
          ) : null}
        </TabsList>

        <TabsContent value="clock" className="mt-3 space-y-3">
          <TimeClock userId={userId} />
          <WeekAttestationCard userId={userId} />
          <OfficeWeekSummary userId={userId} />
        </TabsContent>

        <TabsContent value="timeoff" className="mt-3 space-y-3">
          <DayOffRequestCard userId={userId} />
        </TabsContent>

        {showTeam ? (
          <TabsContent value="team" className="mt-3 space-y-3">
            <ProductionTeamPanel />
          </TabsContent>
        ) : null}
      </Tabs>
    </div>
  );
}
