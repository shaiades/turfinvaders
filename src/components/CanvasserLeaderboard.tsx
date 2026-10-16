import { useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { useAuth } from "@/hooks/useAuth";
import { ArcadeCard, ArcadeSkeleton } from "@/components/arcade";
import { RepAvatar } from "@/components/RepAvatar";
import { useRepCartoons, cartoonFor, type RepCartoon } from "@/hooks/useRepCartoons";
import { BossMeter } from "@/components/BossMeter";
import { VanWarsRace } from "@/components/VanWarsRace";
import { usePrefersReducedMotion } from "@/hooks/usePrefersReducedMotion";
import {
  useArcadeLadder,
  rangeFor,
  type LadderRow,
  type RangeKey,
} from "@/hooks/useCanvasserArcade";
import { captureMorningRank } from "@/hooks/useWrapData";
import { haptic } from "@/lib/arcade-fx";
import { BOSS_HP } from "@/lib/canvasserPay";
import { HOURLY_BASE, HOURLY_MID, HOURLY_TOP, POINTS_TIER_MID, POINTS_TIER_TOP } from "@/lib/pay";
import { useQuery } from "@tanstack/react-query";
import { getDispatchProduction } from "@/lib/dispatch.functions";
import { addDaysISO, laMidnightUtcISO } from "@/lib/dates";

/** No fighter art on file → the leaderboard shows a grey "Photo needed"
 *  silhouette (owner 2026-10-06). A still-generating cartoon reads the same for
 *  the brief window before it lands — acceptable; the nudge is gentle. */
const noCartoonArt = (c: RepCartoon | undefined): boolean => !(c?.portrait || c?.full);

/**
 * The canvasser-facing arcade high-score hall: a top-3 PODIUM over a ranked
 * high-score table, plus Van Wars. The Month tab carries the $100K Boss meter
 * and a Points / "Bonus Race · $" toggle — the old separate Bonus tab, folded
 * into Month (2026-10-05) so the $100K boss has exactly one home. The live
 * credited sale $ and lead count ride alongside points on EVERY row and tab
 * (the old "PTS → $ → LEADS" line, restored 2026-10-07 on owner relay of
 * Ernie's ask: the van gets hyped seeing the money and leads tick when someone
 * hits); the "Bonus Race" toggle only changes what the board RANKS by. Numbers
 * ride useArcadeLadder → getDispatchProduction, the same
 * server aggregates Fleet Dispatch shows, so the boards can never disagree.
 * Privacy: the $ shown is credited sale VOLUME (net of cancels) — public, the
 * same figure Bonus Race ranks on. Detailed take-home PAY stays on the viewer's
 * own Paycheck card, never on a peer's row.
 */

type Tab = "day" | "week" | "month";

const fmtVol = (n: number) =>
  n >= 10_000 ? `$${Math.round(n / 1000)}K` : `$${Math.round(n).toLocaleString()}`;
const firstName = (name: string) => name.split(" ")[0];
const bonusCount = (vol: number) => Math.floor(Math.max(0, vol) / BOSS_HP);

// useLayoutEffect warns during SSR; fall back to useEffect on the server.
const useIsoLayoutEffect = typeof window !== "undefined" ? useLayoutEffect : useEffect;

export function CanvasserLeaderboard() {
  const { user, previewCanvasserId } = useAuth();
  // View As canvasser pick: the highlighted "you" row, BossMeter and rank
  // haptics follow the picked player — reads + local effects only.
  const selfId = previewCanvasserId ?? user?.id;
  const cartoons = useRepCartoons().data;
  const reduced = usePrefersReducedMotion();
  const [tab, setTab] = useState<Tab>("day");
  // SOLO = this podium / high-score board; VAN WARS = the weekly street race.
  const [mode, setMode] = useState<"solo" | "vanwars">("solo");
  // On the Month tab the ranking can flip between points and the $ "Bonus
  // Race" (the old Bonus tab, folded in 2026-10-05). Harmless off Month.
  const [monthMode, setMonthMode] = useState<"pts" | "bonus">("pts");
  const moneyMode = tab === "month" && monthMode === "bonus";
  // Leagues (Phase 4 §5): the main board, the Rookies (first 30 days), and
  // the Risers (this week vs their own 4-week average — its own component).
  const [league, setLeague] = useState<"main" | "rookies" | "risers">("main");
  const range: RangeKey = tab;
  const { rows: ptsRows, self, loading } = useArcadeLadder(range);

  // The $ "Bonus Race" ranks by money (the $100K race); every other view by
  // points. The Rookie league is the same ranking, rookie rows only.
  const rows = useMemo(() => {
    const pool = league === "rookies" ? ptsRows.filter((r) => r.rookie) : ptsRows;
    if (!moneyMode) return pool;
    return [...pool].sort((a, b) => b.vol - a.vol || b.pts - a.pts);
  }, [ptsRows, moneyMode, league]);

  // Pay-tier census (Phase 4 §6): how many knockers sit at each hourly tier
  // this week, from PAY-axis points (no dojo bonus). Display-only — the board
  // week is Mon–Sat while pay runs Mon–Sun, so Sunday evenings can trail the
  // paycheck by a day.
  const tierCensus = useMemo(() => {
    if (tab !== "week") return null;
    let top = 0,
      mid = 0,
      base = 0;
    for (const r of ptsRows) {
      if (r.basePts >= POINTS_TIER_TOP) top++;
      else if (r.basePts >= POINTS_TIER_MID) mid++;
      else base++;
    }
    return { top, mid, base };
  }, [tab, ptsRows]);

  // ── Live rank movement: a ▲/▼ trail when a result reshuffles the board,
  // and a coin pop when a row's credited volume ticks up. Flash clears after
  // a few seconds so the board settles.
  const prevRank = useRef(new Map<string, number>());
  const prevVol = useRef(new Map<string, number>());
  const [flash, setFlash] = useState<Record<string, "up" | "down" | "coin">>({});
  useEffect(() => {
    const next: Record<string, "up" | "down" | "coin"> = {};
    rows.forEach((r, i) => {
      const pr = prevRank.current.get(r.id);
      const pv = prevVol.current.get(r.id);
      if (pr !== undefined && pr !== i) next[r.id] = i < pr ? "up" : "down";
      if (pv !== undefined && r.vol > pv) next[r.id] = "coin";
    });
    const rm = new Map<string, number>();
    const vm = new Map<string, number>();
    rows.forEach((r, i) => {
      rm.set(r.id, i);
      vm.set(r.id, r.vol);
    });
    prevRank.current = rm;
    prevVol.current = vm;
    if (Object.keys(next).length > 0) {
      // A light buzz when YOUR row moves or banks a sale (haptics pref gated).
      if (selfId && next[selfId]) haptic(next[selfId] === "up" ? 20 : 15);
      setFlash((f) => ({ ...f, ...next }));
      const t = setTimeout(() => setFlash({}), 2600);
      return () => clearTimeout(t);
    }
  }, [rows, selfId]);

  // Remember today's rank the first time they look, so the Daily Wrap can show
  // the morning → night climb. Only the live "Today" standing counts as morning.
  useEffect(() => {
    if (tab === "day" && selfId && self) captureMorningRank(selfId, self.rank);
  }, [tab, selfId, self]);

  const podium = rows.slice(0, 3);
  const rest = rows.slice(3);

  // ── FLIP slide-reorder: when a posted result reshuffles the high-score
  // table, each row animates from where it was to where it lands, instead of
  // snapping. We measure positions relative to the list (scroll-independent),
  // invert to the old spot with no transition, then release to animate. Keyed
  // by the rendered order so flash-only re-renders don't trigger it; skipped
  // under reduced motion (the numbers still update, just no slide).
  const listRef = useRef<HTMLOListElement>(null);
  const prevTops = useRef(new Map<string, number>());
  const orderSig = rest.map((r) => r.id).join(",");
  // Switching tabs OR the Month points/$ mode swaps the whole list — snap to
  // the new order (no slide) by dropping the remembered positions before the
  // layout effect measures.
  const viewSig = `${tab}:${moneyMode}`;
  const lastView = useRef(viewSig);
  if (lastView.current !== viewSig) {
    lastView.current = viewSig;
    prevTops.current = new Map();
  }
  useIsoLayoutEffect(() => {
    const container = listRef.current;
    if (!container) return;
    const els = Array.from(container.querySelectorAll<HTMLElement>("[data-row-id]"));
    // offsetTop (relative to the positioned <ol>) is layout-based: it ignores
    // any active slide transform and page scroll, so a reshuffle that lands
    // mid-animation still measures the true positions.
    const newTops = new Map<string, number>();
    for (const el of els) newTops.set(el.dataset.rowId!, el.offsetTop);
    if (!reduced && prevTops.current.size > 0) {
      for (const el of els) {
        const id = el.dataset.rowId!;
        const prev = prevTops.current.get(id);
        const next = newTops.get(id)!;
        if (prev == null) continue; // newly on the board — just appears
        const delta = prev - next;
        if (Math.abs(delta) < 1) continue;
        el.style.transition = "none";
        el.style.transform = `translateY(${delta}px)`;
        el.style.zIndex = "1";
        requestAnimationFrame(() => {
          el.style.transition = "transform 480ms cubic-bezier(0.22,1,0.36,1)";
          el.style.transform = "";
          const clear = () => {
            el.style.zIndex = "";
            el.style.transition = "";
            el.removeEventListener("transitionend", clear);
          };
          el.addEventListener("transitionend", clear);
        });
      }
    }
    prevTops.current = newTops;
  }, [orderSig, reduced]);

  return (
    <div className="space-y-4">
      {/* SOLO | VAN WARS — the top-level switch */}
      <div className="flex gap-1.5 rounded-xl border border-border bg-surface p-1.5">
        {(["solo", "vanwars"] as const).map((m) => (
          <button
            key={m}
            type="button"
            onClick={() => setMode(m)}
            className={`min-h-11 flex-1 rounded-lg px-3 py-2 font-display text-[13px] italic uppercase tracking-[0.14em] transition md:min-h-0 ${
              mode === m
                ? "bg-[color-mix(in_oklab,var(--neon)_18%,transparent)] text-neon shadow-[0_0_22px_-6px_var(--neon)]"
                : "text-muted-foreground hover:text-foreground"
            }`}
          >
            {m === "solo" ? "Solo" : "Van Wars"}
          </button>
        ))}
      </div>

      {mode === "vanwars" ? (
        <VanWarsRace />
      ) : (
        <>
          {/* Range tabs */}
          <div className="flex flex-wrap gap-1 rounded-lg border border-border bg-surface p-1">
            {(
              [
                ["day", "Today"],
                ["week", "Week"],
                ["month", "Month"],
              ] as const
            ).map(([k, label]) => (
              <button
                key={k}
                type="button"
                onClick={() => setTab(k)}
                className={`min-h-11 flex-1 rounded-md px-3 py-1.5 font-display text-[10px] uppercase tracking-widest transition md:min-h-0 ${
                  tab === k
                    ? "bg-[color-mix(in_oklab,var(--neon)_15%,transparent)] text-neon shadow-[0_0_18px_-4px_var(--neon)]"
                    : "text-muted-foreground hover:text-foreground"
                }`}
              >
                {label}
              </button>
            ))}
          </div>

          {/* Leagues — Main / Rookies / Risers (Phase 4 §5) */}
          <div className="flex gap-1 rounded-lg border border-border bg-surface p-1">
            {(
              [
                ["main", "Main"],
                ["rookies", "Rookies"],
                ["risers", "Risers"],
              ] as const
            ).map(([k, label]) => (
              <button
                key={k}
                type="button"
                onClick={() => setLeague(k)}
                className={`min-h-11 flex-1 rounded-md px-3 py-1.5 font-display text-[10px] uppercase tracking-widest transition md:min-h-0 ${
                  league === k
                    ? "bg-[color-mix(in_oklab,var(--accent)_18%,transparent)] text-[var(--accent)] shadow-[0_0_18px_-4px_var(--accent)]"
                    : "text-muted-foreground hover:text-foreground"
                }`}
              >
                {label}
              </button>
            ))}
          </div>

          {/* Month view carries the $100K boss + the points/$ ranking toggle. */}
          {tab === "month" && (
            <>
              {selfId && <BossMeter userId={selfId} />}
              <div className="flex gap-1 rounded-lg border border-border bg-surface p-1">
                {(
                  [
                    ["pts", "Points"],
                    ["bonus", "Bonus Race · $"],
                  ] as const
                ).map(([k, label]) => (
                  <button
                    key={k}
                    type="button"
                    onClick={() => setMonthMode(k)}
                    className={`min-h-11 flex-1 rounded-md px-3 py-1.5 font-display text-[10px] uppercase tracking-widest transition md:min-h-0 ${
                      monthMode === k
                        ? "bg-[color-mix(in_oklab,var(--kombat-gold)_18%,transparent)] text-[var(--kombat-gold)] shadow-[0_0_18px_-4px_var(--kombat-gold)]"
                        : "text-muted-foreground hover:text-foreground"
                    }`}
                  >
                    {label}
                  </button>
                ))}
              </div>
            </>
          )}

          {league === "risers" ? (
            <RisersBoard selfId={selfId} />
          ) : loading ? (
            <ArcadeSkeleton className="h-64 w-full" />
          ) : rows.length === 0 ? (
            <ArcadeCard className="p-6 text-center text-sm text-muted-foreground">
              {league === "rookies"
                ? "No rookies on the board this range — invite somebody new."
                : "No production in this range yet — first knock takes #1."}
            </ArcadeCard>
          ) : (
            <>
              {/* Pay-tier census — the money ladder in one line (Phase 4 §6).
                  Counts only; nobody's exact pay shows on a public board. */}
              {tierCensus && (
                <p className="text-center font-display text-[10px] uppercase tracking-widest text-muted-foreground">
                  This week:{" "}
                  <span className="text-[var(--kombat-gold)]">
                    ${HOURLY_TOP}/hr ×{tierCensus.top}
                  </span>{" "}
                  ·{" "}
                  <span className="text-victory">
                    ${HOURLY_MID}/hr ×{tierCensus.mid}
                  </span>{" "}
                  · ${HOURLY_BASE}/hr ×{tierCensus.base}
                </p>
              )}

              {/* Podium */}
              <Podium
                rows={podium}
                selfId={selfId}
                cartoons={cartoons}
                money={moneyMode}
                showBonuses={tab === "month"}
                reduced={reduced}
              />

              {/* High-score table */}
              <ArcadeCard asChild className="overflow-hidden p-0">
                <section>
                  <header className="flex items-center justify-between border-b border-border px-4 py-3">
                    <h2 className="font-display text-xs uppercase tracking-widest text-neon">
                      {moneyMode ? "Bonus Race · $" : "High Scores · Pts"}
                    </h2>
                    <span className="font-display text-[10px] uppercase tracking-widest text-muted-foreground">
                      {rows.length} on the board
                    </span>
                  </header>
                  <ol ref={listRef} className="relative divide-y divide-border/60 px-2">
                    {rest.map((r, i) => (
                      <ScoreRow
                        key={r.id}
                        r={r}
                        rank={i + 4}
                        self={r.id === selfId}
                        cartoons={cartoons}
                        flash={flash[r.id]}
                        money={moneyMode}
                        reduced={reduced}
                      />
                    ))}
                  </ol>
                </section>
              </ArcadeCard>

              {/* Next to pass */}
              {self && self.ahead && (
                <p className="text-center font-display text-[11px] uppercase tracking-widest text-[var(--warning)]">
                  {moneyMode
                    ? `${fmtVol(Math.max(0, self.gapVol))} to pass ${firstName(self.ahead.name)} for #${self.rank - 1}`
                    : self.gapPts > 0
                      ? `${self.gapPts} pt${self.gapPts === 1 ? "" : "s"} to pass ${firstName(self.ahead.name)} for #${self.rank - 1}`
                      : `${fmtVol(Math.max(0, self.gapVol))} to pass ${firstName(self.ahead.name)} for #${self.rank - 1}`}
                </p>
              )}
              {self && self.rank === 1 && (
                <p className="text-center font-display text-[11px] uppercase tracking-widest text-[var(--kombat-gold)]">
                  👑 You hold #1 — defend it
                </p>
              )}
            </>
          )}
        </>
      )}
    </div>
  );
}

// ── Podium ──────────────────────────────────────────────────────────────
function Podium({
  rows,
  selfId,
  cartoons,
  money,
  showBonuses = false,
  reduced,
}: {
  rows: LadderRow[];
  selfId: string | undefined;
  cartoons: Map<string, { name: string; portrait: string | null; full: string | null }> | undefined;
  /** Show credited $ instead of points (the Month "Bonus Race" view). */
  money: boolean;
  /** Month tab: each top-3's banked $1,500 chests ride under the name. */
  showBonuses?: boolean;
  reduced: boolean;
}) {
  // Visual order: #2 left, #1 center (tallest), #3 right.
  const order = [rows[1], rows[0], rows[2]].filter(Boolean) as LadderRow[];
  const place = (r: LadderRow) => rows.indexOf(r) + 1;
  const pedestal: Record<number, string> = { 1: "h-20", 2: "h-14", 3: "h-10" };
  const ring: Record<number, string> = {
    1: "ring-[var(--kombat-gold)]",
    2: "ring-[color-mix(in_oklab,white_55%,transparent)]",
    3: "ring-[var(--neon-orange)]",
  };
  const crown: Record<number, string> = { 1: "👑", 2: "🥈", 3: "🥉" };

  return (
    <ArcadeCard className="px-3 pb-3 pt-5">
      <div className="grid grid-cols-3 items-end gap-2">
        {order.map((r) => {
          const p = place(r);
          const self = r.id === selfId;
          return (
            <div key={r.id} className="flex min-w-0 flex-col items-center">
              <span className="mb-1 text-lg leading-none" aria-hidden>
                {crown[p]}
              </span>
              <div
                className={`relative rounded-full ring-2 ${ring[p]} ${
                  p === 1 && !reduced ? "podium-glow" : ""
                }`}
              >
                <RepAvatar
                  name={r.name}
                  cartoon={cartoonFor(cartoons, r.name)}
                  missing={noCartoonArt(cartoonFor(cartoons, r.name))}
                  variant="full"
                  fit="contain"
                  className={p === 1 ? "h-16 w-16" : "h-12 w-12"}
                  textClassName={p === 1 ? "text-sm" : "text-xs"}
                />
              </div>
              <span
                className={`mt-1.5 max-w-full truncate text-center text-xs ${self ? "font-medium text-neon" : ""}`}
              >
                {firstName(r.name)}
              </span>
              <span className="font-display text-[11px] tabular-nums text-victory">
                {money ? fmtVol(r.vol) : `${r.pts} pts`}
              </span>
              {/* Month podium: banked $1,500 chests, in dollars not mystery
                  icons (Phase 4 §6) */}
              {showBonuses && bonusCount(r.vol) > 0 && (
                <span className="font-display text-[10px] tabular-nums text-[var(--kombat-gold)]">
                  {bonusCount(r.vol)} × $1,500
                </span>
              )}
              {/* The two non-ranking metrics ride under the hero number so the
                  top spots show the money and leads the moment they land. A $0 /
                  0-lead part drops out so a fresh podium stays clean. */}
              {(() => {
                const parts = money
                  ? [`${r.pts} pts`, r.lds > 0 ? `${r.lds} lds` : null]
                  : [r.vol > 0 ? fmtVol(r.vol) : null, r.lds > 0 ? `${r.lds} lds` : null];
                const text = parts.filter(Boolean).join(" · ");
                return text ? (
                  <span className="font-display text-[10px] tabular-nums text-muted-foreground">
                    {text}
                  </span>
                ) : null;
              })()}
              <div
                className={`mt-1.5 w-full rounded-t-md border-x border-t border-border bg-[color-mix(in_oklab,var(--neon)_8%,transparent)] ${pedestal[p]}`}
              >
                <p className="pt-1 text-center font-display text-sm text-foreground/80">{p}</p>
              </div>
            </div>
          );
        })}
      </div>
    </ArcadeCard>
  );
}

// ── Score row ────────────────────────────────────────────────────────────
function ScoreRow({
  r,
  rank,
  self,
  cartoons,
  flash,
  money,
  reduced,
}: {
  r: LadderRow;
  rank: number;
  self: boolean;
  cartoons: Map<string, { name: string; portrait: string | null; full: string | null }> | undefined;
  flash: "up" | "down" | "coin" | undefined;
  /** Show credited $ instead of points (the Month "Bonus Race" view). */
  money: boolean;
  reduced: boolean;
}) {
  const bonuses = bonusCount(r.vol);
  return (
    <li
      data-row-id={r.id}
      className={`relative py-2.5 ${self ? "-mx-1 rounded bg-neon/10 px-1" : "bg-surface"}`}
    >
      <div className="flex items-center justify-between gap-3">
        <div className="flex min-w-0 items-center gap-2.5">
          <span className="flex w-8 shrink-0 items-center justify-end gap-0.5 font-display text-sm tabular-nums text-muted-foreground">
            {flash === "up" && <span className="text-victory">▲</span>}
            {flash === "down" && <span className="text-destructive">▼</span>}
            {rank}
          </span>
          {r.teamColor && (
            <span
              aria-hidden
              className="h-2 w-2 shrink-0 rounded-full"
              style={{ background: r.teamColor, boxShadow: `0 0 6px ${r.teamColor}` }}
            />
          )}
          <RepAvatar
            name={r.name}
            cartoon={cartoonFor(cartoons, r.name)}
            missing={noCartoonArt(cartoonFor(cartoons, r.name))}
            className="h-8 w-8"
            textClassName="text-[10px]"
            ring={self}
          />
          <span className={`truncate text-sm ${self ? "font-medium text-neon" : ""}`}>
            {r.name}
            {noCartoonArt(cartoonFor(cartoons, r.name)) && (
              <span className="ml-1.5 align-middle font-display text-[8px] uppercase tracking-widest text-muted-foreground/60">
                Photo needed
              </span>
            )}
            {self && (
              <span className="ml-1.5 font-display text-[9px] uppercase tracking-widest text-neon/80">
                you
              </span>
            )}
          </span>
          {flash === "coin" && !reduced && (
            <span className="coin-pop font-display text-[10px] text-victory" aria-hidden>
              +$
            </span>
          )}
        </div>
        <div className="flex shrink-0 items-center gap-2 font-display text-[11px] uppercase tracking-wider tabular-nums">
          {/* Points · $ · leads side by side on every tab — the old board's
              "PTS → $ → LEADS" line, restored. The ranking metric leads (Bonus
              Race leads with $, every other view with pts); a landed sale glows
              victory-green and leads glow hot-pink, each muted at 0. */}
          {money ? (
            <>
              <span className={r.vol > 0 ? "text-victory" : "text-muted-foreground/50"}>
                {fmtVol(r.vol)}
              </span>
              <span className="text-muted-foreground">{r.pts} pts</span>
            </>
          ) : (
            <>
              <span className="text-victory">{r.pts} pts</span>
              <span className={r.vol > 0 ? "text-victory" : "text-muted-foreground/40"}>
                {fmtVol(r.vol)}
              </span>
            </>
          )}
          <span className={r.lds > 0 ? "text-neon" : "text-muted-foreground/40"}>{r.lds} lds</span>
          {bonuses > 0 && (
            <span className="text-[var(--kombat-gold)]" title={`${bonuses} × $1,500 bonus`}>
              🪙×{bonuses}
            </span>
          )}
          {/* The S/A/B sit GRADE is retired from canvasser UI (Phase 4 §1);
              the honest % stays in the sub-line below. */}
        </div>
      </div>
      <div className="mt-0.5 pl-[3.1rem] font-display text-[9px] uppercase tracking-widest text-muted-foreground/70">
        {r.sal > 0 ? `${r.sal} sold · ` : ""}
        {r.sit.rate != null ? `${Math.round(r.sit.rate * 100)}% sit · ` : ""}
        {r.drs} drs · {r.tlk} tlk
        {r.cancels > 0 ? ` · ${r.cancels} cxl` : ""}
      </div>
    </li>
  );
}

// ── Risers (Most Improved) ────────────────────────────────────────────────
/** This week vs YOUR OWN last-4-week average (Phase 4 §5) — the board a
 *  mid-pack grinder can win. Pay-axis points only (no dojo bonus), one extra
 *  28-day aggregate query, cached 5 minutes. */
function RisersBoard({ selfId }: { selfId: string | undefined }) {
  const week = useArcadeLadder("week");
  const { start } = rangeFor("week");
  const priorQ = useQuery({
    queryKey: ["arcade_ladder", "risers", start],
    staleTime: 5 * 60_000,
    queryFn: async () =>
      getDispatchProduction({
        data: {
          log_start: addDaysISO(start, -28),
          log_end: addDaysISO(start, -1),
          vol_start: laMidnightUtcISO(addDaysISO(start, -28)),
          vol_end: laMidnightUtcISO(start),
        },
      }),
  });

  const rows = useMemo(() => {
    const prior = priorQ.data;
    if (!prior) return [];
    return week.rows
      .map((r) => {
        const avg = (prior.points?.[r.id] ?? 0) / 4;
        return { ...r, avg, delta: r.basePts - avg };
      })
      .filter((r) => r.basePts > 0 || r.avg > 0)
      .sort((a, b) => b.delta - a.delta || b.basePts - a.basePts)
      .slice(0, 15);
  }, [week.rows, priorQ.data]);

  if (week.loading || priorQ.isLoading) return <ArcadeSkeleton className="h-64 w-full" />;
  if (rows.length === 0) {
    return (
      <ArcadeCard className="p-6 text-center text-sm text-muted-foreground">
        The Risers board lights up once this week has production to compare.
      </ArcadeCard>
    );
  }

  return (
    <ArcadeCard asChild className="overflow-hidden p-0">
      <section>
        <header className="flex items-center justify-between border-b border-border px-4 py-3">
          <h2 className="font-display text-xs uppercase tracking-widest text-neon">
            Risers · vs your own 4-week average
          </h2>
          <span className="font-display text-[10px] uppercase tracking-widest text-muted-foreground">
            week pts
          </span>
        </header>
        <ol className="divide-y divide-border/60 px-2">
          {rows.map((r, i) => {
            const self = r.id === selfId;
            const up = r.delta >= 0;
            return (
              <li
                key={r.id}
                className={`flex items-center justify-between gap-3 py-2.5 ${
                  self ? "-mx-1 rounded bg-neon/10 px-1" : ""
                }`}
              >
                <div className="flex min-w-0 items-center gap-2.5">
                  <span className="w-8 shrink-0 text-right font-display text-sm tabular-nums text-muted-foreground">
                    {i + 1}
                  </span>
                  <span className={`truncate text-sm ${self ? "font-medium text-neon" : ""}`}>
                    {r.name}
                  </span>
                </div>
                <div className="flex shrink-0 items-center gap-2 font-display text-[11px] uppercase tabular-nums">
                  <span className={up ? "text-victory" : "text-destructive"}>
                    {up ? "▲" : "▼"}
                    {Math.abs(r.delta).toFixed(1)}
                  </span>
                  <span className="text-foreground">{r.basePts} pts</span>
                  <span className="text-muted-foreground">avg {r.avg.toFixed(1)}</span>
                </div>
              </li>
            );
          })}
        </ol>
      </section>
    </ArcadeCard>
  );
}
