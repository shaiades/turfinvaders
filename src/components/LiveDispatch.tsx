import { useEffect, useMemo, useRef, useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { supabase } from "@/integrations/supabase/client";
import { OfficeFilterProvider, OfficeFilterToggle, useOfficeFilter } from "@/components/OfficeFilterContext";
import { ArcadePanel, TeamBadge } from "@/components/arcade";
import { Radio, Users, FileSearch, X, Link2, Copy, Check, KeyRound, Eye, EyeOff, AlertTriangle, Lock, Truck } from "lucide-react";
import { toast } from "sonner";
import confetti from "canvas-confetti";


type Profile = {
  id: string;
  display_name: string | null;
  office_location: string | null;
  team_id: string | null;
  team_office: string | null;
  role: "canvasser" | "captain";
  suspension_tracked: boolean;
  created_at: string;
};


// The dispatch funnel: Submitted (Inbound births) plus the confirmation
// team's Lead Status flips — Confirmed / Future / Blowout / N-A (killed and
// no_answers columns, Monday's labels). Unconfirmed is DERIVED: submitted
// minus everything actioned — the waiting pool, not a status flip.
type Metric = {
  id: string;
  canvasser_id: string;
  metric_date: string;
  leads_generated: number;
  leads_confirmed: number;
  no_answers: number;
  killed: number;
  future: number;
  office_location: string;
};

const PT_TZ = "America/Los_Angeles";
const PT_PARTS = new Intl.DateTimeFormat("en-US", {
  timeZone: PT_TZ,
  year: "numeric", month: "2-digit", day: "2-digit",
  hour: "2-digit", minute: "2-digit", hour12: false,
});

function ptNow() {
  const parts = Object.fromEntries(
    PT_PARTS.formatToParts(new Date()).map((p) => [p.type, p.value]),
  );
  return {
    year: Number(parts.year), month: Number(parts.month), day: Number(parts.day),
    hour: Number(parts.hour === "24" ? "0" : parts.hour), minute: Number(parts.minute),
  };
}
function addDaysISO(iso: string, delta: number) {
  const [y, m, d] = iso.split("-").map(Number);
  const dt = new Date(Date.UTC(y, m - 1, d));
  dt.setUTCDate(dt.getUTCDate() + delta);
  return dt.toISOString().slice(0, 10);
}
/** The last `n` completed worked days (Mon–Sat; Sundays never count),
 *  walking back from — and excluding — the given report date. Newest first.
 *  On a Tuesday this yields [Mon, Sat, Fri, …]: Saturday and Monday are
 *  consecutive worked days for the suspension rule. */
function lastWorkedDaysBefore(todayISO: string, n: number): string[] {
  const out: string[] = [];
  let d = todayISO;
  while (out.length < n) {
    d = addDaysISO(d, -1);
    if (new Date(`${d}T00:00:00Z`).getUTCDay() !== 0) out.push(d);
  }
  return out;
}

/** "Mon 7/28" for a chip label. */
function fmtWorkedDay(iso: string): string {
  return new Date(`${iso}T00:00:00Z`)
    .toLocaleDateString("en-US", { weekday: "short", month: "numeric", day: "numeric", timeZone: "UTC" })
    .replace(",", "");
}

/** Report date: before 7 PM PT → current PT date; at/after 7 PM PT → next PT date. */
function reportDates() {
  const { year, month, day, hour } = ptNow();
  const currentPT = `${year}-${String(month).padStart(2, "0")}-${String(day).padStart(2, "0")}`;
  const locked = hour >= 19;
  const today = locked ? addDaysISO(currentPT, 1) : currentPT;
  const yday = addDaysISO(today, -1);
  return { today, yday, locked };
}

export function LiveDispatch({ readOnly = false }: { readOnly?: boolean }) {
  return (
    <OfficeFilterProvider>
      <LiveDispatchInner readOnly={readOnly} />
    </OfficeFilterProvider>
  );
}

type Preset = "today" | "yesterday" | "week";

function normalizeName(s: string | null | undefined): string {
  return (s ?? "").trim().toLowerCase().replace(/\s+/g, " ");
}

function LiveDispatchInner({ readOnly }: { readOnly: boolean }) {
  const qc = useQueryClient();
  const [{ today, yday, locked }, setDates] = useState(reportDates);
  const [preset, setPreset] = useState<Preset>("today");
  // Chips removed via the X vanish instantly (optimistic) while the
  // suspension_tracked flag persists server-side.
  const [dismissed, setDismissed] = useState<Set<string>>(() => new Set());
  const { matches } = useOfficeFilter();
  const confettiFired = useRef(false);

  // Re-evaluate report date every 30s; fire confetti once when we cross 7 PM PT.
  useEffect(() => {
    const tick = () => {
      const next = reportDates();
      setDates((prev) => {
        if (!prev.locked && next.locked && !confettiFired.current) {
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

  const range = useMemo(() => {
    if (preset === "yesterday") return { start: yday, end: yday, label: "Yesterday" };
    if (preset === "week") {
      // Calendar Block week (Mon–Sat), same as the Monday boards.
      const [y, m, d] = today.split("-").map(Number);
      const dow = new Date(Date.UTC(y, m - 1, d)).getUTCDay(); // 0 = Sun
      const monday = addDaysISO(today, -((dow + 6) % 7));
      return { start: monday, end: addDaysISO(monday, 5), label: "This Week" };
    }
    return { start: today, end: today, label: "Today" };
  }, [preset, today, yday]);

  const { data: canvassers = [] } = useQuery({
    queryKey: ["dispatch-canvassers"],
    queryFn: async () => {
      const { data: roles } = await supabase
        .from("user_roles")
        .select("user_id, role")
        .in("role", ["canvasser", "captain"]);
      const roleMap = new Map<string, "canvasser" | "captain">();
      (roles ?? []).forEach((r) => {
        const prev = roleMap.get(r.user_id);
        if (prev === "captain") return;
        roleMap.set(r.user_id, r.role as "canvasser" | "captain");
      });
      const ids = Array.from(roleMap.keys());
      if (ids.length === 0) return [] as Profile[];
      const { data: profs } = await supabase
        .from("profiles")
        .select("id, display_name, office_location, team_id, suspension_tracked, created_at, teams:team_id(office_location)")
        .in("id", ids)
        .eq("is_active", true);
      const rows: Profile[] = ((profs ?? []) as Array<{
        id: string;
        display_name: string | null;
        office_location: string | null;
        team_id: string | null;
        suspension_tracked: boolean;
        created_at: string;
        teams: { office_location: string | null } | null;
      }>).map((p) => ({
        id: p.id,
        display_name: p.display_name,
        office_location: p.office_location,
        team_id: p.team_id,
        team_office: p.teams?.office_location ?? null,
        role: roleMap.get(p.id) ?? "canvasser",
        suspension_tracked: p.suspension_tracked,
        created_at: p.created_at,
      }));
      return rows;
    },
  });


  const { data: metrics = [] } = useQuery({
    queryKey: ["daily-metrics", range.start, range.end],
    queryFn: async () => {
      const { data } = await supabase
        .from("daily_metrics")
        .select(
          "id, canvasser_id, metric_date, leads_generated, leads_confirmed, no_answers, killed, future, office_location",
        )
        .gte("metric_date", range.start)
        .lte("metric_date", range.end);
      return (data ?? []) as Metric[];
    },
  });

  // Vans — same source Fleet Manager renders, so the dispatch board can
  // group the funnel action by van in the same visual language.
  const { data: vans = [] } = useQuery({
    queryKey: ["dispatch-vans"],
    queryFn: async () => {
      const { data } = await supabase
        .from("teams")
        .select("id, name, color, captain_id, office_location");
      return (data ?? []) as Van[];
    },
  });

  // Suspension window: the last 14 completed worked days (Sundays excluded).
  // Feeds the donut check (first two days) and the zero-streak display.
  const workedDays = useMemo(() => lastWorkedDaysBefore(today, 14), [today]);
  const { data: windowMetrics = [] } = useQuery({
    queryKey: ["suspension-window", today],
    queryFn: async () => {
      const { data } = await supabase
        .from("daily_metrics")
        .select("canvasser_id, metric_date, leads_generated")
        .in("metric_date", workedDays);
      return (data ?? []) as Array<Pick<Metric, "canvasser_id" | "metric_date" | "leads_generated">>;
    },
  });

  // Realtime — instant updates when Monday webhook upserts.
  useEffect(() => {
    const channel = supabase
      .channel("dispatch-daily-metrics")
      .on(
        "postgres_changes",
        { event: "*", schema: "public", table: "daily_metrics" },
        () => {
          qc.invalidateQueries({ queryKey: ["daily-metrics"] });
        },
      )
      .subscribe();
    return () => { supabase.removeChannel(channel); };
  }, [qc]);

  // Sum all metric rows per canvasser_id across the selected range.
  const metricByCanvasser = useMemo(() => {
    const acc = new Map<string, { gen: number; conf: number; na: number; kil: number; fut: number }>();
    for (const m of metrics) {
      const prev = acc.get(m.canvasser_id) ?? { gen: 0, conf: 0, na: 0, kil: 0, fut: 0 };
      prev.gen += m.leads_generated ?? 0;
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

  const visible = useMemo(
    () => canvassers.filter((c) => matches(c.office_location ?? c.team_office)),
    [canvassers, matches],
  );

  // De-duplicate by normalized display_name. If any duplicate is a captain,
  // the merged row inherits the captain role. Metrics from every duplicate
  // canvasser_id aggregate into a single row.
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
      let gen = 0, conf = 0, na = 0, kil = 0, fut = 0;
      for (const id of g.ids) {
        const m = metricByCanvasser.get(id);
        if (!m) continue;
        gen += m.gen; conf += m.conf; na += m.na; kil += m.kil; fut += m.fut;
      }
      // Submitted = leads GENERATED (new items on the Incoming Leads board),
      // not outcome counts — production shows the moment a lead is entered.
      const sub = gen;
      // Unconfirmed is the WAITING POOL, not a status flip: submitted leads
      // the confirmation team hasn't actioned yet into Confirmed / Future /
      // Blowout / N-A (owner, 2026-07-28). Floored — resolving cards born on
      // earlier days can push resolutions past today's submissions.
      const pen = Math.max(0, sub - conf - fut - kil - na);
      return { g, conf, pen, kil, fut, sub };
    });
    return enriched.sort((a, b) => {
      if (b.sub !== a.sub) return b.sub - a.sub;
      if (b.conf !== a.conf) return b.conf - a.conf;
      return (a.g.display_name ?? "").localeCompare(b.g.display_name ?? "");
    });
  }, [visible, metricByCanvasser]);

  const totals = useMemo(() => {
    let sub = 0, pen = 0, conf = 0, fut = 0, kil = 0;
    rows.forEach((r) => { sub += r.sub; pen += r.pen; conf += r.conf; fut += r.fut; kil += r.kil; });
    return { sub, pen, conf, fut, kil };
  }, [rows]);

  // Suspension rule (owner, 2026-07-28): any TWO consecutive WORKED days
  // (Mon–Sat; Sundays never count) with zero leads generated = donut. Only
  // completed days count — today-in-progress never flags anyone, so the list
  // is stable all day and rolls at 7 PM with the report date. Excluded:
  // profiles with suspension_tracked=false (pseudo-agents, staff) and reps
  // whose profile didn't exist for both days yet.
  const suspensionRows = useMemo(() => {
    if (preset !== "today" || workedDays.length < 2) return [];
    const genOn = (ids: string[], day: string) =>
      ids.reduce((a, id) => a + (genByDay.get(id)?.get(day) ?? 0), 0);
    const [d1, d2] = workedDays;
    return rows.flatMap((r) => {
      if (!r.g.tracked || dismissed.has(r.g.key)) return [];
      if (r.g.oldestCreated > d2) return [];
      if (genOn(r.g.ids, d1) !== 0 || genOn(r.g.ids, d2) !== 0) return [];
      // Consecutive zero worked days, newest backward, only days the profile existed.
      let streak = 0;
      let capped = true;
      for (const day of workedDays) {
        if (day < r.g.oldestCreated) { capped = false; break; }
        if (genOn(r.g.ids, day) === 0) streak++;
        else { capped = false; break; }
      }
      return [{ g: r.g, d1, d2, streak, streakLabel: `${streak}${capped ? "+" : ""}` }];
    });
  }, [rows, genByDay, workedDays, preset, dismissed]);

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="flex items-center gap-2">
          <Radio className="w-4 h-4 text-victory animate-pulse" />
          <div>
            <div className="text-[10px] font-display uppercase tracking-widest text-muted-foreground flex items-center gap-2">
              Live Dispatch · {range.label}
              {locked && preset === "today" && (
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

      {/* Fast-switch date presets */}
      <div className="flex items-center gap-1.5 overflow-x-auto scrollbar-hide">
        {([
          { id: "today", label: "Today" },
          { id: "yesterday", label: "Yesterday" },
          { id: "week", label: "This Week" },
        ] as Array<{ id: Preset; label: string }>).map((p) => {
          const active = preset === p.id;
          return (
            <button
              key={p.id}
              type="button"
              onClick={() => setPreset(p.id)}
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
        <span className="ml-2 text-[10px] text-muted-foreground font-mono whitespace-nowrap">
          {range.start === range.end ? range.start : `${range.start} → ${range.end}`}
        </span>
      </div>

      {!readOnly && <WebhookUrlBanner />}
      {!readOnly && <MondayTokenCard />}

      <div className="grid grid-cols-2 md:grid-cols-3 lg:grid-cols-5 gap-3">
        <TotalTile label="Submitted" value={totals.sub} accent="neon" />
        <TotalTile label="Unconfirmed" value={totals.pen} accent="warning" />
        <TotalTile label="Confirmed" value={totals.conf} accent="victory" />
        <TotalTile label="Future" value={totals.fut} accent="accent" />
        <TotalTile label="Blowout" value={totals.kil} accent="danger" />
      </div>

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
                      setDismissed((prev) => { const n = new Set(prev); n.delete(g.key); return n; });
                      toast.error(`Could not remove ${name}: ${error.message}`);
                      return;
                    }
                    qc.invalidateQueries({ queryKey: ["dispatch-canvassers"] });
                    toast.success(`${name} removed from the suspension list`, {
                      action: {
                        label: "Undo",
                        onClick: () => {
                          supabase
                            .from("profiles")
                            .update({ suspension_tracked: true })
                            .in("id", g.ids)
                            .then(() => {
                              setDismissed((prev) => { const n = new Set(prev); n.delete(g.key); return n; });
                              qc.invalidateQueries({ queryKey: ["dispatch-canvassers"] });
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
    </div>
  );
}

type Van = {
  id: string;
  name: string;
  color: string | null;
  captain_id: string | null;
  office_location: string | null;
};

type FunnelRow = {
  g: {
    key: string;
    ids: string[];
    display_name: string | null;
    role: "canvasser" | "captain";
    team_id: string | null;
  };
  sub: number;
  pen: number;
  conf: number;
  fut: number;
  kil: number;
};

const FUNNEL_COLS: Array<{ short: string; full: string; key: "sub" | "pen" | "conf" | "fut" | "kil"; color: keyof typeof metricColorClass }> = [
  { short: "Sub", full: "Submitted", key: "sub", color: "neon" },
  { short: "Unc", full: "Unconfirmed", key: "pen", color: "warning" },
  { short: "Con", full: "Confirmed", key: "conf", color: "victory" },
  { short: "Fut", full: "Future", key: "fut", color: "accent" },
  { short: "BO", full: "Blowout", key: "kil", color: "destructive" },
];

/** One rep's funnel line — Fleet Manager roster-row styling. */
function DispatchRow({ r }: { r: FunnelRow }) {
  return (
    <div className="grid grid-cols-[minmax(0,1fr)_repeat(5,2.4rem)] items-center gap-1 px-2 py-1.5 rounded border border-border bg-surface hover:border-neon/60">
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
        <span key={c.key} title={c.full} className={`text-right font-display text-sm ${metricClass(r[c.key], c.color)}`}>
          {r[c.key]}
        </span>
      ))}
    </div>
  );
}

/** Funnel mini-table column headers, aligned to DispatchRow's grid. */
function DispatchColHeader() {
  return (
    <div className="grid grid-cols-[minmax(0,1fr)_repeat(5,2.4rem)] items-center gap-1 px-2">
      <span />
      {FUNNEL_COLS.map((c) => (
        <span key={c.key} title={c.full} className="text-right text-[9px] font-display uppercase tracking-widest text-muted-foreground">
          {c.short}
        </span>
      ))}
    </div>
  );
}

/** The dispatch roster in Fleet Manager's language: office panels → van
 *  cards → per-rep funnel rows, plus the Free Agents pen for the vanless.
 *  Same live data as always — only the grouping is Fleet-style. */
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
  const looseActive = freeAgents.filter((r) => r.sub + r.pen + r.conf + r.fut + r.kil > 0);
  const vanTotals = (id: string) =>
    (rowsByVan.get(id) ?? []).reduce(
      (a, r) => ({ sub: a.sub + r.sub, pen: a.pen + r.pen, conf: a.conf + r.conf, fut: a.fut + r.fut, kil: a.kil + r.kil }),
      { sub: 0, pen: 0, conf: 0, fut: 0, kil: 0 },
    );
  const vanSub = (id: string) => vanTotals(id).sub;
  const captainName = (v: Van) =>
    v.captain_id ? rows.find((r) => r.g.ids.includes(v.captain_id!))?.g.display_name ?? null : null;

  const offices = ["San Diego", "Orange County"].filter((o) => matches(o));

  return (
    <div className="space-y-4">
      {offices.map((office) => {
        const list = vans
          .filter((v) => (v.office_location ?? "San Diego") === office)
          .sort((a, b) => vanSub(b.id) - vanSub(a.id) || a.name.localeCompare(b.name));
        if (list.length === 0) return null;
        return (
          <ArcadePanel key={office} title={`${office} · ${list.length} ${list.length === 1 ? "Van" : "Vans"}`}>
            <div className="grid gap-4 md:grid-cols-2">
              {list.map((v) => {
                const roster = (rowsByVan.get(v.id) ?? []).sort((a, b) => b.sub - a.sub || b.conf - a.conf);
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
                        {cap && (
                          <span className="hidden sm:inline text-[10px] text-muted-foreground truncate min-w-0">· {cap}</span>
                        )}
                      </div>
                    </div>
                    {roster.length === 0 ? (
                      <div className="text-xs text-muted-foreground italic px-2 py-3 border border-dashed border-border rounded">
                        No active agents on this van.
                      </div>
                    ) : (
                      <div className="space-y-1.5">
                        <DispatchColHeader />
                        {/* The whole van at a glance — every funnel stat the
                            canvassers below sum into. */}
                        <div className="grid grid-cols-[minmax(0,1fr)_repeat(5,2.4rem)] items-center gap-1 px-2 py-1.5 rounded border border-neon/40 bg-neon/5">
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
                        </div>
                        {roster.map((r) => (
                          <DispatchRow key={r.g.key} r={r} />
                        ))}
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
          <div className="space-y-1.5">
            <DispatchColHeader />
            {looseActive
              .sort((a, b) => b.sub - a.sub || (a.g.display_name ?? "").localeCompare(b.g.display_name ?? ""))
              .map((r) => (
                <DispatchRow key={r.g.key} r={r} />
              ))}
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
  rows: Array<{ g: { key: string; ids: string[]; display_name: string | null }; d1: string; d2: string; streakLabel: string }>;
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
        2 consecutive worked days without a lead · Sundays excluded · completed days only
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
  const supabaseUrl =
    (import.meta.env.VITE_SUPABASE_URL as string | undefined) ?? "";
  const anonKey =
    (import.meta.env.VITE_SUPABASE_PUBLISHABLE_KEY as string | undefined) ?? "";
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
        Paste this raw backend URL into Monday.com. It returns naked JSON for the
        challenge handshake. Send POST with{" "}
        <code className="text-foreground">{`{ canvasser_name, status }`}</code> and the
        header <code className="text-foreground">x-monday-secret</code>.
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
        Required for the webhook to look up the canvasser name from Monday when
        only <code className="text-foreground">pulseId</code> is sent. Stored
        securely (owners only).
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
      {error && (
        <div className="mt-2 text-[11px] text-destructive font-mono">{error}</div>
      )}
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
  const qc = useQueryClient();
  const [open, setOpen] = useState(false);
  const { data: logs = [], refetch, isFetching } = useQuery({
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

  // Realtime — new webhook_logs rows pop in instantly.
  useEffect(() => {
    if (!open) return;
    const channel = supabase
      .channel("webhook-logs-live")
      .on(
        "postgres_changes",
        { event: "INSERT", schema: "public", table: "webhook_logs" },
        () => qc.invalidateQueries({ queryKey: ["webhook-logs"] }),
      )
      .subscribe();
    return () => {
      supabase.removeChannel(channel);
    };
  }, [open, qc]);

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

