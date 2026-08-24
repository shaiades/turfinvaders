import { createFileRoute } from "@tanstack/react-router";
import { useQuery } from "@tanstack/react-query";
import { useEffect, useMemo, useRef } from "react";
import { supabase } from "@/integrations/supabase/client";
import { ArcadeCard, ArcadePanel } from "@/components/arcade";
import { AlertTriangle, Trophy } from "lucide-react";
import { addDaysISO, reportDates } from "@/lib/dates";
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
  weekPoints: number;
  recent: boolean;
  tracked: boolean;
};

/** One doughnut card for both zero lists — the freezer (2+ zeros, red) and
 *  the fresh doughnuts (1 zero, neutral) rendered the same markup twice. */
function DoughnutCard({ r, frozen }: { r: Row; frozen?: boolean }) {
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
          0 today · {frozen ? "0" : r.ydayLeads} yesterday
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
          .select("id, display_name, status, created_at, suspension_tracked")
          .neq("status", "inactive"),
        supabase
          .from("daily_metrics")
          .select("canvasser_id, metric_date, leads_confirmed, leads_submitted, pitch_missed, sales")
          .gte("metric_date", metricsStart),
      ]);
      const profiles = profilesR.data ?? [];
      const metrics = metricsR.data ?? [];

      const byUser = new Map<string, { today: number; yday: number; pts: number }>();
      for (const m of metrics) {
        const rec = byUser.get(m.canvasser_id) ?? { today: 0, yday: 0, pts: 0 };
        const leads = (m.leads_confirmed ?? 0) + (m.leads_submitted ?? 0);
        if (m.metric_date === today) rec.today += leads;
        if (m.metric_date === yday) rec.yday += leads;
        // Points stay week-scoped even though the fetch may reach further back.
        if (m.metric_date >= wkStart) rec.pts += (m.pitch_missed ?? 0) * 1 + (m.sales ?? 0) * 2;
        byUser.set(m.canvasser_id, rec);
      }
      const lastMap = lastActiveMap(metrics);
      return profiles.map((p) => {
        const r = byUser.get(p.id) ?? { today: 0, yday: 0, pts: 0 };
        return {
          id: p.id,
          name: p.display_name ?? "Unknown",
          todayLeads: r.today,
          ydayLeads: r.yday,
          weekPoints: r.pts,
          recent: isRecentlyActive(today, [p.id], lastMap, (p.created_at ?? "").slice(0, 10)),
          tracked: p.suspension_tracked !== false,
        };
      });
    },
  });

  const { suspension, doughnuts, winners, club3, bosses7 } = useMemo(() => {
    // `recent` keeps week-gone reps out of the freezer (see src/lib/suspension.ts);
    // `tracked` honors the same X-dismissals (suspension_tracked=false) as the
    // Fleet Dispatch banner. Both gate only this list, never the award lists.
    const suspension = rows.filter(
      (r) => r.todayLeads === 0 && r.ydayLeads === 0 && r.recent && r.tracked,
    );
    const doughnuts = rows.filter((r) => r.todayLeads === 0 && r.ydayLeads > 0);
    const winners = rows
      .filter((r) => r.todayLeads >= 1)
      .sort((a, b) => b.todayLeads - a.todayLeads);
    const club3 = rows.filter((r) => r.weekPoints >= 3 && r.weekPoints < 7).sort((a, b) => b.weekPoints - a.weekPoints);
    const bosses7 = rows.filter((r) => r.weekPoints >= 7).sort((a, b) => b.weekPoints - a.weekPoints);
    return { suspension, doughnuts, winners, club3, bosses7 };
  }, [rows]);

  if (isLoading) return <div className="text-sm text-muted-foreground">Loading daily wrap…</div>;

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
      <div>
        <h1 className="font-display text-2xl text-neon">DAILY WRAP-UP</h1>
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
              <DoughnutCard key={r.id} r={r} frozen />
            ))}
          </ul>
        )}
      </section>

      {/* Doughnut List */}
      <ArcadePanel title="Doughnuts Today · 1 Zero">
        {doughnuts.length === 0 ? (
          <p className="text-sm text-muted-foreground">
            No fresh doughnuts. Everyone got on the board.
          </p>
        ) : (
          <ul className="grid grid-cols-1 sm:grid-cols-2 gap-3">
            {doughnuts.map((r) => (
              <DoughnutCard key={r.id} r={r} />
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
