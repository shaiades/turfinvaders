import { useMemo, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { supabase } from "@/integrations/supabase/client";
import { getDispatchProduction } from "@/lib/dispatch.functions";
import {
  addDaysISO,
  laMidnightUtcISO,
  laMonthStartISO,
  laTodayISO,
  laWeekStartISO,
} from "@/lib/dates";
import { useAuth } from "@/hooks/useAuth";
import { useRealtimeInvalidate } from "@/hooks/useRealtimeInvalidate";
import { isLeadSourceName } from "@/lib/lead-sources";
import { ArcadeCard, ArcadePanel } from "@/components/arcade";

/**
 * The canvasser-facing Leaders page (audit P1-4, owner: full rebuild): a
 * flat RANKED LADDER — #1 at the top, your row glowing, gap-to-next named —
 * instead of the ops dispatch table (which leadership keeps). One line per
 * rep, no horizontal scroll, sorted by what pays: points, then volume,
 * then leads. Numbers ride getDispatchProduction — the same server
 * aggregates Fleet Dispatch shows, so the two boards can never disagree.
 */

type RangeKey = "day" | "week" | "month";

const fmtVol = (n: number) =>
  n >= 10_000 ? `$${Math.round(n / 1000)}K` : `$${Math.round(n).toLocaleString()}`;

function rangeFor(key: RangeKey): { start: string; end: string } {
  const today = laTodayISO();
  if (key === "day") return { start: today, end: today };
  if (key === "week") {
    const w = laWeekStartISO();
    return { start: w, end: addDaysISO(w, 5) };
  }
  return { start: laMonthStartISO(), end: today };
}

type LadderRow = {
  id: string;
  name: string;
  teamName: string | null;
  teamColor: string | null;
  pts: number;
  vol: number;
  lds: number;
  sal: number;
  drs: number;
  tlk: number;
};

export function CanvasserLeaderboard() {
  const { user } = useAuth();
  const selfId = user?.id;
  const [range, setRange] = useState<RangeKey>("day");
  const { start, end } = rangeFor(range);

  const prodQ = useQuery({
    queryKey: ["canvasser_ladder", "prod", start, end],
    queryFn: async () =>
      getDispatchProduction({
        data: {
          log_start: start,
          log_end: end,
          vol_start: laMidnightUtcISO(start),
          vol_end: laMidnightUtcISO(addDaysISO(end, 1)),
        },
      }),
  });

  const rosterQ = useQuery({
    queryKey: ["canvasser_ladder", "roster"],
    staleTime: 5 * 60_000,
    queryFn: async () => {
      const [profilesR, teamsR] = await Promise.all([
        supabase.from("profiles").select("id, display_name, team_id"),
        supabase.from("teams").select("id, name, color"),
      ]);
      if (profilesR.error) throw profilesR.error;
      if (teamsR.error) throw teamsR.error;
      return { profiles: profilesR.data ?? [], teams: teamsR.data ?? [] };
    },
  });

  useRealtimeInvalidate({
    channel: "canvasser-ladder",
    tables: ["daily_logs", "leads"],
    invalidateKeys: [["canvasser_ladder", "prod"]],
    enabled: !!selfId,
  });

  const { rows, vans } = useMemo(() => {
    const prod = prodQ.data;
    const roster = rosterQ.data;
    if (!prod || !roster) return { rows: [] as LadderRow[], vans: [] as VanRow[] };
    const teamById = new Map(roster.teams.map((t) => [t.id, t]));
    const profById = new Map(roster.profiles.map((p) => [p.id, p]));

    const ids = new Set<string>([
      ...Object.keys(prod.points ?? {}),
      ...Object.keys(prod.volume ?? {}),
      ...Object.keys(prod.results ?? {}),
    ]);
    const rows: LadderRow[] = [];
    for (const id of ids) {
      const r = prod.results?.[id];
      const pts = prod.points?.[id] ?? 0;
      const vol = prod.volume?.[id] ?? 0;
      const lds = r?.lds ?? 0;
      if (pts === 0 && vol === 0 && lds === 0 && (r?.drs ?? 0) === 0) continue;
      const prof = profById.get(id);
      // Pseudo lead-source channels (Job Walk, Upsell, …) are the OFFICE's
      // credit, never canvassers (owner rule, PR #133/#172) — they race on
      // the dispatch Lead Sources section, not on the reps' ladder.
      if (isLeadSourceName(prof?.display_name)) continue;
      // Van-at-the-time beats live team_id (removed reps keep their history).
      const teamId = prod.snapshotTeam?.[id] ?? prof?.team_id ?? null;
      const team = teamId ? teamById.get(teamId) : null;
      rows.push({
        id,
        name: prof?.display_name ?? "Unknown",
        teamName: team?.name ?? null,
        teamColor: team?.color ?? null,
        pts,
        vol,
        lds,
        sal: r?.sal ?? 0,
        drs: r?.drs ?? 0,
        tlk: r?.tlk ?? 0,
      });
    }
    rows.sort((a, b) => b.pts - a.pts || b.vol - a.vol || b.lds - a.lds || b.drs - a.drs);

    const vanMap = new Map<string, VanRow>();
    for (const r of rows) {
      const key = r.teamName ?? "Unassigned";
      const v = vanMap.get(key) ?? {
        name: key,
        color: r.teamColor ?? "#8a8f99",
        pts: 0,
        vol: 0,
        lds: 0,
      };
      v.pts += r.pts;
      v.vol += r.vol;
      v.lds += r.lds;
      vanMap.set(key, v);
    }
    const vans = [...vanMap.values()].sort((a, b) => b.pts - a.pts || b.vol - a.vol);
    return { rows, vans };
  }, [prodQ.data, rosterQ.data]);

  const selfIdx = rows.findIndex((r) => r.id === selfId);
  const gap =
    selfIdx > 0
      ? {
          ahead: rows[selfIdx - 1],
          pts: rows[selfIdx - 1].pts - rows[selfIdx].pts,
          vol: rows[selfIdx - 1].vol - rows[selfIdx].vol,
        }
      : null;

  const loading = prodQ.isLoading || rosterQ.isLoading;

  return (
    <div className="space-y-4">
      {/* Range chips */}
      <div className="inline-flex rounded-lg border border-border bg-surface p-1">
        {(["day", "week", "month"] as const).map((k) => (
          <button
            key={k}
            type="button"
            onClick={() => setRange(k)}
            className={`px-4 py-1.5 rounded-md font-display text-[10px] uppercase tracking-widest transition ${
              range === k
                ? "bg-[color-mix(in_oklab,var(--neon)_15%,transparent)] text-neon shadow-[0_0_18px_-4px_var(--neon)]"
                : "text-muted-foreground hover:text-foreground"
            }`}
          >
            {k === "day" ? "Today" : k === "week" ? "This Week" : "This Month"}
          </button>
        ))}
      </div>

      {/* The ladder */}
      <ArcadeCard asChild className="p-0 overflow-hidden">
        <section>
          <header className="flex items-center justify-between border-b border-border px-4 py-3">
            <h2 className="font-display text-xs text-neon uppercase tracking-widest">
              The Ladder · Pts → $ → Leads
            </h2>
            <span className="text-[10px] font-display uppercase tracking-widest text-muted-foreground">
              {rows.length} on the board
            </span>
          </header>
          <div className="px-4 py-2">
            {loading ? (
              <p className="py-4 text-sm text-muted-foreground">Loading the board…</p>
            ) : rows.length === 0 ? (
              <p className="py-4 text-sm text-muted-foreground">
                No production in this range yet — first knock takes #1.
              </p>
            ) : (
              <ol className="divide-y divide-border/60">
                {rows.map((r, i) => {
                  const self = r.id === selfId;
                  return (
                    <li
                      key={r.id}
                      className={`py-2.5 ${self ? "bg-neon/10 -mx-2 rounded px-2" : ""}`}
                    >
                      <div className="flex items-center justify-between gap-3">
                        <div className="flex min-w-0 items-center gap-2.5">
                          <span
                            className={`w-7 shrink-0 text-right font-display text-sm tabular-nums ${
                              i === 0
                                ? "text-[var(--warning)]"
                                : i < 3
                                  ? "text-victory"
                                  : "text-muted-foreground"
                            }`}
                          >
                            {i + 1}
                          </span>
                          {r.teamColor && (
                            <span
                              aria-hidden
                              className="h-2 w-2 shrink-0 rounded-full"
                              style={{ background: r.teamColor, boxShadow: `0 0 6px ${r.teamColor}` }}
                            />
                          )}
                          <span className={`truncate text-sm ${self ? "text-neon font-medium" : ""}`}>
                            {r.name}
                            {self && (
                              <span className="ml-1.5 font-display text-[9px] uppercase tracking-widest text-neon/80">
                                you
                              </span>
                            )}
                          </span>
                        </div>
                        <div className="flex shrink-0 items-center gap-3 font-display text-[11px] uppercase tracking-wider tabular-nums">
                          <span className="text-victory">{r.pts} pts</span>
                          <span className={r.vol > 0 ? "text-victory/90" : "text-muted-foreground/50"}>
                            {fmtVol(r.vol)}
                          </span>
                          <span className={r.lds > 0 ? "text-neon" : "text-muted-foreground/50"}>
                            {r.lds} lds
                          </span>
                        </div>
                      </div>
                      <div className="mt-0.5 pl-[3.1rem] text-[9px] font-display uppercase tracking-widest text-muted-foreground/70">
                        {r.drs} drs · {r.tlk} tlk{r.sal > 0 ? ` · ${r.sal} sold` : ""}
                        {self && gap && (
                          <span className="text-[var(--warning)]">
                            {" "}
                            · {gap.pts > 0
                              ? `${gap.pts} pt${gap.pts === 1 ? "" : "s"} behind ${gap.ahead.name.split(" ")[0]}`
                              : `${fmtVol(Math.max(0, gap.vol))} behind ${gap.ahead.name.split(" ")[0]}`}
                          </span>
                        )}
                        {self && selfIdx === 0 && (
                          <span className="text-[var(--warning)]"> · top of the board 👑</span>
                        )}
                      </div>
                    </li>
                  );
                })}
              </ol>
            )}
          </div>
        </section>
      </ArcadeCard>

      {/* The van race */}
      {vans.length > 1 && (
        <ArcadePanel title="Van Race">
          <ol className="space-y-2">
            {vans.map((v, i) => (
              <li key={v.name} className="flex items-center justify-between gap-3">
                <div className="flex min-w-0 items-center gap-2.5">
                  <span className="w-5 shrink-0 text-right font-display text-xs text-muted-foreground tabular-nums">
                    {i + 1}
                  </span>
                  <span
                    aria-hidden
                    className="h-2.5 w-2.5 shrink-0 rounded-full"
                    style={{ background: v.color, boxShadow: `0 0 8px ${v.color}` }}
                  />
                  <span className="truncate text-sm">{v.name}</span>
                </div>
                <div className="flex shrink-0 items-center gap-3 font-display text-[11px] uppercase tracking-wider tabular-nums">
                  <span className="text-victory">{v.pts} pts</span>
                  <span className="text-victory/90">{fmtVol(v.vol)}</span>
                  <span className="text-neon">{v.lds} lds</span>
                </div>
              </li>
            ))}
          </ol>
        </ArcadePanel>
      )}
    </div>
  );
}

type VanRow = { name: string; color: string; pts: number; vol: number; lds: number };
