// FINAL ROUND — the end-of-year canvasser tournament (engagement audit
// 2026-11-03, Tier 3). Kombat's psychology on the Tier 2 ledger: a belt
// ladder with CASH prizes (owner spiffs — never payroll), weekly fight
// ROUNDs, a days-left bell, FINISH HIM inside 25 pts of the next belt, and
// a straight-line pace line ("on pace for RED"). Standings re-weight the
// ledger in code (finalePoints) so sits and confirmed leads dominate —
// every belt chase feeds the $100K Boss money. Config lives in
// arcade_rules.finale (ArcadeRulesAdmin edits it live); this tab only
// renders once the owner sets the window, so it ships dormant.

import { useEffect, useMemo } from "react";
import { useQuery } from "@tanstack/react-query";
import { supabase } from "@/integrations/supabase/client";
import { ArcadePanel, ArcadeSkeleton, metricText } from "@/components/arcade";
import { RepAvatar } from "@/components/RepAvatar";
import { useRepCartoons, cartoonFor } from "@/hooks/useRepCartoons";
import { useArcadeScore } from "@/hooks/useArcadeScore";
import { usePrefersReducedMotion } from "@/hooks/usePrefersReducedMotion";
import { playArcadeSound, haptic } from "@/lib/arcade-fx";
import { rewardToast } from "@/lib/reward-toast";
import { isNonPersonName } from "@/lib/lead-sources";
import { laTodayISO } from "@/lib/dates";
import { BELT_ACCENT } from "@/lib/kombat-month";
import {
  finaleFinishHim,
  finaleNextTier,
  finalePace,
  finalePoints,
  finaleTierFor,
  totalsFromLedger,
  type ArcadeLedgerRow,
  type ArcadeRules,
} from "@/lib/canvasser-arcade";

const BELT_SEEN_KEY = "ti_finale_belt_seen:v1";

/** Belt accent — reuse Kombat's metals where keys overlap, else the finale's
 *  own colors (white/blue/red/black default ladder). */
function beltColor(key: string): string {
  const own: Record<string, string> = {
    white: "var(--foreground)",
    blue: "var(--turf-cyan)",
    red: "var(--kombat-red)",
    black: "var(--kombat-gold)", // black belt reads gold-on-black, not invisible
  };
  return own[key] ?? BELT_ACCENT[key] ?? "var(--kombat-gold)";
}

/** Every finale-window ledger row (paged — a month of team scoring can pass
 *  1000 rows). Day-indexed so the query stays on the (canvasser, day) index. */
function useFinaleLedger(start: string | null, end: string | null) {
  return useQuery({
    queryKey: ["finale_ledger", start, end],
    enabled: !!start && !!end,
    refetchInterval: 60_000,
    queryFn: async () => {
      const PAGE = 1000;
      const rows: ArcadeLedgerRow[] = [];
      for (let from = 0; ; from += PAGE) {
        const { data, error } = await supabase
          .from("canvasser_arcade_ledger")
          .select("canvasser_id, day, category, points")
          .gte("day", start!)
          .lte("day", end!)
          .range(from, from + PAGE - 1);
        if (error) throw error;
        rows.push(...((data ?? []) as ArcadeLedgerRow[]));
        if (!data || data.length < PAGE) break;
      }
      return rows;
    },
  });
}

export function FinalRound({ selfId }: { selfId: string | undefined }) {
  const today = laTodayISO();
  const score = useArcadeScore(selfId);
  const rules = score.rules;
  const f = rules.finale;
  const cartoons = useRepCartoons().data;
  const reduced = usePrefersReducedMotion();

  const ledger = useFinaleLedger(f.start, f.end);

  // Names for everyone on the board (bounded: one .in() over the scorers).
  const ids = useMemo(
    () => [...new Set((ledger.data ?? []).map((r) => r.canvasser_id))],
    [ledger.data],
  );
  const namesQ = useQuery({
    queryKey: ["finale_names", ids.length, ids[0] ?? ""],
    enabled: ids.length > 0,
    staleTime: 5 * 60_000,
    queryFn: async () => {
      const { data, error } = await supabase
        .from("profiles")
        .select("id, display_name")
        .in("id", ids);
      if (error) throw error;
      const m = new Map<string, string>();
      for (const p of data ?? []) m.set(p.id, p.display_name ?? "Unknown");
      return m;
    },
  });

  const standings = useMemo(() => {
    const totals = totalsFromLedger(ledger.data ?? []);
    const rows = [...totals.byCategory.entries()]
      .map(([id, byCat]) => ({
        id,
        pts: finalePoints(byCat, rules),
        name: namesQ.data?.get(id) ?? "Unknown",
      }))
      .filter((r) => !isNonPersonName(r.name))
      .sort((a, b) => b.pts - a.pts);
    return rows;
  }, [ledger.data, namesQ.data, rules]);

  const me = standings.find((r) => r.id === selfId);
  const myPts = me?.pts ?? 0;
  const myBelt = finaleTierFor(myPts, rules);
  const fh = finaleFinishHim(myPts, rules);
  const nxt = finaleNextTier(myPts, rules);
  const pace = finalePace(myPts, rules, today);

  // Belt-up ceremony: first render on a new belt → fanfare + gold rain.
  // First visit records the baseline silently (same discipline as the
  // lifetime level-up), so nobody gets a stale celebration mid-December.
  useEffect(() => {
    if (!selfId || !f.start || !f.end || today < f.start) return;
    const beltRank = rules.finale.tiers
      .slice()
      .sort((a, b) => a.points - b.points)
      .findIndex((t) => t.key === myBelt?.key);
    try {
      const seen = JSON.parse(window.localStorage.getItem(BELT_SEEN_KEY) ?? "{}") as Record<
        string,
        number
      >;
      const prev = seen[selfId];
      if (prev === undefined) {
        seen[selfId] = beltRank;
        window.localStorage.setItem(BELT_SEEN_KEY, JSON.stringify(seen));
        return;
      }
      if (beltRank > prev && myBelt) {
        seen[selfId] = beltRank;
        window.localStorage.setItem(BELT_SEEN_KEY, JSON.stringify(seen));
        playArcadeSound("levelup");
        haptic([40, 60, 40, 60, 90]);
        rewardToast(`🥋 ${myBelt.label.toUpperCase()} EARNED — $${myBelt.cash} locked`, {
          description: "FINAL ROUND belt secured. Next belt's cash is on the board.",
          duration: 8000,
        });
        if (!reduced) {
          import("canvas-confetti")
            .then((m) =>
              m.default({
                particleCount: 160,
                spread: 95,
                startVelocity: 45,
                origin: { y: 0.4 },
                colors: [beltColor(myBelt.key), "#f5c518", "#ffffff"],
              }),
            )
            .catch(() => {});
        }
      }
    } catch {
      /* private mode — celebration is a garnish */
    }
  }, [selfId, myBelt, rules, f.start, f.end, today, reduced]);

  // Not configured / flag off → the tab shouldn't even be offered (parent
  // gates), but render a quiet teaser as a belt-and-suspenders fallback.
  if (!f.start || !f.end || !score.enabled) {
    return (
      <ArcadePanel title={f.label}>
        <p className="px-1 py-3 text-center font-display text-[10px] uppercase tracking-widest text-muted-foreground">
          The bell hasn't rung yet — watch this space.
        </p>
      </ArcadePanel>
    );
  }

  const preStart = today < f.start;
  const over = today > f.end;
  const tiers = [...rules.finale.tiers].sort((a, b) => b.points - a.points);
  const loading = ledger.isLoading || score.loading;

  return (
    <div className="space-y-4">
      {/* Hero — the bell. Urgency is THE finale lever: days left, round. */}
      <ArcadePanel title={f.label}>
        <div className="flex flex-col gap-2 px-1 pb-1">
          <div className="flex flex-wrap items-center justify-between gap-2 font-display text-[10px] uppercase tracking-widest">
            {preStart ? (
              <span className="text-[var(--kombat-gold)]">🔔 Bell rings {f.start}</span>
            ) : over ? (
              <span className="text-muted-foreground">🏁 Belts locked — final standings</span>
            ) : (
              <>
                <span className="text-[var(--kombat-red)]">
                  ROUND {pace?.round?.roundNumber ?? 1}/{pace?.round?.totalRounds ?? 1}
                </span>
                <span
                  className={
                    (pace?.daysLeft ?? 0) <= 7
                      ? "animate-pulse text-[var(--kombat-red)]"
                      : "text-[var(--kombat-gold)]"
                  }
                >
                  ⏱ {pace?.daysLeft ?? 0} days left
                </span>
              </>
            )}
          </div>
          {/* Self meter — belt, progress to the next one, FINISH HIM. */}
          {!preStart && selfId && (
            <div className="rounded-lg border border-border bg-surface p-3">
              <div className="flex items-center justify-between gap-2 font-display text-[10px] uppercase tracking-widest">
                <span style={{ color: myBelt ? beltColor(myBelt.key) : undefined }}>
                  {myBelt ? `🥋 ${myBelt.label}` : "No belt yet"}
                </span>
                <span className={metricText(myPts, "text-neon")}>
                  {Math.round(myPts)} pts
                </span>
              </div>
              {nxt && !over && (
                <>
                  <div className="mt-2 h-2 overflow-hidden rounded-sm bg-border/70" aria-hidden>
                    <span
                      className="block h-full rounded-sm"
                      style={{
                        width: `${Math.min(100, Math.round((myPts / nxt.next.points) * 100))}%`,
                        background: beltColor(nxt.next.key),
                      }}
                    />
                  </div>
                  <div
                    className={`mt-2 rounded-md px-2 py-1.5 text-center font-display text-[10px] uppercase tracking-widest ${
                      fh ? "kombat-finish-him text-white" : "text-muted-foreground"
                    }`}
                  >
                    {fh
                      ? `FINISH HIM — ${Math.ceil(fh.toGo)} pts to ${fh.next.label} ($${fh.next.cash})`
                      : `${Math.ceil(nxt.toGo)} pts to ${nxt.next.label} — $${nxt.next.cash} cash`}
                  </div>
                  {pace && pace.perDayToNext > 0 && (
                    <p className="mt-1 text-center font-display text-[9px] uppercase tracking-widest text-muted-foreground">
                      {pace.projectedTier
                        ? `On pace for ${pace.projectedTier.label} · `
                        : ""}
                      {Math.ceil(pace.perDayToNext)} pts/day takes {nxt.next.label}
                    </p>
                  )}
                </>
              )}
            </div>
          )}
        </div>
      </ArcadePanel>

      {/* Prize ladder — the cash makes the climb concrete. */}
      <ArcadePanel title="Prize ladder">
        <div className="grid grid-cols-2 gap-2 px-1 pb-1 md:grid-cols-4">
          {tiers.map((t) => {
            const held = !!myBelt && myPts >= t.points;
            return (
              <div
                key={t.key}
                className={`rounded-lg border p-2 text-center ${
                  held ? "border-[var(--kombat-gold)]/60" : "border-border"
                }`}
              >
                <div
                  className="font-display text-[10px] uppercase tracking-widest"
                  style={{ color: beltColor(t.key) }}
                >
                  {held ? "✓ " : ""}
                  {t.label}
                </div>
                <div className="mt-1 font-display text-base text-[var(--kombat-gold)]">
                  ${t.cash}
                </div>
                <div className="font-display text-[9px] uppercase tracking-widest text-muted-foreground">
                  {t.points} pts
                </div>
              </div>
            );
          })}
        </div>
        <p className="px-1 pb-1 text-center font-display text-[8px] uppercase tracking-widest text-muted-foreground/70">
          Cash spiffs on top of pay — sits & confirmed leads score heaviest. And every sit
          still drains the $100K Boss: $1,500 per $100K, the real endgame.
        </p>
      </ArcadePanel>

      {/* Standings — who holds what. */}
      <ArcadePanel title={over ? "Final standings" : "Standings"}>
        {loading ? (
          <ArcadeSkeleton className="h-28" />
        ) : standings.length === 0 ? (
          <p className="px-1 py-3 text-center font-display text-[10px] uppercase tracking-widest text-muted-foreground">
            {preStart ? "Qualifying — the board fills when the bell rings." : "No points yet — first blood takes White Belt."}
          </p>
        ) : (
          <ol className="space-y-1 px-1 pb-1">
            {standings.map((r, i) => {
              const belt = finaleTierFor(r.pts, rules);
              const self = r.id === selfId;
              return (
                <li
                  key={r.id}
                  className={`flex min-h-11 items-center gap-2 rounded-lg border px-2 py-1 md:min-h-0 ${
                    self ? "border-[var(--neon)]/60 bg-[color-mix(in_oklab,var(--neon)_8%,transparent)]" : "border-border/60"
                  }`}
                >
                  <span className="w-6 shrink-0 text-right font-display text-[10px] text-muted-foreground">
                    {i + 1}
                  </span>
                  <RepAvatar
                    name={r.name}
                    cartoon={cartoonFor(cartoons, r.name)}
                    className="h-8 w-8 shrink-0"
                  />
                  <span className="min-w-0 flex-1 truncate font-display text-[10px] uppercase tracking-wider">
                    {r.name.split(" ")[0]}
                  </span>
                  {belt && (
                    <span
                      className="shrink-0 font-display text-[9px] uppercase tracking-widest"
                      style={{ color: beltColor(belt.key) }}
                    >
                      🥋 {belt.label.replace(" Belt", "")}
                    </span>
                  )}
                  <span className="w-14 shrink-0 text-right font-display text-[10px] tabular-nums text-neon">
                    {Math.round(r.pts)}
                  </span>
                </li>
              );
            })}
          </ol>
        )}
      </ArcadePanel>
    </div>
  );
}

/** Whether the FINAL ROUND tab should show at all: flag on + window set +
 *  not long past (keep final standings up a week after the bell). */
export function finaleTabVisible(
  enabled: boolean,
  rules: ArcadeRules,
  todayISO: string = laTodayISO(),
): boolean {
  const f = rules.finale;
  if (!enabled || !f.start || !f.end) return false;
  const weekAfter = new Date(`${f.end}T12:00:00Z`);
  weekAfter.setUTCDate(weekAfter.getUTCDate() + 7);
  return todayISO <= weekAfter.toISOString().slice(0, 10);
}
