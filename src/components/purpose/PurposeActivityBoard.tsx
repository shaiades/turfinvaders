// Purpose Leadership — the owner-side Tidal Activity Test board. Calm
// purpose-surface register only, never arcade. Named scores and answer
// sheets are fair game HERE because this is the admin-tier surface
// (useAllActivityTests); rep_job_visits stays untouched — the board never
// queries or renders per-rep visit counts ("the rep's own breadcrumb,
// NEVER compliance"), which is why the spec's SAID VS DID card is absent
// in V1 (owner decision).

import { Fragment, useMemo, useState } from "react";
import { Link } from "@tanstack/react-router";
import { Check } from "lucide-react";
import { cn } from "@/lib/utils";
import {
  latestTakeByRep,
  useAllActivityTests,
  type ActivityTestRow,
} from "@/hooks/useActivityTests";
import { useTrailingCrmByName } from "@/hooks/usePurposeScoreboard";
import { habitEarned, scoreActivityTest, tierForScore } from "@/lib/activity-test";
import { HABITS, MAX_SCORE, type HabitDef } from "@/data/activity-test-content";
import { usePrefersReducedMotion } from "@/hooks/usePrefersReducedMotion";
import { PurposeButton, PurposeCard, PurposeChip, PurposeLabel } from "./kit";

export type ActivityBoardRep = { userId: string; displayName: string };

const fmtK = (n: number) => (n >= 1000 ? `$${(n / 1000).toFixed(1)}k` : `$${Math.round(n)}`);

const fmt1 = (n: number) => (Number.isInteger(n) ? String(n) : n.toFixed(1));

const titleCase = (label: string) => label.charAt(0) + label.slice(1).toLowerCase();

const initialsOf = (name: string) =>
  name
    .trim()
    .split(/\s+/)
    .slice(0, 2)
    .map((w) => w[0]?.toUpperCase() ?? "")
    .join("");

/** Mirrors PurposeLeadership's SummaryTile (not exported there — a copy
 *  keeps the import graph acyclic). */
function Tile({ label, value }: { label: string; value: string }) {
  return (
    <div className="min-w-0 rounded-xl border border-[var(--purpose-line)] bg-[var(--purpose-card)] p-3">
      <div className="text-lg font-semibold leading-tight tabular-nums">{value}</div>
      <div className="mt-1 text-[10px] uppercase tracking-wider text-[var(--purpose-ink-dim)]">
        {label}
      </div>
    </div>
  );
}

/** Ladder bar — PurposeProgress-style but h-1.5 and fill-color aware (the
 *  top score renders sand, everyone else tide). */
function ScoreBar({ score, max, top }: { score: number; max: number; top: boolean }) {
  const pct = max > 0 ? Math.max(0, Math.min(100, (score / max) * 100)) : 0;
  return (
    <div className="h-1.5 w-full min-w-0 rounded-full bg-[color-mix(in_oklab,var(--purpose-tide)_14%,transparent)]">
      <div
        className="h-1.5 rounded-full"
        style={{
          width: `${pct}%`,
          background: top ? "var(--purpose-sand)" : "var(--purpose-tide)",
        }}
      />
    </div>
  );
}

const SPARK_W = 60;
const SPARK_H = 16;
const SPARK_PAD = 2;

/** 60×16 take-history polyline, oldest → newest, last point a sand dot. */
function Sparkline({ takes }: { takes: ActivityTestRow[] }) {
  const pts = [...takes].reverse();
  if (pts.length < 2) return null;
  const x = (i: number) => SPARK_PAD + i * ((SPARK_W - 2 * SPARK_PAD) / (pts.length - 1));
  const y = (t: ActivityTestRow) => {
    const max = t.max_score > 0 ? t.max_score : MAX_SCORE;
    return SPARK_H - SPARK_PAD - (t.score / max) * (SPARK_H - 2 * SPARK_PAD);
  };
  const points = pts.map((t, i) => `${x(i).toFixed(1)},${y(t).toFixed(1)}`).join(" ");
  const last = pts[pts.length - 1];
  return (
    <svg
      viewBox={`0 0 ${SPARK_W} ${SPARK_H}`}
      width={SPARK_W}
      height={SPARK_H}
      className="shrink-0"
      aria-hidden
    >
      <polyline
        points={points}
        fill="none"
        stroke="var(--purpose-tide)"
        strokeWidth="1.5"
        strokeLinejoin="round"
        strokeLinecap="round"
      />
      <circle cx={x(pts.length - 1)} cy={y(last)} r="2" fill="var(--purpose-sand)" />
    </svg>
  );
}

function HabitDot({ earned, flipped }: { earned: boolean; flipped: boolean }) {
  return (
    <span
      className={cn(
        "inline-block size-3 rounded-full",
        earned ? "bg-[var(--purpose-tide)]" : "border border-[var(--purpose-line)]",
        flipped && "ring-2 ring-[var(--purpose-sand)]",
      )}
      aria-hidden
    />
  );
}

// Scatter geometry — CashCurve conventions: W/H constants, text in HTML
// outside the SVG (labels are absolutely-positioned divs over it).
const SC_W = 343;
const SC_H = 180;
const SC_PAD = 12;

type ScatterPoint = {
  userId: string;
  name: string;
  initials: string;
  score: number;
  max: number;
  revenue: number;
  closePct: number | null;
};

type TakerRow = ActivityBoardRep & {
  take: ActivityTestRow;
  prev: ActivityTestRow | null;
  hist: ActivityTestRow[];
  missedTop3: HabitDef[];
};

export function PurposeActivityBoard({ rows }: { rows: ActivityBoardRep[] }) {
  const all = useAllActivityTests(true);
  const reduced = usePrefersReducedMotion();
  const [picked, setPicked] = useState<string | null>(null);
  const [axis, setAxis] = useState<"revenue" | "closePct">("revenue");

  const names = useMemo(() => rows.map((r) => r.displayName), [rows]);
  // Same ["block_cards", …] key the page's week column already fetches —
  // this aggregation is served warm, zero extra network.
  const { map: crm, isError: crmError } = useTrailingCrmByName(names, true);

  const takes = useMemo(() => all.data?.takes ?? [], [all.data]);
  const missingMigration = all.data?.missingMigration ?? false;
  const latest = useMemo(() => latestTakeByRep(takes), [takes]);
  const history = useMemo(() => {
    const m = new Map<string, ActivityTestRow[]>();
    for (const t of takes) {
      const arr = m.get(t.rep_id);
      if (arr) arr.push(t);
      else m.set(t.rep_id, [t]);
    }
    return m;
  }, [takes]);

  const takers: TakerRow[] = useMemo(() => {
    const list = rows
      .filter((r) => latest.has(r.userId))
      .map((r) => {
        const take = latest.get(r.userId)!;
        const hist = history.get(r.userId) ?? [take];
        const missedTop3 = [...scoreActivityTest(take.answers).missed]
          .sort((a, b) => b.points - a.points)
          .slice(0, 3);
        return { ...r, take, hist, prev: hist[1] ?? null, missedTop3 };
      });
    list.sort((a, b) => b.take.score - a.take.score || a.displayName.localeCompare(b.displayName));
    return list;
  }, [rows, latest, history]);

  const notTaken = useMemo(() => rows.filter((r) => !latest.has(r.userId)), [rows, latest]);

  const agg = useMemo(() => {
    const scores = takers.map((t) => t.take.score);
    if (scores.length === 0) return null;
    const sorted = [...scores].sort((a, b) => a - b);
    const mid = sorted.length >> 1;
    return {
      avg: scores.reduce((s, v) => s + v, 0) / scores.length,
      median: sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2,
      min: sorted[0],
      max: sorted[sorted.length - 1],
    };
  }, [takers]);

  const matrix = useMemo(() => {
    const rowsM = HABITS.map((h) => {
      const cells = takers.map((t) => {
        const earned = habitEarned(h, t.take.answers?.[h.key]);
        return {
          userId: t.userId,
          earned,
          flipped: earned && !!t.prev && !habitEarned(h, t.prev.answers?.[h.key]),
        };
      });
      return { habit: h, cells, c: cells.filter((x) => x.earned).length };
    });
    rowsM.sort((a, b) => a.c - b.c || b.habit.points - a.habit.points);
    return { k: takers.length, rows: rowsM };
  }, [takers]);

  const unlocks = useMemo(
    () =>
      matrix.rows
        .map((r) => ({ habit: r.habit, missing: matrix.k - r.c }))
        .filter((u) => u.missing > 0)
        .sort((a, b) => b.missing * b.habit.points - a.missing * a.habit.points)
        .slice(0, 5),
    [matrix],
  );

  const scatter = useMemo(() => {
    const pts: ScatterPoint[] = [];
    const unmatched: string[] = [];
    if (!crm) return { pts, unmatched };
    for (const t of takers) {
      const row = crm.get(t.displayName);
      if (!row) {
        unmatched.push(t.displayName);
        continue;
      }
      pts.push({
        userId: t.userId,
        name: t.displayName,
        initials: initialsOf(t.displayName),
        score: t.take.score,
        max: t.take.max_score > 0 ? t.take.max_score : MAX_SCORE,
        revenue: row.revenue,
        closePct: row.closePct,
      });
    }
    return { pts, unmatched };
  }, [takers, crm]);

  const scrollToUnlock = (key: string) => {
    const el =
      document.getElementById(`unlock-${key}`) ?? document.getElementById("activity-unlocks");
    el?.scrollIntoView({ behavior: reduced ? "auto" : "smooth", block: "center" });
  };

  // Honesty gates: the section doesn't exist until the migration does;
  // loading looks like loading; an error says so.
  if (missingMigration) return null;

  if (all.isLoading) {
    return (
      <section className="mt-8 min-w-0">
        <PurposeLabel>Tidal Activity Test</PurposeLabel>
        <PurposeCard className="mt-3 p-4 md:p-5">
          <div className="space-y-2.5">
            {[0, 1, 2].map((i) => (
              <div
                key={i}
                className="h-4 w-full animate-pulse rounded bg-[color-mix(in_oklab,var(--purpose-ink-dim)_14%,transparent)] motion-reduce:animate-none"
              />
            ))}
          </div>
        </PurposeCard>
      </section>
    );
  }

  if (all.isError) {
    return (
      <section className="mt-8 min-w-0">
        <PurposeLabel>Tidal Activity Test</PurposeLabel>
        <PurposeCard className="mt-3 p-4 md:p-5">
          <p className="text-sm leading-relaxed text-[var(--purpose-ink-dim)]">
            Couldn't load the Activity Test board. Try again in a moment.
          </p>
        </PurposeCard>
      </section>
    );
  }

  const topScore = takers[0]?.take.score ?? null;

  const plotted = axis === "closePct" ? scatter.pts.filter((p) => p.closePct != null) : scatter.pts;
  const noRate =
    axis === "closePct" ? scatter.pts.filter((p) => p.closePct == null).map((p) => p.name) : [];
  const xMax = axis === "closePct" ? 1 : Math.max(...plotted.map((p) => p.revenue), 1);
  const xOf = (p: ScatterPoint) =>
    SC_PAD + ((axis === "closePct" ? (p.closePct ?? 0) : p.revenue) / xMax) * (SC_W - 2 * SC_PAD);
  const yOf = (p: ScatterPoint) => SC_H - SC_PAD - (p.score / MAX_SCORE) * (SC_H - 2 * SC_PAD);
  const pickedPt = plotted.find((p) => p.userId === picked) ?? null;

  return (
    <section className="mt-8 min-w-0">
      <PurposeLabel>Tidal Activity Test</PurposeLabel>
      <div className="mt-3 grid grid-cols-1 gap-3">
        {/* a) Team tiles */}
        <div className="grid grid-cols-2 gap-2 md:grid-cols-4">
          <Tile label="Team avg" value={agg ? agg.avg.toFixed(1) : "—"} />
          <Tile label="Median" value={agg ? fmt1(agg.median) : "—"} />
          <Tile label="Range" value={agg ? `${agg.min}–${agg.max}` : "—"} />
          <Tile label="Taken" value={`${takers.length}/${rows.length}`} />
        </div>

        {takers.length === 0 ? (
          <PurposeCard className="p-4 md:p-5">
            <p className="text-sm leading-relaxed text-[var(--purpose-ink-dim)]">
              No Activity Tests logged yet. Scores appear here as reps take the test.
            </p>
          </PurposeCard>
        ) : (
          <>
            {/* b) Named score ladder */}
            <PurposeCard className="p-4 md:p-5">
              <PurposeLabel>Score ladder</PurposeLabel>
              <div className="mt-3 space-y-0.5">
                {takers.map((t) => {
                  const delta = t.prev ? t.take.score - t.prev.score : null;
                  return (
                    <Link
                      key={t.userId}
                      to="/purpose-leadership/$userId"
                      params={{ userId: t.userId }}
                      className="flex min-h-11 min-w-0 items-center gap-2 rounded-lg px-1 transition-colors hover:bg-[color-mix(in_oklab,var(--purpose-tide)_8%,transparent)]"
                    >
                      <span className="w-28 shrink-0 truncate text-sm font-medium">
                        {t.displayName}
                      </span>
                      <div className="min-w-0 flex-1">
                        <ScoreBar
                          score={t.take.score}
                          max={t.take.max_score > 0 ? t.take.max_score : MAX_SCORE}
                          top={t.take.score === topScore}
                        />
                      </div>
                      <span className="w-10 shrink-0 text-right text-sm tabular-nums">
                        {t.take.score}
                      </span>
                      <span
                        className={cn(
                          "w-4 shrink-0 text-center text-xs",
                          delta != null && delta > 0 && "text-[var(--purpose-sand)]",
                          delta != null && delta < 0 && "text-[var(--purpose-ink-dim)]",
                        )}
                        aria-label={
                          delta == null
                            ? undefined
                            : delta > 0
                              ? "Up vs previous take"
                              : delta < 0
                                ? "Down vs previous take"
                                : "Unchanged vs previous take"
                        }
                      >
                        {delta != null && delta > 0 ? "▲" : delta != null && delta < 0 ? "▼" : ""}
                      </span>
                      <span className="w-[60px] shrink-0">
                        <Sparkline takes={t.hist} />
                      </span>
                    </Link>
                  );
                })}
                {notTaken.map((r) => (
                  <Link
                    key={r.userId}
                    to="/purpose-leadership/$userId"
                    params={{ userId: r.userId }}
                    className="flex min-h-11 min-w-0 items-center gap-2 rounded-lg px-1 text-[var(--purpose-ink-dim)] transition-colors hover:bg-[color-mix(in_oklab,var(--purpose-tide)_8%,transparent)]"
                  >
                    <span className="w-28 shrink-0 truncate text-sm font-medium">
                      {r.displayName}
                    </span>
                    <span className="text-xs">Not taken</span>
                  </Link>
                ))}
              </div>
              {agg && (
                <p className="mt-3 text-xs tabular-nums text-[var(--purpose-ink-dim)]">
                  <span
                    className="mr-1.5 inline-block w-4 border-t border-dashed border-[var(--purpose-ink-dim)] align-middle"
                    aria-hidden
                  />
                  team avg {agg.avg.toFixed(1)}
                </p>
              )}
            </PurposeCard>

            {/* c) Habit × rep matrix — desktop grid + mobile card twin */}
            <PurposeCard className="p-4 md:p-5">
              <PurposeLabel>Habit × rep matrix</PurposeLabel>

              {/* Data scroller: visible scrollbar on purpose (scrollbar-hide
                  is nav-only), min-w-0 chain per the PR #83 trap. */}
              <div className="mt-3 hidden min-w-0 md:block">
                <div className="min-w-0 overflow-x-auto rounded-xl border border-[var(--purpose-line)]">
                  <div
                    className="grid w-max min-w-full"
                    style={{ gridTemplateColumns: `220px repeat(${matrix.k}, 36px)` }}
                  >
                    <div />
                    {takers.map((t) => (
                      <div key={t.userId} className="flex items-end justify-center px-1 pb-1 pt-2">
                        <span
                          className="max-h-24 overflow-hidden text-ellipsis whitespace-nowrap text-[10px] text-[var(--purpose-ink-dim)]"
                          style={{ writingMode: "vertical-rl", transform: "rotate(180deg)" }}
                          title={t.displayName}
                        >
                          {t.displayName}
                        </span>
                      </div>
                    ))}
                    {matrix.rows.map((r, idx) => {
                      const coachable = idx < 3 && r.c < matrix.k;
                      return (
                        <Fragment key={r.habit.key}>
                          <div className="border-t border-[var(--purpose-line)] py-2 pl-3 pr-2">
                            <div className="text-xs leading-snug">{r.habit.label}</div>
                            <div
                              className={cn(
                                "mt-0.5 text-[11px] tabular-nums",
                                coachable
                                  ? "text-[var(--purpose-sand)]"
                                  : "text-[var(--purpose-ink-dim)]",
                              )}
                            >
                              {r.c}/{matrix.k}
                              {matrix.k > 0 && r.c === matrix.k && (
                                <span className="ml-2 inline-flex items-center gap-1 text-[var(--purpose-ink-dim)]">
                                  <Check className="size-3" aria-hidden />
                                  team habit
                                </span>
                              )}
                            </div>
                            {coachable && (
                              <PurposeButton
                                tone="quiet"
                                className="min-h-8 justify-start px-0 text-xs text-[var(--purpose-sand)] hover:text-[var(--purpose-sand)] hover:underline"
                                onClick={() => scrollToUnlock(r.habit.key)}
                              >
                                Coach this
                              </PurposeButton>
                            )}
                          </div>
                          {r.cells.map((cell) => (
                            <div
                              key={cell.userId}
                              className="flex items-center justify-center border-t border-[var(--purpose-line)] py-2"
                            >
                              <HabitDot earned={cell.earned} flipped={cell.flipped} />
                            </div>
                          ))}
                        </Fragment>
                      );
                    })}
                  </div>
                </div>
                <p className="mt-2 text-[11px] text-[var(--purpose-ink-dim)]">
                  Filled = earned · hollow = not · sand ring = flipped to earned since their
                  previous take.
                </p>
              </div>

              <div className="mt-3 grid grid-cols-1 gap-2 md:hidden">
                {takers.map((t) => {
                  const tier = tierForScore(t.take.score);
                  return (
                    <div
                      key={t.userId}
                      className="min-w-0 rounded-xl border border-[var(--purpose-line)] p-3"
                    >
                      <div className="flex min-w-0 items-center justify-between gap-2">
                        <Link
                          to="/purpose-leadership/$userId"
                          params={{ userId: t.userId }}
                          className="min-w-0 truncate text-sm font-medium hover:underline"
                        >
                          {t.displayName}
                        </Link>
                        <span className="shrink-0 text-sm tabular-nums text-[var(--purpose-ink-dim)]">
                          {t.take.score}/{t.take.max_score > 0 ? t.take.max_score : MAX_SCORE} ·{" "}
                          {titleCase(tier.label)}
                        </span>
                      </div>
                      {t.missedTop3.length > 0 ? (
                        <div className="mt-2 flex flex-wrap gap-1.5">
                          {t.missedTop3.map((h) => (
                            <PurposeChip key={h.key} onClick={() => {}}>
                              {h.label}
                            </PurposeChip>
                          ))}
                        </div>
                      ) : (
                        <p className="mt-2 text-xs text-[var(--purpose-ink-dim)]">
                          Every habit earned.
                        </p>
                      )}
                    </div>
                  );
                })}
              </div>
            </PurposeCard>

            {/* d) Habits × results scatter */}
            <PurposeCard className="p-4 md:p-5">
              <div className="flex flex-wrap items-center justify-between gap-2">
                <PurposeLabel>Habits × results</PurposeLabel>
                <div className="flex gap-1">
                  {(["revenue", "closePct"] as const).map((k) => (
                    <PurposeButton
                      key={k}
                      tone={axis === k ? "ghost" : "quiet"}
                      className="px-3 text-sm"
                      aria-pressed={axis === k}
                      onClick={() => {
                        setAxis(k);
                        setPicked(null);
                      }}
                    >
                      {k === "revenue" ? "Volume" : "Close %"}
                    </PurposeButton>
                  ))}
                </div>
              </div>

              {crmError ? (
                <p className="mt-3 text-sm text-[var(--purpose-ink-dim)]">
                  Couldn't load the trailing board numbers. Try again in a moment.
                </p>
              ) : crm === null ? (
                <p className="mt-3 text-sm text-[var(--purpose-ink-dim)]">
                  Loading the trailing board numbers…
                </p>
              ) : plotted.length === 0 ? (
                <p className="mt-3 text-sm leading-relaxed text-[var(--purpose-ink-dim)]">
                  No reps with both a test on file and a board match yet.
                </p>
              ) : (
                <>
                  <div className="relative mt-3">
                    <svg
                      viewBox={`0 0 ${SC_W} ${SC_H}`}
                      className="h-auto w-full select-none"
                      role="img"
                      aria-label="Latest Activity Test score vs trailing two-week board results"
                    >
                      {[10, 20].map((s) => (
                        <line
                          key={s}
                          x1={SC_PAD}
                          x2={SC_W - SC_PAD}
                          y1={SC_H - SC_PAD - (s / MAX_SCORE) * (SC_H - 2 * SC_PAD)}
                          y2={SC_H - SC_PAD - (s / MAX_SCORE) * (SC_H - 2 * SC_PAD)}
                          stroke="var(--purpose-line)"
                          strokeWidth="1"
                        />
                      ))}
                      <line
                        x1={SC_PAD}
                        x2={SC_W - SC_PAD}
                        y1={SC_H - SC_PAD}
                        y2={SC_H - SC_PAD}
                        stroke="var(--purpose-line)"
                        strokeWidth="1"
                      />
                      <line
                        x1={SC_PAD}
                        x2={SC_PAD}
                        y1={SC_PAD}
                        y2={SC_H - SC_PAD}
                        stroke="var(--purpose-line)"
                        strokeWidth="1"
                      />
                      {plotted.map((p) => (
                        <g
                          key={p.userId}
                          className="cursor-pointer"
                          onClick={() => setPicked((cur) => (cur === p.userId ? null : p.userId))}
                        >
                          <circle cx={xOf(p)} cy={yOf(p)} r="10" fill="transparent" />
                          <circle
                            cx={xOf(p)}
                            cy={yOf(p)}
                            r="3"
                            fill={
                              picked === p.userId ? "var(--purpose-sand)" : "var(--purpose-tide)"
                            }
                          />
                        </g>
                      ))}
                    </svg>
                    {plotted.map((p) => (
                      <span
                        key={p.userId}
                        className={cn(
                          "pointer-events-none absolute -translate-y-1/2 text-[10px]",
                          picked === p.userId
                            ? "text-[var(--purpose-sand)]"
                            : "text-[var(--purpose-ink-dim)]",
                        )}
                        style={{
                          left: `calc(${((xOf(p) / SC_W) * 100).toFixed(2)}% + 6px)`,
                          top: `${((yOf(p) / SC_H) * 100).toFixed(2)}%`,
                        }}
                        aria-hidden
                      >
                        {p.initials}
                      </span>
                    ))}
                  </div>
                  <div className="mt-1 flex items-center justify-between gap-2 text-[10px] text-[var(--purpose-ink-dim)]">
                    <span>
                      score 0–{MAX_SCORE} ↑ ·{" "}
                      {axis === "revenue" ? "trailing 2-wk volume →" : "trailing 2-wk close % →"}
                    </span>
                    <span className="tabular-nums">
                      {axis === "revenue" ? `to ${fmtK(xMax)}` : "to 100%"}
                    </span>
                  </div>
                  <div className="mt-2 min-h-5 text-xs tabular-nums text-[var(--purpose-ink-dim)]">
                    {pickedPt
                      ? `${pickedPt.name} — ${pickedPt.score}/${pickedPt.max} · ${
                          axis === "revenue"
                            ? `${fmtK(pickedPt.revenue)} trailing 2wk`
                            : `${Math.round((pickedPt.closePct ?? 0) * 100)}% close trailing 2wk`
                        }`
                      : "Tap a point for the name and numbers."}
                  </div>
                </>
              )}
              {crm !== null && noRate.length > 0 && (
                <p className="mt-2 text-xs leading-relaxed text-[var(--purpose-ink-dim)]">
                  no close rate yet: {noRate.join(", ")}
                </p>
              )}
              {crm !== null && scatter.unmatched.length > 0 && (
                <p className="mt-2 text-xs leading-relaxed text-[var(--purpose-ink-dim)]">
                  no board match: {scatter.unmatched.join(", ")}
                </p>
              )}
            </PurposeCard>

            {/* e) Biggest unlocks */}
            {unlocks.length > 0 && (
              <div id="activity-unlocks" className="scroll-mt-24">
                <PurposeCard className="p-4 md:p-5">
                  <PurposeLabel>Biggest unlocks</PurposeLabel>
                  <div className="mt-3 space-y-3">
                    {unlocks.map((u) => (
                      <div key={u.habit.key} id={`unlock-${u.habit.key}`} className="scroll-mt-24">
                        <p className="text-sm leading-snug">
                          {u.habit.label} — {u.missing} {u.missing === 1 ? "rep" : "reps"} missing ·{" "}
                          {u.habit.points} {u.habit.points === 1 ? "pt" : "pts"} each →{" "}
                          <span className="font-medium text-[var(--purpose-sand)]">
                            {u.missing * u.habit.points} team points on the table.
                          </span>
                        </p>
                        {u.habit.leverNote && (
                          <p className="mt-0.5 text-xs leading-relaxed text-[var(--purpose-ink-dim)]">
                            {u.habit.leverNote}
                          </p>
                        )}
                      </div>
                    ))}
                  </div>
                </PurposeCard>
              </div>
            )}
          </>
        )}
      </div>
    </section>
  );
}
