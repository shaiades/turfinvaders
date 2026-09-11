import { createFileRoute } from "@tanstack/react-router";
import { useQuery } from "@tanstack/react-query";
import { useEffect, useMemo, useRef, useState } from "react";
import { supabase } from "@/integrations/supabase/client";
import { ArcadeCard, ArcadePanel } from "@/components/arcade";
import { GlossarySheet } from "@/components/GlossarySheet";
import { AlertTriangle, Info, Trophy } from "lucide-react";
import { addDaysISO, reportDates } from "@/lib/dates";
import { getClockPresence } from "@/lib/dispatch.functions";
import { isRecentlyActive, lastActiveMap, SUSPENSION_RECENCY_DAYS } from "@/lib/suspension";

export const Route = createFileRoute("/_authenticated/daily-wrap")({
  head: () => ({ meta: [{ title: "Daily Wrap-Up — Turf Invaders" }] }),
  component: DailyWrap,
});

type Row = {
  id: string;
  name: string;
  todayLeads: number;
  ydayLeads: number;
  /** Leads on the day BEFORE yday — the second judged day of the zero lists. */
  yday2Leads: number;
  weekPoints: number;
  recent: boolean;
  tracked: boolean;
  /** false = archived/removed — off the zero lists, but earned awards stay. */
  active: boolean;
  /** First-week rookie with no credited day yet — off the zero lists. */
  graced: boolean;
};

/** One doughnut card for both zero lists — the freezer (2+ zeros, red) and
 *  the fresh doughnuts (1 zero, neutral) rendered the same markup twice.
 *  Labels name the two judged days: the lists only ever score FINISHED
 *  report days (owner, 2026-09-11: today can't count until the day is over),
 *  so pre-lock they read yesterday/day-before and post-lock today/yesterday. */
function DoughnutCard({
  r,
  frozen,
  lastLabel,
  prevLabel,
}: {
  r: Row;
  frozen?: boolean;
  lastLabel: string;
  prevLabel: string;
}) {
  return (
    <li
      className={
        frozen
          ? "flex items-center gap-4 p-3 rounded-md border border-[var(--destructive)]/60 bg-background/60"
          : "flex items-center gap-4 p-3 rounded-md border border-border bg-surface"
      }
    >
      <span className={frozen ? "frozen-doughnut text-5xl leading-none" : "bouncing-doughnut text-4xl leading-none"}>
        🍩
      </span>
      <div className="min-w-0">
        <div className={frozen ? "font-display text-sm truncate" : "font-medium truncate"}>
          {r.name}
        </div>
        <div
          className={`text-[10px] font-display uppercase tracking-widest ${
            frozen ? "text-[var(--destructive)]" : "text-muted-foreground"
          }`}
        >
          0 {lastLabel} · {frozen ? "0" : r.yday2Leads} {prevLabel}
        </div>
      </div>
    </li>
  );
}

/** The two weekly award tiers as data — same section shape, different shine.
 *  Style objects live here (not inline) so chips stop re-creating them per
 *  render; values are byte-identical to the originals. */
const AWARD_TIERS: Array<{
  key: "bosses" | "club";
  title: string;
  titleClass: string;
  empty: string;
  emoji: string;
  chipClass: string;
  chipStyle: React.CSSProperties;
}> = [
  {
    key: "bosses",
    title: "7+ Point Bosses",
    titleClass: "text-[var(--neon-blue,#00f0ff)]",
    empty: "No bosses yet this week.",
    emoji: "👑",
    chipClass: "inline-flex items-center gap-2 px-4 py-2 rounded-full font-display text-sm",
    chipStyle: {
      color: "var(--victory)",
      background: "color-mix(in oklab, var(--victory) 14%, transparent)",
      border: "2px solid var(--victory)",
      boxShadow: "0 0 20px color-mix(in oklab, var(--victory) 60%, transparent)",
      textShadow: "0 0 12px color-mix(in oklab, var(--victory) 80%, transparent)",
    },
  },
  {
    key: "club",
    title: "3+ Point Club",
    titleClass: "text-muted-foreground",
    empty: "No one in the club yet.",
    emoji: "⭐",
    chipClass: "inline-flex items-center gap-2 px-3 py-1.5 rounded-full font-display text-xs",
    chipStyle: {
      color: "var(--neon-blue, #00f0ff)",
      background: "color-mix(in oklab, #00f0ff 12%, transparent)",
      border: "1.5px solid #00f0ff",
      boxShadow: "0 0 14px color-mix(in oklab, #00f0ff 55%, transparent)",
    },
  },
];

function AwardSection({ tier, rows }: { tier: (typeof AWARD_TIERS)[number]; rows: Row[] }) {
  return (
    <div>
      <h3 className={`font-display text-xs uppercase tracking-widest mb-2 ${tier.titleClass}`}>
        {tier.title}
      </h3>
      {rows.length === 0 ? (
        <p className="text-sm text-muted-foreground">{tier.empty}</p>
      ) : (
        <ul className="flex flex-wrap gap-2">
          {rows.map((r) => (
            <li key={r.id} className={tier.chipClass} style={tier.chipStyle}>
              {tier.emoji} {r.name} · {r.weekPoints}
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

function DailyWrap() {
  const { today, yday, wkStart, locked } = reportDates();
  const [glossaryOpen, setGlossaryOpen] = useState(false);

  // Zero lists judge only FINISHED report days (owner, 2026-09-11: today
  // must not count toward suspension until the day is over). The two judged
  // days are `yday` and the day before it — pre-lock that's yesterday and
  // the day prior; after the 7 PM roll `yday` IS the just-finished day, so
  // today joins the lists exactly at the lock. Clock-in gate (owner,
  // 2026-09-11): nobody lands on a zero list for a day they never punched
  // in; both judged days are real PT calendar days, so presence is checked
  // on them directly. Presence rides the server fn because canvassers only
  // read their own time_entries. Until it loads (or if it fails — local dev
  // has no service key) the zero lists stay EMPTY: missing data must never
  // flag a person.
  const yday2 = addDaysISO(yday, -1);
  const clockDates = useMemo(() => [...new Set([yday, yday2])], [yday, yday2]);
  const clockQ = useQuery({
    queryKey: ["daily_wrap", "clock", clockDates],
    queryFn: async () => getClockPresence({ data: { dates: clockDates } }),
  });
  const clockReady = clockQ.isSuccess;
  const clockedSets = useMemo(() => {
    const m = new Map<string, Set<string>>();
    for (const [d, ids] of Object.entries(clockQ.data?.byDate ?? {})) m.set(d, new Set(ids));
    return m;
  }, [clockQ.data]);

  const { data: rows = [], isLoading } = useQuery({
    queryKey: ["daily_wrap", today],
    queryFn: async (): Promise<Row[]> => {
      // Fetch back far enough to judge 7-day recency even on a Monday/Tuesday,
      // when wkStart is only 0–1 days back.
      const cutoff = addDaysISO(today, -SUSPENSION_RECENCY_DAYS);
      const metricsStart = cutoff < wkStart ? cutoff : wkStart;
      const [profilesR, metricsR] = await Promise.all([
        supabase
          .from("profiles")
          .select("id, display_name, status, created_at, suspension_tracked, is_active")
          .neq("status", "inactive"),
        supabase
          .from("daily_metrics")
          .select("canvasser_id, metric_date, leads_confirmed, leads_submitted, pitch_missed, sales")
          .gte("metric_date", metricsStart),
      ]);
      const profiles = profilesR.data ?? [];
      const metrics = metricsR.data ?? [];

      const byUser = new Map<string, { today: number; yday: number; yday2: number; pts: number }>();
      for (const m of metrics) {
        const rec = byUser.get(m.canvasser_id) ?? { today: 0, yday: 0, yday2: 0, pts: 0 };
        const leads = (m.leads_confirmed ?? 0) + (m.leads_submitted ?? 0);
        if (m.metric_date === today) rec.today += leads;
        if (m.metric_date === yday) rec.yday += leads;
        if (m.metric_date === yday2) rec.yday2 += leads;
        // Points stay week-scoped even though the fetch may reach further back.
        if (m.metric_date >= wkStart) rec.pts += (m.pitch_missed ?? 0) * 1 + (m.sales ?? 0) * 2;
        byUser.set(m.canvasser_id, rec);
      }
      const lastMap = lastActiveMap(metrics);
      return profiles.map((p) => {
        const r = byUser.get(p.id) ?? { today: 0, yday: 0, yday2: 0, pts: 0 };
        return {
          id: p.id,
          name: p.display_name ?? "Unknown",
          todayLeads: r.today,
          ydayLeads: r.yday,
          yday2Leads: r.yday2,
          weekPoints: r.pts,
          recent: isRecentlyActive(today, [p.id], lastMap, (p.created_at ?? "").slice(0, 10)),
          tracked: p.suspension_tracked !== false,
          // Archive writes is_active, never the status enum — an archived rep
          // must leave the zero lists immediately but keep any earned awards.
          active: p.is_active !== false,
          // 1-week rookie grace (owner decision 2026-09-09) — display-side only;
          // real suspension tracking in lib/suspension.ts is untouched. The
          // metrics fetch reaches at least `cutoff` back, so lastMap covers a
          // graced rookie's whole tenure.
          graced: (p.created_at ?? "").slice(0, 10) >= cutoff && !lastMap.has(p.id),
        };
      });
    },
  });

  const { suspension, doughnuts, winners, club3, bosses7 } = useMemo(() => {
    // `recent` keeps week-gone reps out of the freezer (see src/lib/suspension.ts);
    // `tracked` honors the same X-dismissals (suspension_tracked=false) as the
    // Fleet Dispatch banner; `active` drops archived/removed reps the moment
    // the archive lands; `graced` is the 1-week rookie grace (see Row.graced).
    // All four gate only the zero lists — awards a rep earned before removal
    // stay on the wrap. Both lists judge ONLY the two finished report days
    // (yday, yday2) — an in-progress day never counts (owner, 2026-09-11);
    // it joins at the 7 PM lock, when yday becomes the just-finished day.
    // Clock-in gates likewise touch only the zero lists: a zero day counts
    // only when it was actually punched.
    const clockedOn = (id: string, day: string) => clockedSets.get(day)?.has(id) ?? false;
    const suspension = rows.filter(
      (r) =>
        r.ydayLeads === 0 &&
        r.yday2Leads === 0 &&
        r.recent &&
        r.tracked &&
        r.active &&
        !r.graced &&
        clockReady &&
        clockedOn(r.id, yday) &&
        clockedOn(r.id, yday2),
    );
    const doughnuts = rows.filter(
      (r) =>
        r.ydayLeads === 0 &&
        r.yday2Leads > 0 &&
        r.active &&
        !r.graced &&
        clockReady &&
        clockedOn(r.id, yday),
    );
    const winners = rows
      .filter((r) => r.todayLeads >= 1)
      .sort((a, b) => b.todayLeads - a.todayLeads);
    const club3 = rows.filter((r) => r.weekPoints >= 3 && r.weekPoints < 7).sort((a, b) => b.weekPoints - a.weekPoints);
    const bosses7 = rows.filter((r) => r.weekPoints >= 7).sort((a, b) => b.weekPoints - a.weekPoints);
    return { suspension, doughnuts, winners, club3, bosses7 };
  }, [rows, clockReady, clockedSets, yday, yday2]);

  if (isLoading) return <div className="text-sm text-muted-foreground">Loading daily wrap…</div>;

  // Pre-lock the judged days are yesterday/day-before; the lock rolls them.
  const lastLabel = locked ? "today" : "yesterday";
  const prevLabel = locked ? "yesterday" : "day before";

  return (
    <div className="space-y-6">
      {!locked && (
        <div
          className="rounded-md border-2 px-4 py-2 text-center font-display text-xs uppercase tracking-widest"
          style={{
            borderColor: "var(--warning)",
            color: "var(--warning)",
            background: "color-mix(in oklab, var(--warning) 10%, transparent)",
            animation: "suspend-pulse 1.8s ease-in-out infinite",
          }}
        >
          ⚡ Live Preview · Report finalizes at 7:00 PM Pacific
        </div>
      )}
      <div data-tour="wrap-header">
        <div className="flex items-center gap-1">
          <h1 className="font-display text-2xl text-neon">DAILY WRAP-UP</h1>
          <button
            onClick={() => setGlossaryOpen(true)}
            className="min-w-11 min-h-11 inline-flex items-center justify-center rounded-md hover:bg-surface-elevated text-muted-foreground hover:text-foreground"
            aria-label="What the shorthand means"
          >
            <Info className="w-5 h-5" />
          </button>
        </div>
        <p className="text-xs text-muted-foreground mt-1 font-display uppercase tracking-widest">
          End of Day Report · Locks at 7:00 PM Pacific
        </p>
        <p className="text-[10px] text-muted-foreground mt-0.5 font-display uppercase tracking-widest">
          Report date {today} (PT) · Prior {yday}
        </p>
        <p className="text-[10px] text-muted-foreground mt-0.5 font-display uppercase tracking-widest">
          Lead counts credit the day the lead was submitted · confirms recorded later update that
          day
        </p>
      </div>

      {/* Suspension Zone */}
      <section
        className="relative overflow-hidden rounded-lg border-2 p-5"
        style={{
          borderColor: "var(--destructive)",
          background: "color-mix(in oklab, var(--destructive) 12%, transparent)",
          boxShadow: "0 0 32px -8px var(--destructive)",
        }}
      >
        <header className="flex items-center gap-2 mb-4">
          <AlertTriangle className="w-5 h-5 text-[var(--destructive)]" />
          <h2 className="font-display text-sm uppercase tracking-widest text-[var(--destructive)]">
            🚨 Suspension Warning · 2+ Zeros
          </h2>
        </header>
        {suspension.length === 0 ? (
          <p className="text-sm text-muted-foreground">No one is in the freezer today. 🔥</p>
        ) : (
          <ul className="grid grid-cols-1 sm:grid-cols-2 gap-3">
            {suspension.map((r) => (
              <DoughnutCard key={r.id} r={r} frozen lastLabel={lastLabel} prevLabel={prevLabel} />
            ))}
          </ul>
        )}
        {!locked && (
          <p className="mt-3 text-[10px] font-display uppercase tracking-widest text-muted-foreground">
            Finished days only — today can't earn a zero until the 7 PM lock.
          </p>
        )}
      </section>

      {/* Doughnut List */}
      <ArcadePanel title={locked ? "Doughnuts Today · 1 Zero" : "Doughnuts · Yesterday · 1 Zero"}>
        {doughnuts.length === 0 ? (
          <p className="text-sm text-muted-foreground">
            No fresh doughnuts. Everyone got on the board.
          </p>
        ) : (
          <ul className="grid grid-cols-1 sm:grid-cols-2 gap-3">
            {doughnuts.map((r) => (
              <DoughnutCard key={r.id} r={r} lastLabel={lastLabel} prevLabel={prevLabel} />
            ))}
          </ul>
        )}
      </ArcadePanel>

      {/* Winners with confetti */}
      <WinnersPanel winners={winners} />

      {/* Weekly Point Bosses */}
      <ArcadePanel
        title="Weekly Point Bosses"
        action={
          <span className="text-[10px] font-display uppercase tracking-widest text-muted-foreground">
            <Trophy className="inline w-3 h-3 mr-1" />
            Week of {wkStart}
          </span>
        }
      >
        <div className="space-y-6">
          <AwardSection tier={AWARD_TIERS[0]} rows={bosses7} />
          <AwardSection tier={AWARD_TIERS[1]} rows={club3} />
        </div>
      </ArcadePanel>

      <GlossarySheet open={glossaryOpen} onOpenChange={setGlossaryOpen} />
    </div>
  );
}

function WinnersPanel({ winners }: { winners: Row[] }) {
  const hostRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!hostRef.current || winners.length === 0) return;
    const host = hostRef.current;
    const colors = ["#00ff88", "#00f0ff", "#ff8a00", "#ff2e88", "#ffd166"];
    // Fewer confetti nodes on phones — DOM animation cost, not aesthetics.
    const N = typeof window !== "undefined" && window.innerWidth < 640 ? 30 : 60;
    const nodes: HTMLDivElement[] = [];
    for (let i = 0; i < N; i++) {
      const el = document.createElement("div");
      el.className = "confetti-piece";
      el.style.left = `${Math.random() * 100}%`;
      el.style.background = colors[i % colors.length];
      el.style.setProperty("--dx", `${(Math.random() - 0.5) * 200}px`);
      el.style.animationDelay = `${Math.random() * 0.6}s`;
      el.style.animationDuration = `${2 + Math.random() * 1.6}s`;
      host.appendChild(el);
      nodes.push(el);
    }
    const t = setTimeout(() => nodes.forEach((n) => n.remove()), 4500);
    return () => {
      clearTimeout(t);
      nodes.forEach((n) => n.remove());
    };
  }, [winners.length]);

  return (
    <ArcadeCard asChild className="relative p-0 overflow-hidden">
      <section>
        <div
          ref={hostRef}
          aria-hidden
          className="pointer-events-none absolute inset-0 overflow-hidden"
        />
        <header className="flex items-center justify-between border-b border-border px-5 py-3">
          <h2 className="font-display text-xs text-neon uppercase tracking-widest">
            Today's Winners 🎉
          </h2>
          <span className="text-[10px] font-display uppercase tracking-widest text-muted-foreground">
            {winners.length} on the board
          </span>
        </header>
        <div className="p-5 relative">
          {winners.length === 0 ? (
            <p className="text-sm text-muted-foreground">No leads yet today.</p>
          ) : (
            <ol className="divide-y divide-border">
              {winners.map((r, i) => (
                <li key={r.id} className="flex items-center justify-between py-2.5">
                  <div className="flex items-center gap-3 min-w-0">
                    <span
                      className={`font-display text-sm w-8 ${
                        i < 3 ? "text-victory" : "text-muted-foreground"
                      }`}
                    >
                      {String(i + 1).padStart(2, "0")}
                    </span>
                    <span className="font-medium truncate">{r.name}</span>
                  </div>
                  <span className="font-display text-sm text-victory">
                    {r.todayLeads} lead{r.todayLeads === 1 ? "" : "s"}
                  </span>
                </li>
              ))}
            </ol>
          )}
        </div>
      </section>
    </ArcadeCard>
  );
}
