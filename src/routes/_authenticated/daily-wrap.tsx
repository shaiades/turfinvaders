import { createFileRoute } from "@tanstack/react-router";
import { useQuery } from "@tanstack/react-query";
import { useEffect, useMemo, useRef } from "react";
import { supabase } from "@/integrations/supabase/client";
import { ArcadePanel } from "@/components/arcade";
import { AlertTriangle, Trophy } from "lucide-react";

export const Route = createFileRoute("/_authenticated/daily-wrap")({
  head: () => ({ meta: [{ title: "Daily Wrap-Up — Turf Invaders" }] }),
  component: DailyWrap,
});

const PT_TZ = "America/Los_Angeles";
const PT_PARTS = new Intl.DateTimeFormat("en-US", {
  timeZone: PT_TZ,
  year: "numeric",
  month: "2-digit",
  day: "2-digit",
  hour: "2-digit",
  hour12: false,
});

/** Parts of `now` in America/Los_Angeles. */
function ptNow() {
  const parts = Object.fromEntries(
    PT_PARTS.formatToParts(new Date()).map((p) => [p.type, p.value]),
  );
  const year = Number(parts.year);
  const month = Number(parts.month);
  const day = Number(parts.day);
  const hour = Number(parts.hour === "24" ? "0" : parts.hour);
  return { year, month, day, hour };
}
function addDaysISO(iso: string, delta: number) {
  const [y, m, d] = iso.split("-").map(Number);
  const dt = new Date(Date.UTC(y, m - 1, d));
  dt.setUTCDate(dt.getUTCDate() + delta);
  return dt.toISOString().slice(0, 10);
}
/**
 * The report-date is the PT calendar date whose 7:00 PM boundary is the "lock".
 * Before 7 PM PT → report-date = current PT date (live preview of today's totals).
 * At/after 7 PM PT → report-date rolls forward: today's totals seed the NEXT PT date.
 */
function reportDates() {
  const { year, month, day, hour } = ptNow();
  const currentPT = `${year}-${String(month).padStart(2, "0")}-${String(day).padStart(2, "0")}`;
  const today = hour >= 19 ? addDaysISO(currentPT, 1) : currentPT;
  const yday = addDaysISO(today, -1);
  // ISO week (Mon-start) of the report-date, computed in PT.
  const [ry, rm, rd] = today.split("-").map(Number);
  const anchor = new Date(Date.UTC(ry, rm - 1, rd));
  const dow = anchor.getUTCDay() === 0 ? 7 : anchor.getUTCDay();
  anchor.setUTCDate(anchor.getUTCDate() - (dow - 1));
  const wkStart = anchor.toISOString().slice(0, 10);
  return { today, yday, wkStart, beforeLock: hour < 19 };
}

type Row = {
  id: string;
  name: string;
  todayLeads: number;
  ydayLeads: number;
  weekPoints: number;
};

function DailyWrap() {
  const { today, yday, wkStart, beforeLock } = reportDates();


  const { data: rows = [], isLoading } = useQuery({
    queryKey: ["daily_wrap", today],
    queryFn: async (): Promise<Row[]> => {
      const [profilesR, metricsR] = await Promise.all([
        supabase.from("profiles").select("id, display_name, status").neq("status", "inactive"),
        supabase
          .from("daily_metrics")
          .select("canvasser_id, metric_date, leads_confirmed, leads_submitted, pitch_missed, sales")
          .gte("metric_date", wkStart),
      ]);
      const profiles = profilesR.data ?? [];
      const metrics = metricsR.data ?? [];

      const byUser = new Map<string, { today: number; yday: number; pts: number }>();
      for (const m of metrics) {
        const rec = byUser.get(m.canvasser_id) ?? { today: 0, yday: 0, pts: 0 };
        const leads = (m.leads_confirmed ?? 0) + (m.leads_submitted ?? 0);
        if (m.metric_date === today) rec.today += leads;
        if (m.metric_date === yday) rec.yday += leads;
        rec.pts += (m.pitch_missed ?? 0) * 1 + (m.sales ?? 0) * 2;
        byUser.set(m.canvasser_id, rec);
      }
      return profiles.map((p) => {
        const r = byUser.get(p.id) ?? { today: 0, yday: 0, pts: 0 };
        return {
          id: p.id,
          name: p.display_name ?? "Unknown",
          todayLeads: r.today,
          ydayLeads: r.yday,
          weekPoints: r.pts,
        };
      });
    },
  });

  const { suspension, doughnuts, winners, club3, bosses7 } = useMemo(() => {
    const suspension = rows.filter((r) => r.todayLeads === 0 && r.ydayLeads === 0);
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
      {beforeLock && (
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
              <li
                key={r.id}
                className="flex items-center gap-4 p-3 rounded-md border border-[var(--destructive)]/60 bg-background/60"
              >
                <span className="frozen-doughnut text-5xl leading-none">🍩</span>
                <div className="min-w-0">
                  <div className="font-display text-sm truncate">{r.name}</div>
                  <div className="text-[10px] font-display uppercase tracking-widest text-[var(--destructive)]">
                    0 today · 0 yesterday
                  </div>
                </div>
              </li>
            ))}
          </ul>
        )}
      </section>

      {/* Doughnut List */}
      <ArcadePanel title="Doughnuts Today · 1 Zero">
        {doughnuts.length === 0 ? (
          <p className="text-sm text-muted-foreground">No fresh doughnuts. Everyone got on the board.</p>
        ) : (
          <ul className="grid grid-cols-1 sm:grid-cols-2 gap-3">
            {doughnuts.map((r) => (
              <li key={r.id} className="flex items-center gap-4 p-3 rounded-md border border-border bg-surface">
                <span className="bouncing-doughnut text-4xl leading-none">🍩</span>
                <div className="min-w-0">
                  <div className="font-medium truncate">{r.name}</div>
                  <div className="text-[10px] font-display uppercase tracking-widest text-muted-foreground">
                    0 today · {r.ydayLeads} yesterday
                  </div>
                </div>
              </li>
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
          <div>
            <h3 className="font-display text-xs uppercase tracking-widest text-[var(--neon-blue,#00f0ff)] mb-2">
              7+ Point Bosses
            </h3>
            {bosses7.length === 0 ? (
              <p className="text-sm text-muted-foreground">No bosses yet this week.</p>
            ) : (
              <ul className="flex flex-wrap gap-2">
                {bosses7.map((r) => (
                  <li
                    key={r.id}
                    className="inline-flex items-center gap-2 px-4 py-2 rounded-full font-display text-sm"
                    style={{
                      color: "var(--victory)",
                      background: "color-mix(in oklab, var(--victory) 14%, transparent)",
                      border: "2px solid var(--victory)",
                      boxShadow: "0 0 20px color-mix(in oklab, var(--victory) 60%, transparent)",
                      textShadow: "0 0 12px color-mix(in oklab, var(--victory) 80%, transparent)",
                    }}
                  >
                    👑 {r.name} · {r.weekPoints}
                  </li>
                ))}
              </ul>
            )}
          </div>
          <div>
            <h3 className="font-display text-xs uppercase tracking-widest text-muted-foreground mb-2">
              3+ Point Club
            </h3>
            {club3.length === 0 ? (
              <p className="text-sm text-muted-foreground">No one in the club yet.</p>
            ) : (
              <ul className="flex flex-wrap gap-2">
                {club3.map((r) => (
                  <li
                    key={r.id}
                    className="inline-flex items-center gap-2 px-3 py-1.5 rounded-full font-display text-xs"
                    style={{
                      color: "var(--neon-blue, #00f0ff)",
                      background: "color-mix(in oklab, #00f0ff 12%, transparent)",
                      border: "1.5px solid #00f0ff",
                      boxShadow: "0 0 14px color-mix(in oklab, #00f0ff 55%, transparent)",
                    }}
                  >
                    ⭐ {r.name} · {r.weekPoints}
                  </li>
                ))}
              </ul>
            )}
          </div>
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
    const N = 60;
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
    <section className="relative arcade-card overflow-hidden">
      <div ref={hostRef} aria-hidden className="pointer-events-none absolute inset-0 overflow-hidden" />
      <header className="flex items-center justify-between border-b border-border px-5 py-3">
        <h2 className="font-display text-xs text-neon uppercase tracking-widest">Today's Winners 🎉</h2>
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
  );
}
