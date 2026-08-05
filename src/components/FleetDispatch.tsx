import { useEffect, useMemo, useRef, useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { supabase } from "@/integrations/supabase/client";
import {
  OfficeFilterProvider,
  OfficeFilterToggle,
  useOfficeFilter,
} from "@/components/OfficeFilterContext";
import { ArcadePanel, TeamBadge } from "@/components/arcade";
import { Button } from "@/components/ui/button";
import {
  Radio,
  Users,
  FileSearch,
  X,
  Link2,
  Copy,
  Check,
  KeyRound,
  Eye,
  EyeOff,
  AlertTriangle,
  Lock,
  Truck,
  ChevronLeft,
  ChevronRight,
  CalendarRange,
  Wrench,
  ChevronDown,
  ChevronUp,
} from "lucide-react";
import { toast } from "sonner";
import confetti from "canvas-confetti";
import {
  addDaysISO,
  dateFromISO,
  fmtWorkedDay,
  formatWeekRange,
  laMidnightUtcISO,
  laMonthStartISO,
  lastWorkedDaysBefore,
  monthStartISO,
  nextMonthStartISO,
  reportDates,
  weekStartOfISO,
} from "@/lib/dates";
import { useWeekSelector } from "@/hooks/useWeekSelector";
import { useRealtimeInvalidate } from "@/hooks/useRealtimeInvalidate";
import { useAuth } from "@/hooks/useAuth";
import { isManagerRole } from "@/lib/roles";
import { isRecentlyActive, lastActiveMap } from "@/lib/suspension";
import { formatCurrency, normalizeName } from "@/lib/utils";
import { DEFAULT_OFFICE, OFFICE_LOCATIONS } from "@/lib/offices";
import { getDispatchProduction, type DispatchResults } from "@/lib/dispatch.functions";
import { FleetDispatchManage } from "@/components/FleetDispatchManage";
import { ExecutiveSection } from "@/components/ExecutiveDashboard";

/** One profile row as the board consumes it (dispatch membership). */
export type RosterProfile = {
  id: string;
  display_name: string | null;
  office_location: string | null;
  team_id: string | null;
  team_office: string | null;
  is_active: boolean | null;
  suspension_tracked: boolean;
  created_at: string;
};

type BoardProfile = RosterProfile & { role: "canvasser" | "captain" };

export type Van = {
  id: string;
  name: string;
  color: string | null;
  captain_id: string | null;
  office_location: string | null;
};

// The dispatch funnel counts ONLY actioned Lead Status results (owner,
// 2026-07-28): Confirmed, Future, and Blowout — where Blowout absorbs the
// N/A and Disconnected labels (killed + no_answers columns). Submitted is
// their sum, so Submitted ≡ Confirmed + Future + Blowout always holds.
// A card contributes nothing until its status button is actioned; card
// creation (leads_generated) feeds only the suspension window.
type Metric = {
  canvasser_id: string;
  metric_date: string;
  leads_confirmed: number;
  no_answers: number;
  killed: number;
  future: number;
};

export function FleetDispatch({ readOnly = false }: { readOnly?: boolean }) {
  return (
    <OfficeFilterProvider>
      <FleetDispatchInner readOnly={readOnly} />
    </OfficeFilterProvider>
  );
}

type RangeTab = "day" | "week" | "month";
type DayPreset = "today" | "yesterday";

type ResolvedRange = {
  funnelStart: string;
  funnelEnd: string;
  logStart: string;
  logEnd: string;
  volStartISO: string;
  volEndISO: string;
  label: string;
  sub: string;
  isLive: boolean;
};

function FleetDispatchInner({ readOnly }: { readOnly: boolean }) {
  const qc = useQueryClient();
  const { realRole } = useAuth();

  // --- Range engine: Day (report-date clock) / Week (Mon–Sat) / Month ---
  const [tab, setTab] = useState<RangeTab>("day");
  const [dayPreset, setDayPreset] = useState<DayPreset>("today");
  const [{ today, yday, locked }, setDates] = useState(reportDates);
  // Chips removed via the X vanish instantly (optimistic) while the
  // suspension_tracked flag persists server-side.
  const [dismissed, setDismissed] = useState<Set<string>>(() => new Set());
  const [manageOpen, setManageOpen] = useState(false);
  const { matches } = useOfficeFilter();
  const confettiFired = useRef(false);
  // The 30s tick closure must see the CURRENT view, not the mount-time one.
  const liveDayView = useRef(false);
  liveDayView.current = tab === "day" && dayPreset === "today";

  // Re-evaluate report date every 30s; fire confetti once when we cross 7 PM
  // PT while actually watching the live day.
  useEffect(() => {
    const tick = () => {
      const next = reportDates();
      setDates((prev) => {
        if (!prev.locked && next.locked && !confettiFired.current && liveDayView.current) {
          confettiFired.current = true;
          fireEndOfDayConfetti();
        }
        if (prev.today === next.today && prev.locked === next.locked) return prev;
        return next;
      });
    };
    const id = window.setInterval(tick, 30_000);
    return () => window.clearInterval(id);
  }, []);

  const week = useWeekSelector({ endOffsetDays: 5 }); // Mon–Sat, Block-board convention
  const [monthStart, setMonthStart] = useState<string>(() => laMonthStartISO());
  const shiftMonth = (delta: 1 | -1) =>
    setMonthStart((m) => (delta > 0 ? nextMonthStartISO(m) : monthStartISO(addDaysISO(m, -1))));
  const isCurrentMonth = monthStart === laMonthStartISO();
  const monthLabel = new Intl.DateTimeFormat(undefined, { month: "long", year: "numeric" }).format(
    dateFromISO(monthStart),
  );

  const range: ResolvedRange = useMemo(() => {
    if (tab === "day") {
      const d = dayPreset === "yesterday" ? yday : today;
      // Owner directive (2026-08-04): the "As Leads" half of the board reads
      // as THIS WEEK'S RESULTS IN PROGRESS — results, Points, and Volume
      // always cover the full Mon–Sat week containing the selected day
      // (matching the Weekly Results table), while "In the Field" keeps the
      // day's own funnel numbers.
      const wk = weekStartOfISO(d);
      return {
        funnelStart: d,
        funnelEnd: d,
        logStart: wk,
        logEnd: addDaysISO(wk, 5),
        volStartISO: laMidnightUtcISO(wk),
        volEndISO: laMidnightUtcISO(addDaysISO(wk, 7)),
        label: dayPreset === "yesterday" ? "Yesterday" : "Today",
        sub: d,
        isLive: dayPreset === "today",
      };
    }
    if (tab === "week") {
      return {
        funnelStart: week.weekStartISO,
        funnelEnd: week.weekEndISO,
        logStart: week.weekStartISO,
        logEnd: week.weekEndISO,
        // Volume window is Mon 00:00 → next Mon 00:00 LA (pay-engine week
        // attribution) even though the funnel/points label reads Mon–Sat.
        volStartISO: laMidnightUtcISO(week.weekStartISO),
        volEndISO: laMidnightUtcISO(addDaysISO(week.weekStartISO, 7)),
        label: formatWeekRange(week.weekStart, week.weekEnd),
        sub: `${week.weekStartISO} → ${week.weekEndISO}`,
        isLive: week.isCurrentWeek,
      };
    }
    const monthEnd = addDaysISO(nextMonthStartISO(monthStart), -1);
    return {
      funnelStart: monthStart,
      funnelEnd: monthEnd,
      logStart: monthStart,
      logEnd: monthEnd,
      volStartISO: laMidnightUtcISO(monthStart),
      volEndISO: laMidnightUtcISO(nextMonthStartISO(monthStart)),
      label: monthLabel,
      sub: `${monthStart} → ${monthEnd}`,
      isLive: isCurrentMonth,
    };
  }, [
    tab,
    dayPreset,
    today,
    yday,
    week.weekStart,
    week.weekEnd,
    week.weekStartISO,
    week.weekEndISO,
    week.isCurrentWeek,
    monthStart,
    monthLabel,
    isCurrentMonth,
  ]);

  // --- Queries (one key family; realtime prefix-invalidates all of it) ---

  // Roster serves BOTH the board and Manage Fleet from one fetch so the two
  // can never disagree after a mutation.
  const rosterQuery = useQuery({
    queryKey: ["fleet_dispatch", "roster"],
    queryFn: async () => {
      const [profsR, rolesR] = await Promise.all([
        supabase
          .from("profiles")
          .select(
            "id, display_name, office_location, team_id, is_active, suspension_tracked, created_at, teams:team_id(office_location)",
          )
          .order("display_name"),
        supabase.from("user_roles").select("user_id, role"),
      ]);
      if (profsR.error) throw profsR.error;
      if (rolesR.error) throw rolesR.error;
      const rolesByUser = new Map<string, string[]>();
      for (const r of rolesR.data ?? []) {
        const arr = rolesByUser.get(r.user_id) ?? [];
        arr.push(r.role);
        rolesByUser.set(r.user_id, arr);
      }
      const profiles: RosterProfile[] = (
        (profsR.data ?? []) as Array<{
          id: string;
          display_name: string | null;
          office_location: string | null;
          team_id: string | null;
          is_active: boolean | null;
          suspension_tracked: boolean;
          created_at: string;
          teams: { office_location: string | null } | null;
        }>
      ).map((p) => ({
        id: p.id,
        display_name: p.display_name,
        office_location: p.office_location,
        team_id: p.team_id,
        is_active: p.is_active,
        suspension_tracked: p.suspension_tracked,
        created_at: p.created_at,
        team_office: p.teams?.office_location ?? null,
      }));
      return { profiles, rolesByUser };
    },
  });
  const allProfiles = rosterQuery.data?.profiles ?? [];
  const rolesByUser = rosterQuery.data?.rolesByUser ?? new Map<string, string[]>();

  // Board membership keeps LiveDispatch's strict semantics: active canvassers
  // and captains only (is_active === true — null is NOT active here, while
  // Manage Fleet deliberately treats null as active, matching the old split).
  const canvassers: BoardProfile[] = useMemo(() => {
    const out: BoardProfile[] = [];
    for (const p of allProfiles) {
      if (p.is_active !== true) continue;
      const roles = rolesByUser.get(p.id) ?? [];
      const role = roles.includes("captain")
        ? "captain"
        : roles.includes("canvasser")
          ? "canvasser"
          : null;
      if (!role) continue;
      out.push({ ...p, role });
    }
    return out;
  }, [allProfiles, rolesByUser]);

  const { data: vans = [] } = useQuery({
    queryKey: ["fleet_dispatch", "vans"],
    queryFn: async () => {
      const { data, error } = await supabase
        .from("teams")
        .select("id, name, color, captain_id, office_location")
        .order("name");
      if (error) throw error;
      return (data ?? []) as Van[];
    },
  });

  const { data: metrics = [] } = useQuery({
    queryKey: ["fleet_dispatch", "funnel", range.funnelStart, range.funnelEnd],
    queryFn: async () => {
      const { data, error } = await supabase
        .from("daily_metrics")
        .select("canvasser_id, metric_date, leads_confirmed, no_answers, killed, future")
        .gte("metric_date", range.funnelStart)
        .lte("metric_date", range.funnelEnd);
      if (error) throw error;
      return (data ?? []) as Metric[];
    },
  });

  // Points + Volume come from the server fn so every viewer (including
  // canvassers on /leaderboard) sees everyone's full production — the
  // owner's transparency decision. Raw rows stay RLS-locked.
  const production = useQuery({
    queryKey: [
      "fleet_dispatch",
      "production",
      range.logStart,
      range.logEnd,
      range.volStartISO,
      range.volEndISO,
    ],
    queryFn: async () =>
      getDispatchProduction({
        data: {
          log_start: range.logStart,
          log_end: range.logEnd,
          vol_start: range.volStartISO,
          vol_end: range.volEndISO,
        },
      }),
  });
  const pointsByUser = useMemo(
    () => new Map(Object.entries(production.data?.points ?? {})),
    [production.data],
  );
  const volumeByUser = useMemo(
    () => new Map(Object.entries(production.data?.volume ?? {})),
    [production.data],
  );
  const resultsByUser = useMemo(
    () => new Map<string, DispatchResults>(Object.entries(production.data?.results ?? {})),
    [production.data],
  );

  // Suspension window: the last 14 completed worked days (Sundays excluded).
  // Feeds the donut check (first two days) and the zero-streak display.
  const workedDays = useMemo(() => lastWorkedDaysBefore(today, 14), [today]);
  const { data: windowMetrics = [] } = useQuery({
    queryKey: ["fleet_dispatch", "suspension-window", today],
    enabled: tab === "day",
    queryFn: async () => {
      const { data } = await supabase
        .from("daily_metrics")
        .select("canvasser_id, metric_date, leads_generated")
        .in("metric_date", workedDays);
      return (data ?? []) as Array<{
        canvasser_id: string;
        metric_date: string;
        leads_generated: number;
      }>;
    },
  });

  // Realtime — one channel; prefix invalidation refreshes funnel, production,
  // suspension window, roster, and vans (fixes the old stale-banner gap).
  useRealtimeInvalidate({
    channel: "fleet-dispatch-live",
    tables: ["daily_metrics", "daily_logs", "leads"],
    invalidateKeys: [["fleet_dispatch"]],
  });

  // --- Derived ---

  // Sum all metric rows per canvasser_id across the selected range.
  const metricByCanvasser = useMemo(() => {
    const acc = new Map<string, { conf: number; na: number; kil: number; fut: number }>();
    for (const m of metrics) {
      const prev = acc.get(m.canvasser_id) ?? { conf: 0, na: 0, kil: 0, fut: 0 };
      prev.conf += m.leads_confirmed ?? 0;
      prev.na += m.no_answers ?? 0;
      prev.kil += m.killed ?? 0;
      prev.fut += m.future ?? 0;
      acc.set(m.canvasser_id, prev);
    }
    return acc;
  }, [metrics]);

  // gen[canvasser_id][date] = leads generated that worked day.
  const genByDay = useMemo(() => {
    const acc = new Map<string, Map<string, number>>();
    for (const m of windowMetrics) {
      const inner = acc.get(m.canvasser_id) ?? new Map<string, number>();
      inner.set(m.metric_date, (inner.get(m.metric_date) ?? 0) + (m.leads_generated ?? 0));
      acc.set(m.canvasser_id, inner);
    }
    return acc;
  }, [windowMetrics]);

  // Last credited day per canvasser_id, from row PRESENCE — genOn() reads 0
  // for both "no row" and "0-lead row", so recency needs its own map. Funnel
  // rows (`metrics`) are unioned in: on the today view they cover today, so a
  // rep who returns after a long gap counts as active as soon as their first
  // event lands (workedDays excludes today).
  const lastActiveBy = useMemo(
    () => lastActiveMap([...windowMetrics, ...metrics]),
    [windowMetrics, metrics],
  );

  const visible = useMemo(
    () => canvassers.filter((c) => matches(c.office_location ?? c.team_office)),
    [canvassers, matches],
  );

  // De-duplicate by normalized display_name. If any duplicate is a captain,
  // the merged row inherits the captain role. Metrics, points, and volume
  // from every duplicate canvasser_id aggregate into a single row.
  const rows = useMemo(() => {
    type Group = {
      key: string;
      ids: string[];
      display_name: string | null;
      office_location: string | null;
      team_office: string | null;
      role: "canvasser" | "captain";
      tracked: boolean;
      oldestCreated: string;
      team_id: string | null;
    };
    const groups = new Map<string, Group>();
    for (const c of visible) {
      const key = normalizeName(c.display_name) || `id:${c.id}`;
      const created = (c.created_at ?? "").slice(0, 10) || "9999-12-31";
      const g = groups.get(key);
      if (!g) {
        groups.set(key, {
          key,
          ids: [c.id],
          display_name: c.display_name,
          office_location: c.office_location,
          team_office: c.team_office,
          role: c.role,
          tracked: c.suspension_tracked,
          oldestCreated: created,
          team_id: c.team_id,
        });
      } else {
        g.ids.push(c.id);
        if (c.role === "captain") g.role = "captain";
        if (!g.office_location && c.office_location) g.office_location = c.office_location;
        if (!g.team_office && c.team_office) g.team_office = c.team_office;
        if (!c.suspension_tracked) g.tracked = false;
        if (created < g.oldestCreated) g.oldestCreated = created;
        if (!g.team_id && c.team_id) g.team_id = c.team_id;
      }
    }
    const enriched = Array.from(groups.values()).map((g) => {
      let conf = 0,
        kil = 0,
        fut = 0,
        pts = 0,
        vol = 0;
      const res: DispatchResults = { lds: 0, sit: 0, rs: 0, bo: 0, ctc: 0, nc: 0, ol: 0, sal: 0 };
      for (const id of g.ids) {
        const m = metricByCanvasser.get(id);
        if (m) {
          conf += m.conf;
          // Blowout absorbs N/A: every dead-end button result counts here.
          kil += m.kil + m.na;
          fut += m.fut;
        }
        pts += pointsByUser.get(id) ?? 0;
        vol += volumeByUser.get(id) ?? 0;
        const rr = resultsByUser.get(id);
        if (rr) {
          res.lds += rr.lds;
          res.sit += rr.sit;
          res.rs += rr.rs;
          res.bo += rr.bo;
          res.ctc += rr.ctc;
          res.nc += rr.nc;
          res.ol += rr.ol;
          res.sal += rr.sal;
        }
      }
      // Submitted = the sum of actioned results (owner, 2026-07-28):
      // Submitted ≡ Confirmed + Future + Blowout by construction.
      const sub = conf + fut + kil;
      return { g, conf, kil, fut, sub, pts, vol, res };
    });
    return enriched.sort((a, b) => {
      if (b.sub !== a.sub) return b.sub - a.sub;
      if (b.conf !== a.conf) return b.conf - a.conf;
      return (a.g.display_name ?? "").localeCompare(b.g.display_name ?? "");
    });
  }, [visible, metricByCanvasser, pointsByUser, volumeByUser, resultsByUser]);

  const totals = useMemo(() => {
    let sub = 0,
      conf = 0,
      fut = 0,
      kil = 0,
      pts = 0,
      vol = 0;
    rows.forEach((r) => {
      sub += r.sub;
      conf += r.conf;
      fut += r.fut;
      kil += r.kil;
      pts += r.pts;
      vol += r.vol;
    });
    return { sub, conf, fut, kil, pts, vol };
  }, [rows]);

  // Suspension rule (owner, 2026-07-28): any TWO consecutive WORKED days
  // (Mon–Sat; Sundays never count) with zero leads generated = donut. Only
  // completed days count — today-in-progress never flags anyone, so the list
  // is stable all day and rolls at 7 PM with the report date. Excluded:
  // profiles with suspension_tracked=false (pseudo-agents, staff), reps
  // whose profile didn't exist for both days yet, and anyone with no credited
  // activity in over 7 calendar days (presumed off the team; auto-archive
  // finishes the job at 14).
  const suspensionRows = useMemo(() => {
    if (tab !== "day" || dayPreset !== "today" || workedDays.length < 2) return [];
    const genOn = (ids: string[], day: string) =>
      ids.reduce((a, id) => a + (genByDay.get(id)?.get(day) ?? 0), 0);
    const [d1, d2] = workedDays;
    return rows.flatMap((r) => {
      if (!r.g.tracked || dismissed.has(r.g.key)) return [];
      if (r.g.oldestCreated > d2) return [];
      if (!isRecentlyActive(today, r.g.ids, lastActiveBy, r.g.oldestCreated)) return [];
      if (genOn(r.g.ids, d1) !== 0 || genOn(r.g.ids, d2) !== 0) return [];
      // Consecutive zero worked days, newest backward, only days the profile existed.
      let streak = 0;
      let capped = true;
      for (const day of workedDays) {
        if (day < r.g.oldestCreated) {
          capped = false;
          break;
        }
        if (genOn(r.g.ids, day) === 0) streak++;
        else {
          capped = false;
          break;
        }
      }
      return [{ g: r.g, d1, d2, streak, streakLabel: `${streak}${capped ? "+" : ""}` }];
    });
  }, [rows, genByDay, workedDays, tab, dayPreset, dismissed, lastActiveBy, today]);

  const canManage = !readOnly && isManagerRole(realRole);

  const footnote =
    tab === "day"
      ? "Funnel columns show the selected day. Lead results, Points, and Volume are this week's results in progress — the full Mon–Sat week containing that day, Pacific time (PM = 1 pt, Sale = 2 pts)."
      : tab === "week"
        ? "Points reflect Mon–Sat of the selected week, Pacific time (PM = 1 pt, Sale = 2 pts; BO/RS = 0). Volume runs Mon 12:00 AM → next Mon 12:00 AM Pacific."
        : "Points cover the calendar month, Pacific time (PM = 1 pt, Sale = 2 pts). Volume resets on the 1st, 12:00 AM Pacific.";

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="flex items-center gap-2">
          <Radio className="w-4 h-4 text-victory animate-pulse" />
          <div>
            <div className="text-[10px] font-display uppercase tracking-widest text-muted-foreground flex items-center gap-2">
              Fleet Dispatch · {range.label}
              {locked && tab === "day" && dayPreset === "today" && (
                <span className="inline-flex items-center gap-1 text-warning">
                  <Lock className="w-3 h-3" /> 7PM LOCK
                </span>
              )}
            </div>
            <div className="font-display text-sm text-neon mt-0.5">
              {readOnly ? "LEADERBOARD · LIVE" : "READ-ONLY · MONDAY.COM FEED"}
            </div>
          </div>
        </div>
        {!readOnly && (
          <div className="flex items-center gap-2">
            <WebhookLogsButton />
            <OfficeFilterToggle />
          </div>
        )}
      </div>

      {/* Range tabs: Day / Week / Month, plus each range's own controls */}
      <div className="flex items-center gap-1.5 overflow-x-auto scrollbar-hide">
        {(
          [
            { id: "day", label: "Day" },
            { id: "week", label: "Week" },
            { id: "month", label: "Month" },
          ] as Array<{ id: RangeTab; label: string }>
        ).map((p) => {
          const active = tab === p.id;
          return (
            <button
              key={p.id}
              type="button"
              onClick={() => setTab(p.id)}
              className={`px-3 py-2 rounded-full text-[10px] font-display uppercase tracking-widest whitespace-nowrap border transition-colors ${
                active
                  ? "bg-neon text-background border-neon"
                  : "border-border text-muted-foreground hover:text-foreground hover:border-neon/40"
              }`}
            >
              {p.label}
            </button>
          );
        })}

        <span className="mx-1 h-5 w-px bg-border shrink-0" aria-hidden />

        {tab === "day" && (
          <>
            {(
              [
                { id: "today", label: "Today" },
                { id: "yesterday", label: "Yesterday" },
              ] as Array<{ id: DayPreset; label: string }>
            ).map((p) => {
              const active = dayPreset === p.id;
              return (
                <button
                  key={p.id}
                  type="button"
                  onClick={() => setDayPreset(p.id)}
                  className={`px-2.5 py-1.5 rounded-full text-[10px] font-display uppercase tracking-widest whitespace-nowrap border transition-colors ${
                    active
                      ? "bg-neon text-background border-neon"
                      : "border-border text-muted-foreground hover:text-foreground hover:border-neon/40"
                  }`}
                >
                  {p.label}
                </button>
              );
            })}
          </>
        )}

        {tab === "week" && (
          <>
            <Button
              size="sm"
              variant="outline"
              onClick={() => week.shiftWeek(-1)}
              title="Previous week"
            >
              <ChevronLeft className="w-4 h-4" />
            </Button>
            <div className="px-3 py-1 rounded border border-neon/40 bg-neon/5 flex items-center gap-2 whitespace-nowrap">
              <CalendarRange className="w-4 h-4 text-neon shrink-0" />
              <span className="text-xs font-display">{range.label}</span>
            </div>
            <Button size="sm" variant="outline" onClick={() => week.shiftWeek(1)} title="Next week">
              <ChevronRight className="w-4 h-4" />
            </Button>
            {!week.isCurrentWeek && (
              <Button size="sm" variant="ghost" onClick={() => week.goToWeek()}>
                Jump to current week
              </Button>
            )}
          </>
        )}

        {tab === "month" && (
          <>
            <Button
              size="sm"
              variant="outline"
              onClick={() => shiftMonth(-1)}
              title="Previous month"
            >
              <ChevronLeft className="w-4 h-4" />
            </Button>
            <div className="px-3 py-1 rounded border border-neon/40 bg-neon/5 flex items-center gap-2 whitespace-nowrap">
              <CalendarRange className="w-4 h-4 text-neon shrink-0" />
              <span className="text-xs font-display">{range.label}</span>
            </div>
            <Button size="sm" variant="outline" onClick={() => shiftMonth(1)} title="Next month">
              <ChevronRight className="w-4 h-4" />
            </Button>
            {!isCurrentMonth && (
              <Button size="sm" variant="ghost" onClick={() => setMonthStart(laMonthStartISO())}>
                Jump to current month
              </Button>
            )}
          </>
        )}

        <span className="ml-2 text-[10px] text-muted-foreground font-mono whitespace-nowrap">
          {range.sub}
        </span>
      </div>

      {!readOnly && <WebhookUrlBanner />}
      {!readOnly && <MondayTokenCard />}

      <div className="grid grid-cols-2 sm:grid-cols-3 md:grid-cols-6 gap-3">
        <TotalTile label="Submitted" value={totals.sub} accent="neon" />
        <TotalTile label="Confirmed" value={totals.conf} accent="victory" />
        <TotalTile label="Future" value={totals.fut} accent="accent" />
        <TotalTile label="Blowout" value={totals.kil} accent="danger" />
        <TotalTile label="Points" value={totals.pts} accent="warning" />
        <TotalTile label="Volume" value={formatCurrency(totals.vol)} accent="victory" />
      </div>
      <p className="text-[10px] text-muted-foreground -mt-2">{footnote}</p>

      <SuspensionBanner
        rows={suspensionRows}
        onRemove={
          readOnly
            ? undefined
            : (g) => {
                const name = g.display_name ?? "this player";
                // Vanish immediately; persist in the background.
                setDismissed((prev) => new Set(prev).add(g.key));
                supabase
                  .from("profiles")
                  .update({ suspension_tracked: false })
                  .in("id", g.ids)
                  .then(({ error }) => {
                    if (error) {
                      setDismissed((prev) => {
                        const n = new Set(prev);
                        n.delete(g.key);
                        return n;
                      });
                      toast.error(`Could not remove ${name}: ${error.message}`);
                      return;
                    }
                    qc.invalidateQueries({ queryKey: ["fleet_dispatch", "roster"] });
                    toast.success(`${name} removed from the suspension list`, {
                      action: {
                        label: "Undo",
                        onClick: () => {
                          supabase
                            .from("profiles")
                            .update({ suspension_tracked: true })
                            .in("id", g.ids)
                            .then(() => {
                              setDismissed((prev) => {
                                const n = new Set(prev);
                                n.delete(g.key);
                                return n;
                              });
                              qc.invalidateQueries({ queryKey: ["fleet_dispatch", "roster"] });
                            });
                        },
                      },
                    });
                  });
              }
        }
      />

      {rows.length === 0 ? (
        <div className="arcade-card p-8 text-center text-sm text-muted-foreground flex flex-col items-center gap-2">
          <Users className="w-5 h-5" />
          No canvassers in this office yet.
        </div>
      ) : (
        <DispatchFleet rows={rows} vans={vans} />
      )}

      {/* Former Executive Dashboard tab (merged 2026-08-04): Results Week +
          Manual Entry + Weekly Results (Pay) + Live Daily Action + raw
          daily_logs — shares this board's office filter. Managers only;
          the read-only leaderboard copy shows just the fleet board. */}
      {!readOnly && <ExecutiveSection />}

      {canManage && (
        <div className="space-y-4">
          <button
            type="button"
            onClick={() => setManageOpen((o) => !o)}
            className="arcade-card w-full px-4 py-3 flex items-center justify-between text-left hover:bg-surface-elevated"
          >
            <span className="flex items-center gap-2 text-[10px] font-display uppercase tracking-widest text-muted-foreground">
              <Wrench className="w-4 h-4 text-accent" />
              Manage Fleet · Vans, Agents, Archive
            </span>
            {manageOpen ? (
              <ChevronUp className="w-4 h-4 text-muted-foreground" />
            ) : (
              <ChevronDown className="w-4 h-4 text-muted-foreground" />
            )}
          </button>
          {manageOpen && (
            <FleetDispatchManage
              vans={vans}
              profiles={allProfiles}
              rolesByUser={rolesByUser}
              pointsByUser={pointsByUser}
              volumeByUser={volumeByUser}
            />
          )}
        </div>
      )}
    </div>
  );
}

type FunnelRow = {
  g: {
    key: string;
    ids: string[];
    display_name: string | null;
    role: "canvasser" | "captain";
    team_id: string | null;
  };
  sub: number;
  conf: number;
  fut: number;
  kil: number;
  pts: number;
  vol: number;
  res: DispatchResults;
};

const FUNNEL_COLS: Array<{
  short: string;
  full: string;
  key: "sub" | "conf" | "fut" | "kil";
  color: keyof typeof metricColorClass;
}> = [
  { short: "Sub", full: "Submitted", key: "sub", color: "neon" },
  { short: "Con", full: "Confirmed", key: "conf", color: "victory" },
  { short: "Fut", full: "Future", key: "fut", color: "accent" },
  { short: "BO", full: "Blowout — dead-end at confirmation", key: "kil", color: "destructive" },
];

/** The lead-results half of the continuous row — Weekly Results columns in
 *  dispatch clothing. Points renders as its own trailing cell (row.pts). */
const RESULT_COLS: Array<{
  short: string;
  full: string;
  key: keyof DispatchResults;
  color: keyof typeof metricColorClass;
}> = [
  { short: "Lds", full: "Total Leads run", key: "lds", color: "neon" },
  { short: "Sit", full: "Sits (demos, sales split out)", key: "sit", color: "victory" },
  { short: "RS", full: "Resets", key: "rs", color: "accent" },
  { short: "BO", full: "Blowout at the door — no demo", key: "bo", color: "destructive" },
  { short: "CTC", full: "CTC — couldn't contact", key: "ctc", color: "muted-foreground" },
  { short: "NC", full: "Non-Core product", key: "nc", color: "warning" },
  { short: "OL", full: "One Legs / Outside Leads", key: "ol", color: "warning" },
  { short: "Sal", full: "Sales", key: "sal", color: "victory" },
];

/** One shared grid template: name · 4 funnel cols · divider · 8 result cols ·
 *  Points · Volume. Every board row (captions, headers, van totals, reps)
 *  uses it so the whole van card reads as one continuous chart. */
const ROW_GRID =
  "grid grid-cols-[minmax(7.5rem,1fr)_repeat(4,2.3rem)_0.75rem_repeat(9,2.3rem)_4.5rem] items-center gap-1";

/** Board rows need ~47rem; the van card scrolls horizontally below that. */
const ROW_MIN_W = "min-w-[47rem]";

function RowDivider() {
  return <span className="h-4 w-px bg-border justify-self-center" aria-hidden />;
}

/** One rep's continuous line — field funnel first, then what the leads became. */
function DispatchRow({ r }: { r: FunnelRow }) {
  return (
    <div className={`${ROW_GRID} px-2 py-1.5 rounded border border-border bg-surface hover:border-neon/60`}>
      <span className="text-sm truncate flex items-center gap-1.5 min-w-0">
        <span aria-hidden>{r.sub > 0 ? "🔥" : "🍩"}</span>
        <span className="truncate">{r.g.display_name ?? "—"}</span>
        {r.g.role === "captain" && (
          <span className="shrink-0 text-[9px] font-display uppercase tracking-widest px-1.5 py-0.5 rounded border border-accent/60 text-accent bg-accent/10">
            Captain
          </span>
        )}
      </span>
      {FUNNEL_COLS.map((c) => (
        <span
          key={c.key}
          title={c.full}
          className={`text-right font-display text-sm ${metricClass(r[c.key], c.color)}`}
        >
          {r[c.key]}
        </span>
      ))}
      <RowDivider />
      {RESULT_COLS.map((c) => (
        <span
          key={c.key}
          title={c.full}
          className={`text-right font-display text-sm ${metricClass(r.res[c.key], c.color)}`}
        >
          {r.res[c.key]}
        </span>
      ))}
      <span
        title="Points (PM = 1 pt, Sale = 2 pts)"
        className={`text-right font-display text-sm ${metricClass(r.pts, "neon")}`}
      >
        {r.pts}
      </span>
      <span
        title="Volume — confirmed sale dollars in the selected range"
        className={`text-right font-display text-sm ${metricClass(r.vol, "victory")}`}
      >
        {formatCurrency(r.vol)}
      </span>
    </div>
  );
}

/** Section captions over the two halves of the continuous row. */
function DispatchGroupCaption() {
  return (
    <div className={`${ROW_GRID} px-2`}>
      <span />
      <span className="col-span-4 text-center text-[8px] font-display uppercase tracking-widest text-muted-foreground/70 border-b border-border/60 pb-0.5">
        In the Field
      </span>
      <span />
      <span className="col-span-10 text-center text-[8px] font-display uppercase tracking-widest text-muted-foreground/70 border-b border-border/60 pb-0.5">
        As Leads
      </span>
    </div>
  );
}

/** Column headers, aligned to DispatchRow's grid. */
function DispatchColHeader() {
  return (
    <div className={`${ROW_GRID} px-2`}>
      <span />
      {FUNNEL_COLS.map((c) => (
        <span
          key={c.key}
          title={c.full}
          className="text-right text-[9px] font-display uppercase tracking-widest text-muted-foreground"
        >
          {c.short}
        </span>
      ))}
      <span />
      {RESULT_COLS.map((c) => (
        <span
          key={c.key}
          title={c.full}
          className="text-right text-[9px] font-display uppercase tracking-widest text-muted-foreground"
        >
          {c.short}
        </span>
      ))}
      <span
        title="Points (PM = 1 pt, Sale = 2 pts)"
        className="text-right text-[9px] font-display uppercase tracking-widest text-muted-foreground"
      >
        Pts
      </span>
      <span
        title="Volume — confirmed sale dollars in the selected range"
        className="text-right text-[9px] font-display uppercase tracking-widest text-muted-foreground"
      >
        Vol
      </span>
    </div>
  );
}

/** The board: office panels → van cards → per-rep funnel rows, with per-van
 *  Points and Volume pills, plus the unassigned lead-source pen. */
function DispatchFleet({ rows, vans }: { rows: FunnelRow[]; vans: Van[] }) {
  const { matches } = useOfficeFilter();

  const rowsByVan = new Map<string, FunnelRow[]>();
  const freeAgents: FunnelRow[] = [];
  const vanIds = new Set(vans.map((v) => v.id));
  for (const r of rows) {
    if (r.g.team_id && vanIds.has(r.g.team_id)) {
      const list = rowsByVan.get(r.g.team_id) ?? [];
      list.push(r);
      rowsByVan.set(r.g.team_id, list);
    } else {
      freeAgents.push(r);
    }
  }
  const looseActive = freeAgents.filter(
    (r) => r.sub + r.conf + r.fut + r.kil + r.pts + r.vol + r.res.lds + r.res.ol + r.res.sal > 0,
  );
  const vanTotals = (id: string) =>
    (rowsByVan.get(id) ?? []).reduce(
      (a, r) => ({
        sub: a.sub + r.sub,
        conf: a.conf + r.conf,
        fut: a.fut + r.fut,
        kil: a.kil + r.kil,
        pts: a.pts + r.pts,
        vol: a.vol + r.vol,
        res: {
          lds: a.res.lds + r.res.lds,
          sit: a.res.sit + r.res.sit,
          rs: a.res.rs + r.res.rs,
          bo: a.res.bo + r.res.bo,
          ctc: a.res.ctc + r.res.ctc,
          nc: a.res.nc + r.res.nc,
          ol: a.res.ol + r.res.ol,
          sal: a.res.sal + r.res.sal,
        },
      }),
      {
        sub: 0,
        conf: 0,
        fut: 0,
        kil: 0,
        pts: 0,
        vol: 0,
        res: { lds: 0, sit: 0, rs: 0, bo: 0, ctc: 0, nc: 0, ol: 0, sal: 0 },
      },
    );
  const vanSub = (id: string) => vanTotals(id).sub;
  const captainName = (v: Van) =>
    v.captain_id
      ? (rows.find((r) => r.g.ids.includes(v.captain_id!))?.g.display_name ?? null)
      : null;

  const offices = OFFICE_LOCATIONS.filter((o) => matches(o));

  return (
    <div className="space-y-4">
      {offices.map((office) => {
        const list = vans
          .filter((v) => (v.office_location ?? DEFAULT_OFFICE) === office)
          .sort((a, b) => vanSub(b.id) - vanSub(a.id) || a.name.localeCompare(b.name));
        if (list.length === 0) return null;
        return (
          <ArcadePanel
            key={office}
            title={`${office} · ${list.length} ${list.length === 1 ? "Van" : "Vans"}`}
          >
            {/* One card per row — the continuous field→leads line needs the
                full panel width (scrolls horizontally on small screens). */}
            <div className="grid gap-4">
              {list.map((v) => {
                const roster = (rowsByVan.get(v.id) ?? []).sort(
                  (a, b) => b.sub - a.sub || b.conf - a.conf,
                );
                const cap = captainName(v);
                const t = vanTotals(v.id);
                return (
                  <div key={v.id} className="van-card p-4 space-y-3">
                    <div className="flex items-center justify-between gap-2 flex-wrap">
                      <div className="flex items-center gap-2 min-w-0 flex-1">
                        <Truck className="w-4 h-4 shrink-0" style={{ color: v.color ?? "#888" }} />
                        <span className="min-w-0 truncate">
                          <TeamBadge name={v.name} color={v.color ?? "#888"} />
                        </span>
                        <span
                          className="shrink-0 text-[10px] font-display px-1.5 py-0.5 rounded border border-neon/40 text-neon"
                          title="Van Points for the selected range (PM = 1 pt, Sale = 2 pts)"
                        >
                          {t.pts}p
                        </span>
                        <span
                          className="shrink-0 text-[10px] font-display px-1.5 py-0.5 rounded border border-victory/40 text-victory"
                          title="Van Volume — confirmed sale dollars in the selected range"
                        >
                          {formatCurrency(t.vol)}
                        </span>
                        {cap && (
                          <span className="hidden sm:inline text-[10px] text-muted-foreground truncate min-w-0">
                            · {cap}
                          </span>
                        )}
                      </div>
                    </div>
                    {roster.length === 0 ? (
                      <div className="text-xs text-muted-foreground italic px-2 py-3 border border-dashed border-border rounded">
                        No active agents on this van.
                      </div>
                    ) : (
                      <div className="overflow-x-auto">
                        <div className={`space-y-1.5 ${ROW_MIN_W}`}>
                          <DispatchGroupCaption />
                          <DispatchColHeader />
                          {/* The whole van at a glance — every stat the
                              canvassers below sum into. */}
                          <div className={`${ROW_GRID} px-2 py-1.5 rounded border border-neon/40 bg-neon/5`}>
                            <span className="text-[10px] font-display uppercase tracking-widest text-neon truncate">
                              Van Total
                            </span>
                            {FUNNEL_COLS.map((c) => (
                              <span
                                key={c.key}
                                title={c.full}
                                className={`text-right font-display text-sm font-bold ${metricClass(t[c.key], c.color)}`}
                              >
                                {t[c.key]}
                              </span>
                            ))}
                            <RowDivider />
                            {RESULT_COLS.map((c) => (
                              <span
                                key={c.key}
                                title={c.full}
                                className={`text-right font-display text-sm font-bold ${metricClass(t.res[c.key], c.color)}`}
                              >
                                {t.res[c.key]}
                              </span>
                            ))}
                            <span
                              title="Points (PM = 1 pt, Sale = 2 pts)"
                              className={`text-right font-display text-sm font-bold ${metricClass(t.pts, "neon")}`}
                            >
                              {t.pts}
                            </span>
                            <span
                              title="Volume — confirmed sale dollars in the selected range"
                              className={`text-right font-display text-sm font-bold ${metricClass(t.vol, "victory")}`}
                            >
                              {formatCurrency(t.vol)}
                            </span>
                          </div>
                          {roster.map((r) => (
                            <DispatchRow key={r.g.key} r={r} />
                          ))}
                        </div>
                      </div>
                    )}
                  </div>
                );
              })}
            </div>
          </ArcadePanel>
        );
      })}

      {looseActive.length > 0 && (
        // No Free Agents pen — van membership auto-syncs from Monday's Van
        // column. What remains here are lead sources (referral, Self Gen…)
        // and the rare unassigned rep, shown only when they have numbers in
        // range so the totals tiles keep reconciling.
        <div className="arcade-card p-4 space-y-3">
          <div className="text-[10px] font-display uppercase tracking-widest text-muted-foreground">
            Lead Sources · Unassigned ({looseActive.length})
          </div>
          <div className="overflow-x-auto">
            <div className={`space-y-1.5 ${ROW_MIN_W}`}>
              <DispatchGroupCaption />
              <DispatchColHeader />
              {looseActive
                .sort(
                  (a, b) =>
                    b.sub - a.sub || (a.g.display_name ?? "").localeCompare(b.g.display_name ?? ""),
                )
                .map((r) => (
                  <DispatchRow key={r.g.key} r={r} />
                ))}
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

function SuspensionBanner({
  rows,
  onRemove,
}: {
  rows: Array<{
    g: { key: string; ids: string[]; display_name: string | null };
    d1: string;
    d2: string;
    streakLabel: string;
  }>;
  onRemove?: (g: { key: string; ids: string[]; display_name: string | null }) => void;
}) {
  if (rows.length === 0) return null;
  return (
    <div className="arcade-card p-4 border-destructive/60 bg-destructive/10">
      <div className="flex items-center gap-2 mb-1">
        <AlertTriangle className="w-4 h-4 text-destructive animate-pulse" />
        <div className="font-display text-sm text-destructive uppercase tracking-widest">
          🚨 Suspension Warning
        </div>
      </div>
      <div className="text-[10px] font-display uppercase tracking-widest text-muted-foreground mb-3">
        2 consecutive worked days without a lead · Sundays excluded · completed days only · active
        within 7 days
      </div>
      <div className="flex flex-wrap gap-2">
        {rows.map((r) => (
          <div
            key={r.g.key}
            className="relative arcade-card pl-3 pr-7 py-1.5 border-destructive/40"
          >
            {onRemove && (
              <button
                type="button"
                onClick={() => onRemove(r.g)}
                title="Remove from the suspension list (old / fired). Re-enable in Manage Players."
                aria-label={`Remove ${r.g.display_name ?? "player"} from the suspension list`}
                className="absolute top-1 right-1 w-4 h-4 inline-flex items-center justify-center rounded text-muted-foreground hover:text-destructive hover:bg-destructive/20"
              >
                <X className="w-3 h-3" />
              </button>
            )}
            <div className="flex items-center gap-2">
              <span className="frozen-doughnut" aria-hidden>
                🍩
              </span>
              <span className="text-sm font-medium">{r.g.display_name ?? "—"}</span>
            </div>
            <div className="text-[10px] font-mono text-muted-foreground mt-0.5">
              0 leads {fmtWorkedDay(r.d2)} + {fmtWorkedDay(r.d1)} · {r.streakLabel}-day streak
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}

function fireEndOfDayConfetti() {
  const duration = 3000;
  const end = Date.now() + duration;
  const colors = ["#39FF14", "#00E5FF", "#FF7A00", "#FF3366"];
  (function frame() {
    confetti({ particleCount: 4, angle: 60, spread: 55, origin: { x: 0 }, colors });
    confetti({ particleCount: 4, angle: 120, spread: 55, origin: { x: 1 }, colors });
    if (Date.now() < end) requestAnimationFrame(frame);
  })();
}

const metricColorClass = {
  neon: "text-neon",
  warning: "text-warning",
  "muted-foreground": "text-muted-foreground",
  victory: "text-victory",
  destructive: "text-destructive",
  accent: "text-accent",
};

/** Same dim-at-zero coloring as MetricCell, for the mobile card stats. */
function metricClass(value: number, color: keyof typeof metricColorClass) {
  return value > 0 ? metricColorClass[color] : "text-muted-foreground/40";
}

function WebhookUrlBanner() {
  const [copied, setCopied] = useState(false);
  // Direct backend Edge Function URL — bypasses the frontend entirely so
  // Monday.com receives a naked JSON challenge response, not HTML.
  const supabaseUrl = (import.meta.env.VITE_SUPABASE_URL as string | undefined) ?? "";
  const anonKey = (import.meta.env.VITE_SUPABASE_PUBLISHABLE_KEY as string | undefined) ?? "";
  const url = supabaseUrl
    ? `${supabaseUrl.replace(/\/$/, "")}/functions/v1/monday-live-dispatch${anonKey ? `?apikey=${encodeURIComponent(anonKey)}` : ""}`
    : "";

  const copy = async () => {
    try {
      await navigator.clipboard.writeText(url);
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    } catch {
      // ignore
    }
  };

  return (
    <div className="arcade-card p-4 border-accent/40">
      <div className="flex items-center gap-2 mb-2">
        <Link2 className="w-4 h-4 text-accent" />
        <div className="text-[10px] font-display uppercase tracking-widest text-accent">
          Webhook Integration URL · Direct Backend
        </div>
      </div>
      <div className="text-xs text-muted-foreground mb-3">
        Paste this raw backend URL into Monday.com. It returns naked JSON for the challenge
        handshake. Send POST with{" "}
        <code className="text-foreground">{`{ canvasser_name, status }`}</code> and the header{" "}
        <code className="text-foreground">x-monday-secret</code>.
      </div>
      <div className="flex flex-col sm:flex-row gap-2 items-stretch">
        <input
          readOnly
          value={url}
          onFocus={(e) => e.currentTarget.select()}
          className="flex-1 bg-surface border border-border rounded px-3 py-2 text-xs font-mono text-neon overflow-x-auto"
        />
        <button
          type="button"
          onClick={copy}
          className="arcade-card px-3 py-2 text-[10px] font-display uppercase tracking-widest text-accent hover:bg-surface-elevated flex items-center justify-center gap-2"
        >
          {copied ? <Check className="w-3.5 h-3.5" /> : <Copy className="w-3.5 h-3.5" />}
          {copied ? "Copied" : "Copy"}
        </button>
      </div>
    </div>
  );
}

function MondayTokenCard() {
  const qc = useQueryClient();
  const [value, setValue] = useState("");
  const [reveal, setReveal] = useState(false);
  const [saving, setSaving] = useState(false);
  const [savedAt, setSavedAt] = useState<number | null>(null);
  const [error, setError] = useState<string | null>(null);

  const { data, isLoading } = useQuery({
    queryKey: ["system-settings"],
    queryFn: async () => {
      const { data, error } = await supabase
        .from("system_settings")
        .select("monday_api_token, updated_at")
        .eq("id", true)
        .maybeSingle();
      if (error) throw error;
      return data as { monday_api_token: string | null; updated_at: string } | null;
    },
  });

  const hasToken = !!data?.monday_api_token;

  const save = async () => {
    setSaving(true);
    setError(null);
    const { error } = await supabase
      .from("system_settings")
      .upsert({ id: true, monday_api_token: value.trim() || null }, { onConflict: "id" });
    setSaving(false);
    if (error) {
      setError(error.message);
      return;
    }
    setValue("");
    setSavedAt(Date.now());
    qc.invalidateQueries({ queryKey: ["system-settings"] });
  };

  return (
    <div className="arcade-card p-4 border-warning/40">
      <div className="flex items-center gap-2 mb-2">
        <KeyRound className="w-4 h-4 text-warning" />
        <div className="text-[10px] font-display uppercase tracking-widest text-warning">
          Monday.com API Token
        </div>
        {hasToken && (
          <span className="ml-auto text-[10px] font-display uppercase tracking-widest text-victory">
            ✓ Configured
          </span>
        )}
      </div>
      <div className="text-xs text-muted-foreground mb-3">
        Required for the webhook to look up the canvasser name from Monday when only{" "}
        <code className="text-foreground">pulseId</code> is sent. Stored securely (owners only).
      </div>
      <div className="flex flex-col sm:flex-row gap-2 items-stretch">
        <div className="relative flex-1">
          <input
            type={reveal ? "text" : "password"}
            placeholder={
              isLoading
                ? "Loading…"
                : hasToken
                  ? "Enter new token to replace existing"
                  : "Paste Monday API token"
            }
            value={value}
            onChange={(e) => setValue(e.target.value)}
            className="w-full bg-surface border border-border rounded px-3 py-2 pr-10 text-xs font-mono text-neon"
          />
          <button
            type="button"
            onClick={() => setReveal((r) => !r)}
            className="absolute right-2 top-1/2 -translate-y-1/2 text-muted-foreground hover:text-foreground"
            aria-label={reveal ? "Hide token" : "Show token"}
          >
            {reveal ? <EyeOff className="w-3.5 h-3.5" /> : <Eye className="w-3.5 h-3.5" />}
          </button>
        </div>
        <button
          type="button"
          onClick={save}
          disabled={saving || !value.trim()}
          className="arcade-card px-3 py-2 text-[10px] font-display uppercase tracking-widest text-warning hover:bg-surface-elevated disabled:opacity-50"
        >
          {saving ? "Saving…" : "Save Token"}
        </button>
      </div>
      {error && <div className="mt-2 text-[11px] text-destructive font-mono">{error}</div>}
      {savedAt && !error && (
        <div className="mt-2 text-[11px] text-victory font-display uppercase tracking-widest">
          Saved
        </div>
      )}
    </div>
  );
}

function TotalTile({
  label,
  value,
  accent,
}: {
  label: string;
  value: number | string;
  accent: "neon" | "victory" | "accent" | "warning" | "danger" | "muted";
}) {
  const color =
    accent === "victory"
      ? "text-victory"
      : accent === "accent"
        ? "text-accent"
        : accent === "warning"
          ? "text-warning"
          : accent === "danger"
            ? "text-destructive"
            : accent === "muted"
              ? "text-muted-foreground"
              : "text-neon";
  return (
    <div className="arcade-card p-4">
      <div className="text-[10px] font-display uppercase tracking-widest text-muted-foreground">
        {label}
      </div>
      <div className={`font-display text-2xl mt-1 ${color}`}>{value}</div>
    </div>
  );
}

type WebhookLog = {
  id: string;
  created_at: string;
  source: string | null;
  step: string | null;
  data: unknown;
  raw_payload: unknown;
};

function WebhookLogsButton() {
  const [open, setOpen] = useState(false);
  const {
    data: logs = [],
    refetch,
    isFetching,
  } = useQuery({
    queryKey: ["webhook-logs"],
    enabled: open,
    queryFn: async () => {
      const { data } = await supabase
        .from("webhook_logs")
        .select("id, created_at, source, step, data, raw_payload")
        .order("created_at", { ascending: false })
        .limit(50);
      return (data ?? []) as WebhookLog[];
    },
  });

  return (
    <>
      <button
        type="button"
        onClick={() => setOpen(true)}
        className="arcade-card px-3 py-2 text-[10px] font-display uppercase tracking-widest text-accent hover:bg-surface-elevated flex items-center gap-2"
      >
        <FileSearch className="w-3.5 h-3.5" />
        Webhook Logs
      </button>
      {open && (
        <div
          className="fixed inset-0 z-50 bg-background/80 backdrop-blur-sm flex items-center justify-center p-4"
          onClick={() => setOpen(false)}
        >
          <div
            className="arcade-card w-full max-w-3xl max-h-[85vh] flex flex-col"
            onClick={(e) => e.stopPropagation()}
          >
            <div className="flex items-center justify-between p-4 border-b border-border">
              <div>
                <div className="text-[10px] font-display uppercase tracking-widest text-muted-foreground">
                  X-Ray · Raw Incoming Payloads
                </div>
                <div className="font-display text-sm text-neon mt-0.5">
                  WEBHOOK LOGS · LIVE (LAST 50)
                </div>
              </div>
              <div className="flex items-center gap-2">
                <button
                  type="button"
                  onClick={() => refetch()}
                  className="text-[10px] font-display uppercase tracking-widest text-accent px-2 py-1 hover:bg-surface-elevated rounded"
                >
                  {isFetching ? "…" : "Refresh"}
                </button>
                <button
                  type="button"
                  onClick={() => setOpen(false)}
                  className="text-muted-foreground hover:text-foreground"
                >
                  <X className="w-4 h-4" />
                </button>
              </div>
            </div>
            <div className="overflow-y-auto p-4 space-y-3">
              {logs.length === 0 ? (
                <div className="text-sm text-muted-foreground text-center py-8">
                  No webhook payloads received yet.
                </div>
              ) : (
                logs.map((l) => (
                  <div key={l.id} className="border border-border rounded p-3 bg-surface">
                    <div className="flex justify-between text-[10px] font-display uppercase tracking-widest text-muted-foreground mb-2">
                      <span className="text-neon">{l.step ?? l.source ?? "unknown"}</span>
                      <span>{new Date(l.created_at).toLocaleString()}</span>
                    </div>
                    <pre className="text-[11px] font-mono text-foreground whitespace-pre-wrap break-all max-h-64 overflow-auto">
                      {JSON.stringify(l.data ?? l.raw_payload ?? {}, null, 2)}
                    </pre>
                  </div>
                ))
              )}
            </div>
          </div>
        </div>
      )}
    </>
  );
}
