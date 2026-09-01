import { useCallback, useEffect, useMemo, useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { supabase } from "@/integrations/supabase/client";
import {
  OfficeFilterProvider,
  OfficeFilterToggle,
  useOfficeFilter,
} from "@/components/OfficeFilterContext";
import { ArcadeCard, ArcadePanel, NeonButton, TeamBadge } from "@/components/arcade";
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
  Truck,
  ChevronLeft,
  ChevronRight,
  CalendarRange,
  Wrench,
  ChevronDown,
  ChevronUp,
  UserPlus,
  Archive,
  ArrowRightLeft,
  Pencil,
  Merge,
} from "lucide-react";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectSeparator,
  SelectTrigger,
} from "@/components/ui/select";
import { toast } from "sonner";
import {
  addDaysISO,
  dateFromISO,
  fmtWorkedDay,
  formatWeekRange,
  laMidnightUtcISO,
  laMonthStartISO,
  laTodayISO,
  lastWorkedDaysBefore,
  monthStartISO,
  nextMonthStartISO,
  weekStartOfISO,
} from "@/lib/dates";
import { useWeekSelector } from "@/hooks/useWeekSelector";
import { useRealtimeInvalidate } from "@/hooks/useRealtimeInvalidate";
import { useAuth } from "@/hooks/useAuth";
import { canManageTarget, isManagerRole } from "@/lib/roles";
import { isRecentlyActive, lastActiveMap } from "@/lib/suspension";
import { formatCurrency, normalizeName } from "@/lib/utils";
import { isLeadSourceKey } from "@/lib/lead-sources";
import { DEFAULT_OFFICE, OFFICE_LOCATIONS } from "@/lib/offices";
import { getDispatchProduction, type DispatchResults } from "@/lib/dispatch.functions";
import { FleetDispatchManage } from "@/components/FleetDispatchManage";
import { FormerBadge } from "@/components/FormerBadge";
import { AddAgentDialog } from "@/components/AddAgentDialog";
import { RenameCanvasserDialog, type NameGroupRef } from "@/components/RenameCanvasserDialog";
import { MergeCanvasserDialog } from "@/components/MergeCanvasserDialog";
import { useMoveAgents, useArchiveAgents } from "@/hooks/useRosterActions";
import { ExecutiveSection } from "@/components/ExecutiveDashboard";

/** One profile row as the board consumes it (dispatch membership). */
export type RosterProfile = {
  id: string;
  display_name: string | null;
  office_location: string | null;
  team_id: string | null;
  team_office: string | null;
  is_active: boolean | null;
  is_placeholder: boolean | null;
  suspension_tracked: boolean;
  created_at: string;
};

type BoardProfile = RosterProfile & { role: "canvasser" | "captain"; former: boolean };

export type Van = {
  id: string;
  name: string;
  color: string | null;
  office_location: string | null;
};

// The dispatch funnel counts ONLY actioned Lead Status results (owner,
// 2026-07-28): Confirmed, Future, and Blowout — where Blowout absorbs the
// N/A and Disconnected labels (killed + no_answers columns). Submitted is
// their sum, so Submitted ≡ Confirmed + Future + Blowout always holds.
// A card contributes nothing until its status button is actioned; card
// creation (leads_generated) feeds only the suspension window.
// Funnel counts are attributed to the lead's SUBMISSION day (2026-08-24) —
// past metric_date rows legitimately keep filling in for a few days while
// the confirmation team works the backlog.
type Metric = {
  canvasser_id: string;
  metric_date: string;
  office_location: string | null;
  leads_confirmed: number;
  no_answers: number;
  killed: number;
  future: number;
  /** Van-at-the-time snapshot — absent until migration 20260827010000 lands. */
  team_id?: string | null;
};

export function FleetDispatch({
  readOnly = false,
  focusTeamId,
}: {
  readOnly?: boolean;
  /** Render only this van's card (the captain Command embed). Queries stay
   *  fleet-wide — same cache keys as the leaderboard — only display filters. */
  focusTeamId?: string | null;
}) {
  return (
    <OfficeFilterProvider>
      <FleetDispatchInner readOnly={readOnly} focusTeamId={focusTeamId ?? null} />
    </OfficeFilterProvider>
  );
}

type RangeTab = "day" | "week" | "month";
/** "today" follows the midnight-PT roll; any other value is a pinned YYYY-MM-DD past day. */
type DaySel = "today" | (string & {});

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

function FleetDispatchInner({
  readOnly,
  focusTeamId,
}: {
  readOnly: boolean;
  focusTeamId: string | null;
}) {
  const qc = useQueryClient();
  const { realRole } = useAuth();

  // --- Range engine: Day (report-date clock) / Week (Mon–Sun) / Month ---
  const [tab, setTab] = useState<RangeTab>("day");
  const [daySel, setDaySel] = useState<DaySel>("today");
  // Full calendar days (owner, 2026-08-04): "Today" is the LA calendar day,
  // midnight to 11:59 PM PT — today's results stay under Today all day. The
  // old 7 PM report-day roll (lock chip + confetti) is gone from this board;
  // the Daily Wrap page keeps its own 7 PM clock.
  const [today, setToday] = useState(laTodayISO);
  const yday = addDaysISO(today, -1);
  const dayISO = daySel === "today" ? today : daySel;
  const isViewingToday = dayISO === today;
  // Arrow past yesterday to any prior day; landing back on today resumes the
  // live midnight roll. Future days are definitionally empty under
  // submission-day attribution, so the forward arrow clamps at today.
  const shiftDay = (delta: 1 | -1) => {
    const next = addDaysISO(dayISO, delta);
    setDaySel(next >= today ? "today" : next);
  };
  // Chips removed via the X vanish instantly (optimistic) while the
  // suspension_tracked flag persists server-side.
  const [dismissed, setDismissed] = useState<Set<string>>(() => new Set());
  const [manageOpen, setManageOpen] = useState(false);
  const { office: officeTab, matches } = useOfficeFilter();

  // Roll to the new calendar day at midnight PT.
  useEffect(() => {
    const id = window.setInterval(() => {
      setToday((prev) => {
        const next = laTodayISO();
        return next === prev ? prev : next;
      });
    }, 30_000);
    return () => window.clearInterval(id);
  }, []);

  const week = useWeekSelector({ endOffsetDays: 6 }); // Mon–Sun — Block boards carry Sunday groups (owner, 2026-08-31)
  const [monthStart, setMonthStart] = useState<string>(() => laMonthStartISO());
  const shiftMonth = (delta: 1 | -1) =>
    setMonthStart((m) => (delta > 0 ? nextMonthStartISO(m) : monthStartISO(addDaysISO(m, -1))));
  const isCurrentMonth = monthStart === laMonthStartISO();
  const monthLabel = new Intl.DateTimeFormat(undefined, { month: "long", year: "numeric" }).format(
    dateFromISO(monthStart),
  );

  const range: ResolvedRange = useMemo(() => {
    if (tab === "day") {
      const d = dayISO;
      // Owner directive (2026-08-04): the "As Leads" half of the board reads
      // as THIS WEEK'S RESULTS IN PROGRESS — results, Points, and Volume
      // always cover the full Mon–Sun week containing the selected day
      // (matching the Weekly Results table), while "In the Field" keeps the
      // day's own funnel numbers.
      const wk = weekStartOfISO(d);
      return {
        funnelStart: d,
        funnelEnd: d,
        logStart: wk,
        logEnd: addDaysISO(wk, 6),
        volStartISO: laMidnightUtcISO(wk),
        volEndISO: laMidnightUtcISO(addDaysISO(wk, 7)),
        label: isViewingToday ? "Today" : d === yday ? "Yesterday" : fmtWorkedDay(d),
        sub: d,
        isLive: isViewingToday,
      };
    }
    if (tab === "week") {
      return {
        funnelStart: week.weekStartISO,
        funnelEnd: week.weekEndISO,
        logStart: week.weekStartISO,
        logEnd: week.weekEndISO,
        // Volume window is Mon 00:00 → next Mon 00:00 LA (pay-engine week
        // attribution), matching the Mon–Sun funnel/points window.
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
    dayISO,
    isViewingToday,
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

  // Dates stamped on the section captions. On the Day tab the two halves
  // cover DIFFERENT windows: "In the Field" is the selected day alone,
  // "As Leads" spans that day's Mon–Sun week (owner directive 2026-08-04),
  // so each caption stamps its own window — the day's own date rather than
  // range.label's "Today"/"Yesterday" wording, and the log window's week
  // for the results half. Numeric M/D endpoints and the short month name —
  // spelled-out forms ("Aug 31 – Sep 6, 2026", "September 2026") wrap the
  // caption at the row's mobile min-width.
  const mdISO = (iso: string) => `${Number(iso.slice(5, 7))}/${Number(iso.slice(8, 10))}`;
  const monthShortLabel = new Intl.DateTimeFormat(undefined, {
    month: "short",
    year: "numeric",
  }).format(dateFromISO(monthStart));
  const fieldDateLabel =
    tab === "day"
      ? fmtWorkedDay(dayISO)
      : tab === "week"
        ? `${mdISO(range.funnelStart)} – ${mdISO(range.funnelEnd)}`
        : monthShortLabel;
  const leadsDateLabel =
    tab === "month" ? monthShortLabel : `${mdISO(range.logStart)} – ${mdISO(range.logEnd)}`;

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
            "id, display_name, office_location, team_id, is_active, is_placeholder, suspension_tracked, created_at, teams:team_id(office_location)",
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
          is_placeholder: boolean | null;
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
        is_placeholder: p.is_placeholder,
        suspension_tracked: p.suspension_tracked,
        created_at: p.created_at,
        team_office: p.teams?.office_location ?? null,
      }));
      return { profiles, rolesByUser };
    },
  });
  const allProfiles = rosterQuery.data?.profiles ?? [];
  const rolesByUser = rosterQuery.data?.rolesByUser ?? new Map<string, string[]>();

  // Board membership: active canvassers and captains as before (is_active
  // === true — null is NOT active here, while Manage Fleet deliberately
  // treats null as active, matching the old split), PLUS everyone else with
  // a role, carried as `former`. Former rows are data-gated downstream —
  // they render only in ranges where they actually produced, bucketed by
  // their daily_logs/leads team snapshot — so removed people keep their
  // history without haunting the daily roster (owner, 2026-08-27).
  const canvassers: BoardProfile[] = useMemo(() => {
    const out: BoardProfile[] = [];
    for (const p of allProfiles) {
      const roles = rolesByUser.get(p.id) ?? [];
      const role = roles.includes("captain")
        ? "captain"
        : roles.includes("canvasser")
          ? "canvasser"
          : null;
      if (!role) continue;
      out.push({ ...p, role, former: p.is_active !== true });
    }
    return out;
  }, [allProfiles, rolesByUser]);

  const { data: vans = [] } = useQuery({
    queryKey: ["fleet_dispatch", "vans"],
    queryFn: async () => {
      const { data, error } = await supabase
        .from("teams")
        .select("id, name, color, office_location")
        .order("name");
      if (error) throw error;
      return (data ?? []) as Van[];
    },
  });

  // The Confirmation van (Cynthia's) confirms for BOTH offices, so it renders
  // on every office tab showing that office's slice of its members' production
  // (owner, 2026-08-10). Keyed by name: rename the van and it goes back to
  // being a normal single-office van.
  const crossOfficeVanIds = useMemo(
    () =>
      new Set(vans.filter((v) => v.name.trim().toLowerCase() === "confirmation").map((v) => v.id)),
    [vans],
  );

  const { data: metrics = [] } = useQuery({
    queryKey: ["fleet_dispatch", "funnel", range.funnelStart, range.funnelEnd],
    queryFn: async () => {
      // team_id ships in migration 20260827010000 — until the owner applies
      // it, retry without the column (42703) and lean on the daily_logs
      // snapshots for former-member bucketing.
      const { data, error } = await supabase
        .from("daily_metrics")
        .select(
          "canvasser_id, metric_date, office_location, leads_confirmed, no_answers, killed, future, team_id",
        )
        .gte("metric_date", range.funnelStart)
        .lte("metric_date", range.funnelEnd);
      if (!error) return (data ?? []) as Metric[];
      if (error.code !== "42703") throw error;
      const retry = await supabase
        .from("daily_metrics")
        .select(
          "canvasser_id, metric_date, office_location, leads_confirmed, no_answers, killed, future",
        )
        .gte("metric_date", range.funnelStart)
        .lte("metric_date", range.funnelEnd);
      if (retry.error) throw retry.error;
      return (retry.data ?? []) as Metric[];
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
  // Van-at-the-time per canvasser — buckets former reps' history into the
  // van they earned it on, since removal already nulled their live
  // profiles.team_id. daily_logs/leads snapshots win; daily_metrics.team_id
  // (post-migration) covers funnel-only weeks with no log rows.
  const snapshotTeamByUser = useMemo(() => {
    const map = new Map<string, string>(Object.entries(production.data?.snapshotTeam ?? {}));
    const metricTeam = new Map<string, { date: string; team: string }>();
    for (const m of metrics) {
      if (!m.team_id) continue;
      const prev = metricTeam.get(m.canvasser_id);
      if (!prev || m.metric_date > prev.date) {
        metricTeam.set(m.canvasser_id, { date: m.metric_date, team: m.team_id });
      }
    }
    for (const [cid, v] of metricTeam) {
      if (!map.has(cid)) map.set(cid, v.team);
    }
    return map;
  }, [production.data, metrics]);
  // Dates with a daily_logs row, per canvasser — the Day tab's former gate.
  const logDatesByUser = useMemo(() => {
    const m = new Map<string, Set<string>>();
    for (const [cid, dates] of Object.entries(production.data?.logDates ?? {})) {
      m.set(cid, new Set(dates));
    }
    return m;
  }, [production.data]);
  // One effective-team rule everywhere (office admission, slicing, bucketing):
  // current members follow their live van; former members follow the van
  // their in-range rows were stamped with, live team_id as the fallback for
  // webhook-re-assigned archived profiles.
  const effectiveTeamFor = useCallback(
    (c: { id: string; team_id: string | null; former: boolean }) =>
      c.former ? (snapshotTeamByUser.get(c.id) ?? c.team_id) : c.team_id,
    [snapshotTeamByUser],
  );
  const vanOfficeById = useMemo(
    () => new Map(vans.map((v) => [v.id, v.office_location ?? DEFAULT_OFFICE])),
    [vans],
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
        .select("canvasser_id, metric_date, leads_generated, leads_submitted, leads_confirmed")
        .in("metric_date", workedDays);
      return (data ?? []) as Array<{
        canvasser_id: string;
        metric_date: string;
        leads_generated: number;
        leads_submitted: number;
        leads_confirmed: number;
      }>;
    },
  });

  // Realtime — one channel; prefix invalidation refreshes funnel, production,
  // suspension window, roster, and vans (fixes the old stale-banner gap).
  // profiles/teams keep one manager's van moves live on another's open board.
  useRealtimeInvalidate({
    channel: "fleet-dispatch-live",
    tables: ["daily_metrics", "daily_logs", "leads", "profiles", "teams"],
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

  // The same funnel sums keyed by the office each row was counted for —
  // feeds the Confirmation van's per-office slices.
  const officeMetricByCanvasser = useMemo(() => {
    const acc = new Map<
      string,
      Map<string, { conf: number; na: number; kil: number; fut: number }>
    >();
    for (const m of metrics) {
      const office = m.office_location ?? DEFAULT_OFFICE;
      const inner =
        acc.get(office) ??
        new Map<string, { conf: number; na: number; kil: number; fut: number }>();
      const prev = inner.get(m.canvasser_id) ?? { conf: 0, na: 0, kil: 0, fut: 0 };
      prev.conf += m.leads_confirmed ?? 0;
      prev.na += m.no_answers ?? 0;
      prev.kil += m.killed ?? 0;
      prev.fut += m.future ?? 0;
      inner.set(m.canvasser_id, prev);
      acc.set(office, inner);
    }
    return acc;
  }, [metrics]);

  // One office's share of a row's cells — same math as the combined row
  // assembly below, read from the office-dimensioned maps.
  const productionData = production.data;
  const sliceValues = useCallback(
    (ids: string[], office: string) => {
      let conf = 0,
        kil = 0,
        fut = 0,
        pts = 0,
        vol = 0;
      const res: DispatchResults = { lds: 0, sit: 0, rs: 0, bo: 0, ctc: 0, nc: 0, ol: 0, sal: 0 };
      const om = officeMetricByCanvasser.get(office);
      const op = productionData?.officePoints?.[office] ?? {};
      const ov = productionData?.officeVolume?.[office] ?? {};
      const orr = productionData?.officeResults?.[office] ?? {};
      for (const id of ids) {
        const m = om?.get(id);
        if (m) {
          conf += m.conf;
          // Blowout absorbs N/A: every dead-end button result counts here.
          kil += m.kil + m.na;
          fut += m.fut;
        }
        pts += op[id] ?? 0;
        vol += ov[id] ?? 0;
        const rr = orr[id];
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
      return { conf, kil, fut, sub: conf + fut + kil, pts, vol, res };
    },
    [officeMetricByCanvasser, productionData],
  );

  // gen[canvasser_id][date] = leads generated that worked day.
  const genByDay = useMemo(() => {
    const acc = new Map<string, Map<string, number>>();
    for (const m of windowMetrics) {
      const inner = acc.get(m.canvasser_id) ?? new Map<string, number>();
      // Any lead activity clears the day: generated (Block-board card),
      // submitted, or confirmed (Incoming Leads pipeline). Bobby's Friday
      // lead was confirmed-only and still tripped the donut (owner,
      // 2026-08-10: "we can't make these type of mistakes").
      inner.set(
        m.metric_date,
        (inner.get(m.metric_date) ?? 0) +
          (m.leads_generated ?? 0) +
          (m.leads_submitted ?? 0) +
          (m.leads_confirmed ?? 0),
      );
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
    () =>
      // Focus mode (captain Command embed) pins the board to one van and
      // ignores the office filter — a van lives in exactly one office.
      // Former members count as on-van when their snapshot says this van,
      // so the captain's historical ranges keep ex-members' production.
      focusTeamId
        ? canvassers.filter(
            // Former members admit by the SAME effective team the bucketing
            // uses (snapshot first) — OR-ing the live pointer would count a
            // webhook-re-assigned archived rep in this van's tiles while
            // their row buckets under the snapshot van's never-rendered card.
            (c) => (c.former ? effectiveTeamFor(c) === focusTeamId : c.team_id === focusTeamId),
          )
        : canvassers.filter((c) => {
            const eff = effectiveTeamFor(c);
            // A former member's office follows the van their history buckets
            // into — admission and bucketing must use the same key, or a tab's
            // tiles count a row whose van card renders on a different tab.
            const office = c.former
              ? ((eff && vanOfficeById.get(eff)) ?? c.office_location ?? c.team_office)
              : (c.office_location ?? c.team_office);
            return matches(office) || (eff !== null && crossOfficeVanIds.has(eff));
          }),
    [canvassers, matches, crossOfficeVanIds, focusTeamId, effectiveTeamFor, vanOfficeById],
  );

  // De-duplicate by normalized display_name. If any duplicate is a captain,
  // the merged row inherits the captain role. Metrics, points, and volume
  // from every duplicate canvasser_id aggregate into a single row.
  const rows = useMemo(() => {
    type Group = {
      key: string;
      ids: string[];
      /** Non-former ids only — roster actions and the suspension donut must
       *  never read an archived namesake's state (tracked flags, created
       *  dates, activity) into an active rep's row. */
      activeIds: string[];
      display_name: string | null;
      office_location: string | null;
      team_office: string | null;
      role: "canvasser" | "captain";
      tracked: boolean;
      oldestCreated: string;
      team_id: string | null;
      teamFromActive: boolean;
      former: boolean;
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
          activeIds: c.former ? [] : [c.id],
          display_name: c.display_name,
          office_location: c.office_location,
          team_office: c.team_office,
          // Suspension inputs and the Captain chip come from active members
          // only; former-only groups keep neutral values (never on the
          // banner — the former gate below skips them anyway).
          role: c.former ? "canvasser" : c.role,
          tracked: c.former ? true : c.suspension_tracked,
          oldestCreated: c.former ? "9999-12-31" : created,
          team_id: c.team_id,
          teamFromActive: !c.former && !!c.team_id,
          former: c.former,
        });
      } else {
        g.ids.push(c.id);
        if (!g.office_location && c.office_location) g.office_location = c.office_location;
        if (!g.team_office && c.team_office) g.team_office = c.team_office;
        if (!c.former) {
          g.activeIds.push(c.id);
          if (c.role === "captain") g.role = "captain";
          if (!c.suspension_tracked) g.tracked = false;
          if (created < g.oldestCreated) g.oldestCreated = created;
          // A name-group is former only when EVERY same-name profile is —
          // an active rep absorbing an archived duplicate stays a live row.
          g.former = false;
        }
        // The live van comes from an active member when one exists; an
        // archived namesake's (webhook-re-assigned) team is only a fallback.
        if (c.team_id) {
          if (!c.former && !g.teamFromActive) {
            g.team_id = c.team_id;
            g.teamFromActive = true;
          } else if (!g.team_id) {
            g.team_id = c.team_id;
          }
        }
      }
    }
    const enriched = Array.from(groups.values()).map((g) => {
      const effTeam = g.former
        ? (g.ids.map((id) => snapshotTeamByUser.get(id)).find((t) => !!t) ?? g.team_id)
        : g.team_id;
      // Confirmation-van members show only the active office's share on a
      // specific office tab (the per-office panels re-slice for "All").
      // Keyed by the same effective team the bucketing uses, so a former
      // member's row still slices instead of leaking both offices' numbers.
      if (officeTab !== "All" && effTeam && crossOfficeVanIds.has(effTeam)) {
        return { g, effTeam, ...sliceValues(g.ids, officeTab) };
      }
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
      return { g, effTeam, conf, kil, fut, sub, pts, vol, res };
    });
    // The former-row gate: removed/archived people render only in ranges
    // where they actually produced (same predicate as the unassigned pen),
    // so they never appear as forward-looking zero rows. Filtering HERE —
    // before totals and bucketing — keeps the top tiles ≡ Σ van cards.
    // The Day tab additionally requires activity ON that day (points/volume
    // span the whole week in progress, and a rep removed Tuesday must not
    // haunt Wednesday's live board on Monday's numbers).
    const dayISO = tab === "day" ? range.funnelStart : null;
    const gated = enriched.filter((r) => {
      if (!r.g.former) return true;
      if (!hasProduction(r)) return false;
      if (!dayISO) return true;
      return r.sub > 0 || r.g.ids.some((id) => logDatesByUser.get(id)?.has(dayISO));
    });
    return gated.sort((a, b) => {
      if (b.sub !== a.sub) return b.sub - a.sub;
      if (b.conf !== a.conf) return b.conf - a.conf;
      return (a.g.display_name ?? "").localeCompare(b.g.display_name ?? "");
    });
  }, [
    visible,
    metricByCanvasser,
    pointsByUser,
    volumeByUser,
    resultsByUser,
    officeTab,
    crossOfficeVanIds,
    sliceValues,
    snapshotTeamByUser,
    logDatesByUser,
    tab,
    range.funnelStart,
  ]);

  const totals = useMemo(() => {
    let sub = 0,
      conf = 0,
      fut = 0,
      kil = 0,
      sal = 0,
      vol = 0;
    rows.forEach((r) => {
      sub += r.sub;
      conf += r.conf;
      fut += r.fut;
      kil += r.kil;
      sal += r.res.sal;
      vol += r.vol;
    });
    return { sub, conf, fut, kil, sal, vol };
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
    if (tab !== "day" || !isViewingToday || workedDays.length < 2) return [];
    const genOn = (ids: string[], day: string) =>
      ids.reduce((a, id) => a + (genByDay.get(id)?.get(day) ?? 0), 0);
    const [d1, d2] = workedDays;
    return rows.flatMap((r) => {
      // Former members never hit the donut list — archive_agent keeps
      // suspension_tracked on purpose, and a just-removed rep still passes
      // the 7-day recency check, so without this they'd pop right back up.
      if (r.g.former) return [];
      if (!r.g.tracked || dismissed.has(r.g.key)) return [];
      // Everything below reads activeIds: an archived namesake's roles,
      // created date, or old activity must not flag or exempt a live rep.
      // Sales reps never appear on the suspension list (owner, 2026-08-04) —
      // even when a dual-role profile also puts them on the board.
      if (r.g.activeIds.some((id) => (rolesByUser.get(id) ?? []).includes("sales_rep"))) return [];
      if (r.g.oldestCreated > d2) return [];
      if (!isRecentlyActive(today, r.g.activeIds, lastActiveBy, r.g.oldestCreated)) return [];
      if (genOn(r.g.activeIds, d1) !== 0 || genOn(r.g.activeIds, d2) !== 0) return [];
      // Consecutive zero worked days, newest backward, only days the profile existed.
      let streak = 0;
      let capped = true;
      for (const day of workedDays) {
        if (day < r.g.oldestCreated) {
          capped = false;
          break;
        }
        if (genOn(r.g.activeIds, day) === 0) streak++;
        else {
          capped = false;
          break;
        }
      }
      return [{ g: r.g, d1, d2, streak, streakLabel: `${streak}${capped ? "+" : ""}` }];
    });
  }, [
    rows,
    genByDay,
    workedDays,
    tab,
    isViewingToday,
    dismissed,
    lastActiveBy,
    today,
    rolesByUser,
  ]);

  const canManage = !readOnly && isManagerRole(realRole);
  // Row actions (move/rename/combine/archive) are role-gated, NOT page-gated
  // — the suspension-✕ precedent (owner, 2026-08-12): captains manage their
  // people from the read-only surfaces (the leaderboard and their Command
  // tab's van board). ExecutiveSection, Manage Fleet, and the webhook cards
  // stay page-gated behind !readOnly.
  const canEditRows = isManagerRole(realRole);

  const footnote =
    tab === "day"
      ? "Funnel columns show the selected day, credited to the day the lead was SUBMITTED — a confirm recorded Monday for a Friday lead updates Friday, so recent days keep filling in for a few days. Lead results, Sales, and Volume are this week's results in progress — the full Mon–Sun week containing that day, credited to each card's block day, Pacific time."
      : tab === "week"
        ? "Funnel counts credit each lead's submission day, so a just-closed week keeps filling in early the next week. Lead results credit each card's BLOCK day (the weekday it ran on the Block board), Mon–Sun of the selected week, Pacific time. Points: PM = 1 pt, Sale = 2 pts; BO/RS = 0. Volume runs Mon 12:00 AM → next Mon 12:00 AM Pacific."
        : "Points cover the calendar month, Pacific time (PM = 1 pt, Sale = 2 pts). Volume resets on the 1st, 12:00 AM Pacific.";

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="flex items-center gap-2">
          <Radio className="w-4 h-4 text-victory animate-pulse" />
          <div>
            <div className="text-[10px] font-display uppercase tracking-widest text-muted-foreground flex items-center gap-2">
              Fleet Dispatch · {range.label}
            </div>
            <div className="font-display text-sm text-neon mt-0.5">
              {focusTeamId
                ? "MY VAN · LIVE"
                : readOnly
                  ? "LEADERBOARD · LIVE"
                  : "READ-ONLY · MONDAY.COM FEED"}
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
            <Button size="sm" variant="outline" onClick={() => shiftDay(-1)} title="Previous day">
              <ChevronLeft className="w-4 h-4" />
            </Button>
            <div className="px-3 py-1 rounded border border-neon/40 bg-neon/5 flex items-center gap-2 whitespace-nowrap">
              <CalendarRange className="w-4 h-4 text-neon shrink-0" />
              <span className="text-xs font-display">{range.label}</span>
            </div>
            <Button
              size="sm"
              variant="outline"
              onClick={() => shiftDay(1)}
              disabled={isViewingToday}
              title="Next day"
            >
              <ChevronRight className="w-4 h-4" />
            </Button>
            {!isViewingToday && (
              <Button size="sm" variant="ghost" onClick={() => setDaySel("today")}>
                Jump to today
              </Button>
            )}
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
        <TotalTile label="Sales" value={totals.sal} accent="victory" />
        <TotalTile label="Volume" value={formatCurrency(totals.vol)} accent="victory" />
      </div>
      <p className="text-[10px] text-muted-foreground -mt-2">{footnote}</p>

      <SuspensionBanner
        rows={suspensionRows}
        onRemove={
          // Role-gated, not page-gated: captains get the one-click ✕ on their
          // read-only surfaces — the leaderboard and the Command van board
          // (owner, 2026-08-12). Writes persist for the whole manager tier via
          // the "Managers update non-privileged profiles" policy.
          !isManagerRole(realRole)
            ? undefined
            : (g) => {
                const name = g.display_name ?? "this player";
                // Vanish immediately; persist in the background.
                setDismissed((prev) => new Set(prev).add(g.key));
                supabase
                  .from("profiles")
                  .update({ suspension_tracked: false })
                  // Active namesakes only — flipping an archived duplicate's
                  // flag would silently exempt it from webhook van-sync and
                  // from tracking after a reactivation.
                  .in("id", g.activeIds)
                  .select("id")
                  .then(({ data, error }) => {
                    if (error || !data?.length) {
                      setDismissed((prev) => {
                        const n = new Set(prev);
                        n.delete(g.key);
                        return n;
                      });
                      toast.error(
                        `Could not remove ${name}: ${error?.message ?? "no permission for this agent"}`,
                      );
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
                            .in("id", g.activeIds)
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
        <ArcadeCard className="p-8 text-center text-sm text-muted-foreground flex flex-col items-center gap-2">
          <Users className="w-5 h-5" />
          {focusTeamId ? "No active agents on this van yet." : "No canvassers in this office yet."}
        </ArcadeCard>
      ) : (
        <DispatchFleet
          rows={rows}
          vans={vans}
          crossOfficeVanIds={crossOfficeVanIds}
          canManage={canManage}
          canEditRows={canEditRows}
          profiles={allProfiles}
          rolesByUser={rolesByUser}
          focusTeamId={focusTeamId}
          fieldDateLabel={fieldDateLabel}
          leadsDateLabel={leadsDateLabel}
        />
      )}

      {/* Former Executive Dashboard tab (merged 2026-08-04): Results Week +
          Manual Entry + Weekly Results (Pay) + Live Daily Action + raw
          daily_logs — shares this board's office filter. Managers only;
          the read-only leaderboard copy shows just the fleet board. */}
      {!readOnly && <ExecutiveSection />}

      {canManage && (
        <div className="space-y-4">
          <ArcadeCard
            asChild
            className="w-full px-4 py-3 flex items-center justify-between text-left hover:bg-surface-elevated"
          >
            <button type="button" onClick={() => setManageOpen((o) => !o)}>
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
          </ArcadeCard>
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
    /** Non-former ids — the only ones roster actions may touch. */
    activeIds: string[];
    display_name: string | null;
    role: "canvasser" | "captain";
    team_id: string | null;
    former: boolean;
  };
  /** The van this row buckets/slices under: live team for current members,
   *  the in-range snapshot team for former ones. */
  effTeam: string | null;
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
  {
    short: "Sub",
    full: "Submitted — actioned leads, credited to their submission day",
    key: "sub",
    color: "neon",
  },
  {
    short: "Con",
    full: "Confirmed — leads SUBMITTED this period that got confirmed (pipeline, not blocks run — compare Lds for cards run)",
    key: "conf",
    color: "victory",
  },
  {
    short: "Fut",
    full: "Future (incl. Future Reconf) — credited to the lead's submission day",
    key: "fut",
    color: "accent",
  },
  {
    short: "BO",
    full: "Blowout at CONFIRMATION (incl. N/As) — not the same as the door BO in Lead Results",
    key: "kil",
    color: "destructive",
  },
];

/** The lead-results half of the continuous row — Weekly Results columns in
 *  dispatch clothing. Points renders as its own trailing cell (row.pts). */
const RESULT_COLS: Array<{
  short: string;
  full: string;
  key: keyof DispatchResults;
  color: keyof typeof metricColorClass;
}> = [
  { short: "Lds", full: "Total Leads run on blocks, credited to each card's block day", key: "lds", color: "neon" },
  { short: "Sit", full: "Sits (demos, sales split out)", key: "sit", color: "victory" },
  { short: "RS", full: "Resets", key: "rs", color: "accent" },
  { short: "BO", full: "Blowout at the door — no demo (confirmation BOs live in the funnel half)", key: "bo", color: "destructive" },
  { short: "CTC", full: "CTC — couldn't contact", key: "ctc", color: "muted-foreground" },
  { short: "NC", full: "Non-Core product", key: "nc", color: "warning" },
  { short: "OL", full: "One Legs / Outside Leads", key: "ol", color: "warning" },
  { short: "Sal", full: "Sales", key: "sal", color: "victory" },
];

/** One shared grid template: name · 4 funnel cols · divider · 8 result cols ·
 *  Points · Volume. Every board row (captions, headers, van totals, reps)
 *  uses it so the whole van card reads as one continuous chart. Manage mode
 *  (managers on the dashboard, never the read-only leaderboard) appends a
 *  trailing actions column — every row variant appends a cell so the columns
 *  stay aligned. */
const ROW_GRID =
  "grid grid-cols-[minmax(7.5rem,1fr)_repeat(4,2.3rem)_0.75rem_repeat(9,2.3rem)_4.5rem] items-center gap-1";
const ROW_GRID_MANAGE =
  "grid grid-cols-[minmax(7.5rem,1fr)_repeat(4,2.3rem)_0.75rem_repeat(9,2.3rem)_4.5rem_5rem] items-center gap-1";
const rowGrid = (manage: boolean) => (manage ? ROW_GRID_MANAGE : ROW_GRID);

/** Board rows need ~47rem (~52rem with the actions column); the van card
 *  scrolls horizontally below that. */
const ROW_MIN_W = "min-w-[47rem]";
const rowMinW = (manage: boolean) => (manage ? "min-w-[52rem]" : ROW_MIN_W);

/** A row's stats without its identity — what totals and stat-cell runs share. */
type DispatchStats = Omit<FunnelRow, "g" | "effTeam">;

/* Pure, module-level (stable identity — no useCallback needed): the board's
 * two sort orders, the data-presence gate, and the van-total reducer. */
/** Any production at all in the selected range — the gate that decides
 *  whether a former member or unassigned lead source earns a board row. */
const hasProduction = (r: FunnelRow) =>
  r.sub + r.conf + r.fut + r.kil + r.pts + r.vol + r.res.lds + r.res.ol + r.res.sal > 0;
const byProduction = (a: FunnelRow, b: FunnelRow) => b.sub - a.sub || b.conf - a.conf;
const byProductionThenName = (a: FunnelRow, b: FunnelRow) =>
  b.sub - a.sub || (a.g.display_name ?? "").localeCompare(b.g.display_name ?? "");
const totalsOfRows = (list: FunnelRow[]): DispatchStats =>
  list.reduce<DispatchStats>(
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

function RowDivider() {
  return <span className="h-4 w-px bg-border justify-self-center" aria-hidden />;
}

/** Per-row roster controls shown to manager-tier viewers on both the
 *  dashboard board and the leaderboard. currentVanId null = the row sits in
 *  the unassigned pen (the menu reads "Assign Van…" and hides Free Agents). */
type RowManage = {
  vans: Van[];
  currentVanId: string | null;
  busy: boolean;
  onMove: (vanId: string | null) => void;
  onArchive: () => void;
  onRename: () => void;
  onMerge: () => void;
};

/** The shared 15-cell stat run — funnel · divider · results · Pts · Volume.
 *  Used by every rep line and (bold) by the Van Total line so the two can
 *  never drift; cells align because both render inside the same rowGrid. */
function DispatchStatCells({ s, bold = false }: { s: DispatchStats; bold?: boolean }) {
  const cell = bold
    ? "text-right font-display text-sm font-bold"
    : "text-right font-display text-sm";
  return (
    <>
      {FUNNEL_COLS.map((c) => (
        <span key={c.key} title={c.full} className={`${cell} ${metricClass(s[c.key], c.color)}`}>
          {s[c.key]}
        </span>
      ))}
      <RowDivider />
      {RESULT_COLS.map((c) => (
        <span
          key={c.key}
          title={c.full}
          className={`${cell} ${metricClass(s.res[c.key], c.color)}`}
        >
          {s.res[c.key]}
        </span>
      ))}
      <span
        title="Points (PM = 1 pt, Sale = 2 pts)"
        className={`${cell} ${metricClass(s.pts, "neon")}`}
      >
        {s.pts}
      </span>
      <span
        title="Volume — confirmed sale dollars in the selected range"
        className={`${cell} ${metricClass(s.vol, "victory")}`}
      >
        {formatCurrency(s.vol)}
      </span>
    </>
  );
}

/** One rep's continuous line — field funnel first, then what the leads became.
 *  gridManage keeps a row aligned with its managed siblings when THIS row has
 *  no controls (pseudo lead-sources, privileged targets) via an empty spacer
 *  cell — the same idiom as the caption/header/total rows. */
function DispatchRow({
  r,
  manage,
  gridManage = false,
}: {
  r: FunnelRow;
  manage?: RowManage;
  gridManage?: boolean;
}) {
  return (
    <div
      className={`${rowGrid(gridManage || !!manage)} px-2 py-1.5 rounded border border-border bg-surface transition-colors duration-200 hover:border-neon/60`}
    >
      <span className="text-sm truncate flex items-center gap-1.5 min-w-0">
        <span aria-hidden>{r.sub > 0 ? "🔥" : "🍩"}</span>
        <span className="truncate">{r.g.display_name ?? "—"}</span>
        {r.g.role === "captain" && !r.g.former && (
          <span className="shrink-0 text-[9px] font-display uppercase tracking-widest px-1.5 py-0.5 rounded border border-accent/60 text-accent bg-accent/10">
            Captain
          </span>
        )}
        {r.g.former && <FormerBadge />}
      </span>
      <DispatchStatCells s={r} />
      {gridManage && !manage && <span />}
      {manage && (
        <span className="flex items-center justify-end gap-0.5">
          <Select
            value="current"
            onValueChange={(val) => {
              if (val === "current") return;
              if (val === "__rename") return manage.onRename();
              if (val === "__merge") return manage.onMerge();
              manage.onMove(val === "free" ? null : val);
            }}
          >
            <SelectTrigger
              disabled={manage.busy}
              title="Move · Rename · Combine"
              className="h-7 w-11 px-1.5 justify-center bg-background border-[color:var(--neon-blue)]/50 hover:border-[color:var(--neon-blue)]"
            >
              <ArrowRightLeft className="w-3.5 h-3.5" />
            </SelectTrigger>
            <SelectContent className="bg-background border-[color:var(--neon-blue)]/50">
              <SelectItem value="current" disabled>
                {manage.currentVanId ? "Move to…" : "Assign Van…"}
              </SelectItem>
              {manage.currentVanId && <SelectItem value="free">Free Agents</SelectItem>}
              {manage.vans.map((vn) => (
                <SelectItem key={vn.id} value={vn.id} disabled={vn.id === manage.currentVanId}>
                  <span className="inline-flex items-center gap-2">
                    <span
                      className="w-2 h-2 rounded-full"
                      style={{ background: vn.color ?? "#888" }}
                    />
                    {vn.name}
                  </span>
                </SelectItem>
              ))}
              <SelectSeparator />
              <SelectItem value="__rename">
                <span className="inline-flex items-center gap-2">
                  <Pencil className="w-3.5 h-3.5" /> Rename…
                </span>
              </SelectItem>
              <SelectItem value="__merge">
                <span className="inline-flex items-center gap-2">
                  <Merge className="w-3.5 h-3.5" /> Combine with another player…
                </span>
              </SelectItem>
            </SelectContent>
          </Select>
          <button
            onClick={manage.onArchive}
            disabled={manage.busy}
            className="p-1 h-7 w-7 inline-flex items-center justify-center rounded hover:bg-muted text-muted-foreground hover:text-foreground disabled:opacity-50"
            title="Remove from roster (keeps history)"
          >
            <Archive className="w-3.5 h-3.5" />
          </button>
        </span>
      )}
    </div>
  );
}

/** Section captions over the two halves of the continuous row. */
function DispatchGroupCaption({
  manage = false,
  dateLabel,
  leadsDateLabel,
}: {
  manage?: boolean;
  dateLabel?: string;
  leadsDateLabel?: string;
}) {
  return (
    <div className={`${rowGrid(manage)} px-2`}>
      <span />
      <span className="col-span-4 text-center text-[8px] font-display uppercase tracking-widest text-muted-foreground/70 border-b border-border/60 pb-0.5">
        In the Field
        {dateLabel && <span className="text-muted-foreground/50"> · {dateLabel}</span>}
      </span>
      <span />
      <span className="col-span-10 text-center text-[8px] font-display uppercase tracking-widest text-muted-foreground/70 border-b border-border/60 pb-0.5">
        As Leads
        {leadsDateLabel && <span className="text-muted-foreground/50"> · {leadsDateLabel}</span>}
      </span>
      {manage && <span />}
    </div>
  );
}

/** Column headers, aligned to DispatchRow's grid. */
function DispatchColHeader({ manage = false }: { manage?: boolean }) {
  return (
    <div className={`${rowGrid(manage)} px-2`}>
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
      {manage && <span />}
    </div>
  );
}

/** The board: office panels → van cards → per-rep funnel rows, with per-van
 *  Points and Volume pills, plus the unassigned lead-source pen. When
 *  canEditRows is set (manager tier, on the dashboard AND the leaderboard),
 *  each rep row gets a Move/Rename/Combine menu + Remove button — per-target
 *  gated by canManageTarget, never on pseudo lead-source rows. canManage
 *  (dashboard only) additionally enables each van header's "+" add button. */
function DispatchFleet({
  rows,
  vans,
  crossOfficeVanIds,
  canManage = false,
  canEditRows = false,
  profiles,
  rolesByUser,
  focusTeamId = null,
  fieldDateLabel,
  leadsDateLabel,
}: {
  rows: FunnelRow[];
  vans: Van[];
  crossOfficeVanIds: Set<string>;
  canManage?: boolean;
  canEditRows?: boolean;
  profiles: RosterProfile[];
  rolesByUser: Map<string, string[]>;
  focusTeamId?: string | null;
  fieldDateLabel?: string;
  leadsDateLabel?: string;
}) {
  const { office: activeOffice, matches } = useOfficeFilter();
  const { realRole } = useAuth();
  const moveAgents = useMoveAgents(vans);
  const archiveAgents = useArchiveAgents();
  const [addOpen, setAddOpen] = useState(false);
  const [addVanId, setAddVanId] = useState<string | null>(null);
  const [renameTarget, setRenameTarget] = useState<NameGroupRef | null>(null);
  const [mergeSource, setMergeSource] = useState<NameGroupRef | null>(null);
  const [mergePreset, setMergePreset] = useState<string | null>(null);
  const busy = moveAgents.isPending || archiveAgents.isPending;

  /** Row controls for a manager-tier viewer — or undefined (spacer only) for
   *  pseudo lead-source rows and targets above the viewer's pay grade. */
  const manageFor = (r: FunnelRow, currentVanId: string | null): RowManage | undefined => {
    if (!canEditRows) return undefined;
    // Former rows are history, not roster — Move/Archive on an archived
    // profile would set team_id without reactivating (a half-alive state).
    // Reactivation lives in Manage Fleet → Archived Agents.
    if (r.g.former) return undefined;
    if (isLeadSourceKey(r.g.key)) return undefined;
    // Roster actions touch active profiles only — moving/archiving an
    // archived namesake alongside would set team_id on an is_active=false
    // profile, the half-alive state the former guard above exists to block.
    const targetRoles = r.g.activeIds.flatMap((id) => rolesByUser.get(id) ?? []);
    if (!canManageTarget(realRole, targetRoles)) return undefined;
    return {
      vans,
      currentVanId,
      busy,
      onMove: (vanId) =>
        moveAgents.mutate({ ids: r.g.activeIds, vanId, name: r.g.display_name ?? "Agent" }),
      onArchive: () => {
        if (
          confirm(
            `Remove "${r.g.display_name}" from the roster? Their history and data are kept — reactivate anytime from Archived Agents.`,
          )
        ) {
          archiveAgents.mutate({ ids: r.g.activeIds, name: r.g.display_name ?? "Agent" });
        }
      },
      onRename: () => setRenameTarget(r.g),
      onMerge: () => {
        setMergePreset(null);
        setMergeSource(r.g);
      },
    };
  };

  // One pass over the roster per data change — rosters pre-sorted, totals
  // and captain names precomputed — instead of rebuilding maps and
  // re-reducing per-van totals (O(vans × reps), and again inside every sort
  // comparison) on every render of a board that refetches on realtime pings.
  const { rowsByVan, looseActive, totalsByVan, captainNamesByVan } = useMemo(() => {
    const rowsByVan = new Map<string, FunnelRow[]>();
    const freeAgents: FunnelRow[] = [];
    const vanIds = new Set(vans.map((v) => v.id));
    for (const r of rows) {
      // r.effTeam: live van for current members, in-range snapshot van for
      // former ones (computed once in the rows memo, shared with slicing
      // and office admission). No match → the pen, which is data-gated.
      if (r.effTeam && vanIds.has(r.effTeam)) {
        const list = rowsByVan.get(r.effTeam) ?? [];
        list.push(r);
        rowsByVan.set(r.effTeam, list);
      } else {
        freeAgents.push(r);
      }
    }
    for (const list of rowsByVan.values()) list.sort(byProduction);
    const totalsByVan = new Map(vans.map((v) => [v.id, totalsOfRows(rowsByVan.get(v.id) ?? [])]));
    // Van captions come from the roster: active members holding the captain
    // role (teams.captain_id is seed-era data with no UI writer — a stale id
    // would caption a replaced captain, a NULL one no caption at all).
    // Deduped by normalizeName like the rows are — duplicate same-name
    // profiles ("Logan temple" / "Logan Temple") are normal on this board.
    // Profiles arrive display_name-ordered, so multi-captain joins are stable.
    const captainNamesByVan = new Map<string, string[]>();
    const seenCaptainKeys = new Set<string>();
    for (const p of profiles) {
      if (p.is_active !== true || !p.team_id || !p.display_name) continue;
      if (!(rolesByUser.get(p.id) ?? []).includes("captain")) continue;
      const key = `${p.team_id}|${normalizeName(p.display_name) || `id:${p.id}`}`;
      if (seenCaptainKeys.has(key)) continue;
      seenCaptainKeys.add(key);
      captainNamesByVan.set(p.team_id, [
        ...(captainNamesByVan.get(p.team_id) ?? []),
        p.display_name,
      ]);
    }
    const looseActive = freeAgents.filter(hasProduction).sort(byProductionThenName);
    return { rowsByVan, looseActive, totalsByVan, captainNamesByVan };
  }, [rows, vans, profiles, rolesByUser]);

  const vanSub = (id: string) => totalsByVan.get(id)?.sub ?? 0;
  const captainName = (v: Van) => {
    const names = captainNamesByVan.get(v.id);
    return names?.length ? names.join(" · ") : null;
  };

  const offices = OFFICE_LOCATIONS.filter((o) => matches(o));

  // Focus mode renders just the one van's card; the full `vans` list stays on
  // the Move-to… menu so a captain can still send a rep to another van.
  const boardVans = focusTeamId ? vans.filter((v) => v.id === focusTeamId) : vans;

  return (
    <div className="space-y-4">
      {offices.map((office) => {
        // A cross-office van appears in its home panel on "All Offices"
        // (combined numbers, owner: Cynthia reads 10 lds / 6 sit / 2 sal
        // there) and in the single visible panel on a specific office tab,
        // where the rows upstream are already sliced to that office.
        const list = boardVans
          .filter(
            (v) =>
              (v.office_location ?? DEFAULT_OFFICE) === office ||
              (activeOffice !== "All" && crossOfficeVanIds.has(v.id)),
          )
          .sort((a, b) => vanSub(b.id) - vanSub(a.id) || a.name.localeCompare(b.name));
        if (list.length === 0) return null;
        return (
          <ArcadePanel
            key={office}
            title={`${office} · ${list.length} ${list.length === 1 ? "Van" : "Vans"}`}
          >
            {/* One card per row — the continuous field→leads line needs the
                full panel width (scrolls horizontally on small screens).
                grid-cols-1 (minmax(0,1fr)) is load-bearing: a bare `grid`
                track sizes to the 47rem rows, so the van card outgrows the
                overflow-hidden panel and the row scroller never activates —
                the right half of the board becomes unreachable on phones
                and narrow windows. */}
            <div className="grid grid-cols-1 gap-4">
              {list.map((v) => {
                const roster = rowsByVan.get(v.id) ?? [];
                const cap = captainName(v);
                const t = totalsByVan.get(v.id) ?? totalsOfRows([]);
                return (
                  <div key={v.id} className="van-card p-4 space-y-3">
                    <div className="flex items-center justify-between gap-2 flex-wrap">
                      <div className="flex items-center gap-2 min-w-0 flex-1">
                        <Truck className="w-4 h-4 shrink-0" style={{ color: v.color ?? "#888" }} />
                        <span className="min-w-0 truncate">
                          <TeamBadge name={v.name} color={v.color ?? "#888"} />
                        </span>
                        {cap && (
                          <span className="hidden sm:inline text-[10px] text-muted-foreground truncate min-w-0">
                            · {cap}
                          </span>
                        )}
                      </div>
                      {canManage && (
                        <button
                          onClick={() => {
                            setAddVanId(v.id);
                            setAddOpen(true);
                          }}
                          className="p-2 md:p-1 min-h-9 min-w-9 md:min-h-0 md:min-w-0 inline-flex items-center justify-center rounded hover:bg-muted text-muted-foreground hover:text-foreground"
                          title="Add agent to this van"
                        >
                          <UserPlus className="w-3.5 h-3.5" />
                        </button>
                      )}
                    </div>
                    {roster.length === 0 ? (
                      <div className="text-xs text-muted-foreground italic px-2 py-3 border border-dashed border-border rounded">
                        No active agents on this van.
                      </div>
                    ) : (
                      <div className="overflow-x-auto">
                        <div className={`space-y-1.5 ${rowMinW(canEditRows)}`}>
                          <DispatchGroupCaption
                            manage={canEditRows}
                            dateLabel={fieldDateLabel}
                            leadsDateLabel={leadsDateLabel}
                          />
                          <DispatchColHeader manage={canEditRows} />
                          {/* The whole van at a glance — every stat the
                              canvassers below sum into. */}
                          <div
                            className={`${rowGrid(canEditRows)} px-2 py-1.5 rounded border border-neon/40 bg-neon/5`}
                          >
                            <span className="text-[10px] font-display uppercase tracking-widest text-neon truncate">
                              Van Total
                            </span>
                            <DispatchStatCells s={t} bold />
                            {canEditRows && <span />}
                          </div>
                          {roster.map((r) => (
                            <DispatchRow
                              key={r.g.key}
                              r={r}
                              manage={manageFor(r, v.id)}
                              gridManage={canEditRows}
                            />
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
        <ArcadeCard className="space-y-3">
          <div className="text-[10px] font-display uppercase tracking-widest text-muted-foreground">
            Lead Sources · Unassigned ({looseActive.length})
          </div>
          <div className="overflow-x-auto">
            <div className={`space-y-1.5 ${rowMinW(canEditRows)}`}>
              <DispatchGroupCaption
                manage={canEditRows}
                dateLabel={fieldDateLabel}
                leadsDateLabel={leadsDateLabel}
              />
              <DispatchColHeader manage={canEditRows} />
              {/* Junk name variants pile up exactly here (the Bouncer drops
                  unmatched Monday names into this pen), so unassigned rows
                  get the full menu too; pseudo lead-source rows come back
                  undefined from manageFor and keep just the spacer. */}
              {looseActive.map((r) => (
                <DispatchRow
                  key={r.g.key}
                  r={r}
                  manage={manageFor(r, null)}
                  gridManage={canEditRows}
                />
              ))}
            </div>
          </div>
        </ArcadeCard>
      )}

      {canManage && (
        <AddAgentDialog
          open={addOpen}
          onOpenChange={(o) => {
            setAddOpen(o);
            if (!o) setAddVanId(null);
          }}
          vans={vans}
          initialVanId={addVanId}
        />
      )}

      {canEditRows && (
        <>
          <RenameCanvasserDialog
            open={!!renameTarget}
            onOpenChange={(o) => {
              if (!o) setRenameTarget(null);
            }}
            group={renameTarget}
            profiles={profiles}
            rolesByUser={rolesByUser}
            onSwitchToMerge={(targetKey) => {
              setMergeSource(renameTarget);
              setMergePreset(targetKey);
              setRenameTarget(null);
            }}
          />
          <MergeCanvasserDialog
            open={!!mergeSource}
            onOpenChange={(o) => {
              if (!o) setMergeSource(null);
            }}
            source={mergeSource}
            profiles={profiles}
            rolesByUser={rolesByUser}
            presetTargetKey={mergePreset}
          />
        </>
      )}
    </div>
  );
}

function SuspensionBanner({
  rows,
  onRemove,
}: {
  rows: Array<{
    g: { key: string; ids: string[]; activeIds: string[]; display_name: string | null };
    d1: string;
    d2: string;
    streakLabel: string;
  }>;
  onRemove?: (g: {
    key: string;
    ids: string[];
    activeIds: string[];
    display_name: string | null;
  }) => void;
}) {
  if (rows.length === 0) return null;
  return (
    <ArcadeCard className="border-destructive/60 bg-destructive/10">
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
          <ArcadeCard key={r.g.key} className="relative pl-3 pr-7 py-1.5 border-destructive/40">
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
          </ArcadeCard>
        ))}
      </div>
    </ArcadeCard>
  );
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
    <ArcadeCard className="border-accent/40">
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
        <NeonButton tone="turf-cyan" onClick={copy}>
          {copied ? <Check className="w-3.5 h-3.5" /> : <Copy className="w-3.5 h-3.5" />}
          {copied ? "Copied" : "Copy"}
        </NeonButton>
      </div>
    </ArcadeCard>
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
    <ArcadeCard className="border-warning/40">
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
        <ArcadeCard
          asChild
          className="px-3 py-2 text-[10px] font-display uppercase tracking-widest text-warning hover:bg-surface-elevated disabled:opacity-50"
        >
          <button type="button" onClick={save} disabled={saving || !value.trim()}>
            {saving ? "Saving…" : "Save Token"}
          </button>
        </ArcadeCard>
      </div>
      {error && <div className="mt-2 text-[11px] text-destructive font-mono">{error}</div>}
      {savedAt && !error && (
        <div className="mt-2 text-[11px] text-victory font-display uppercase tracking-widest">
          Saved
        </div>
      )}
    </ArcadeCard>
  );
}

const TILE_TEXT = {
  neon: "text-neon",
  victory: "text-victory",
  accent: "text-accent",
  warning: "text-warning",
  danger: "text-destructive",
  muted: "text-muted-foreground",
} as const;

function TotalTile({
  label,
  value,
  accent,
}: {
  label: string;
  value: number | string;
  accent: keyof typeof TILE_TEXT;
}) {
  return (
    <ArcadeCard>
      <div className="text-[10px] font-display uppercase tracking-widest text-muted-foreground">
        {label}
      </div>
      <div className={`font-display text-2xl mt-1 ${TILE_TEXT[accent]}`}>{value}</div>
    </ArcadeCard>
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
      <NeonButton tone="turf-cyan" onClick={() => setOpen(true)}>
        <FileSearch className="w-3.5 h-3.5" />
        Webhook Logs
      </NeonButton>
      {open && (
        <div
          className="fixed inset-0 z-50 bg-background/80 backdrop-blur-sm flex items-center justify-center p-4"
          onClick={() => setOpen(false)}
        >
          <ArcadeCard
            className="p-0 w-full max-w-3xl max-h-[85vh] flex flex-col"
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
          </ArcadeCard>
        </div>
      )}
    </>
  );
}
