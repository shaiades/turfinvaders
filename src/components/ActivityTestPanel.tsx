// High-Performer Profile — the rep-facing Tidal Activity Test panel on the
// Close Kombat Goals tab. Every number traces to a stored take, the
// aggregates-only team-stats RPC, or the rep's own logged JIP visits —
// loading renders as loading, absent data says so, unmeasured claims say
// "no telemetry yet" (never-invent-numbers). All motion is one-shot and
// reduced-motion-gated; the only loop is the first-test CTA's pulse-glow.
//
// View As: the subject resolves by display_name (useActivitySubject) but
// user.id stays the ADMIN's, so my_rank, the visit log, the Core Why, the
// FIELD-VERIFIED stamp, and every write stay own-account-only facts —
// each is hidden or disabled in preview rather than shown as a lie.

import { useEffect, useMemo, useState, type CSSProperties, type ReactNode } from "react";
import { Link } from "@tanstack/react-router";
import {
  Check,
  Crown,
  Shield,
  Skull,
  Sparkles,
  Star,
  Swords,
  TrendingUp,
  Trophy,
  Zap,
  type LucideIcon,
} from "lucide-react";
import {
  ArcadePanel,
  ArcadeSkeleton,
  DeltaChip,
  NeonBar,
  NeonButton,
  Sparkbars,
  type PanelStatus,
} from "@/components/arcade";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { Sheet, SheetContent, SheetHeader, SheetTitle } from "@/components/ui/sheet";
import { ActivityTestSheet } from "@/components/ActivityTestSheet";
import { cn } from "@/lib/utils";
import { usePrefersReducedMotion } from "@/hooks/usePrefersReducedMotion";
import { useCountUp } from "@/hooks/useCountUp";
import { addDaysISO, dateFromISO, laTodayISO, laWeekStartISO } from "@/lib/dates";
import {
  BOSS_NAMES,
  TEST_TIERS,
  TEST_VERSION,
  claimedJipVisitsPerWeek,
  habitEarned,
  nextTier,
  rankGapHabits,
  scoreActivityTest,
  tierForScore,
} from "@/lib/activity-test";
import { HABITS, MAX_SCORE, type HabitDef } from "@/data/activity-test-content";
import {
  adoptionCount,
  useActivitySubject,
  useActivityTeamStats,
  useActivityTests,
  useMyJipVisitsThisWeek,
  type ActivityTestRow,
} from "@/hooks/useActivityTests";
import { usePurposeConfig } from "@/hooks/usePurposeConfig";
import { usePurposeProfile } from "@/hooks/usePurposeProfile";
import { useMyPurposeQuote } from "@/hooks/useMyPurposeQuote";

const TIER_ICONS: Record<string, LucideIcon> = {
  Shield,
  Star,
  Swords,
  Sparkles,
  Trophy,
  Crown,
};

/** "Sep 29" (year added once it isn't this year) from a YYYY-MM-DD take date. */
export function formatTestedOn(isoDate: string): string {
  const sameYear = isoDate.slice(0, 4) === laTodayISO().slice(0, 4);
  return new Intl.DateTimeFormat("en-US", {
    month: "short",
    day: "numeric",
    ...(sameYear ? {} : { year: "numeric" }),
  }).format(dateFromISO(isoDate));
}

const daysBetweenISO = (a: string, b: string) =>
  Math.round((Date.parse(`${b}T12:00:00Z`) - Date.parse(`${a}T12:00:00Z`)) / 86_400_000);

function initialsOf(name: string | null): string {
  const parts = (name ?? "").trim().split(/\s+/).filter(Boolean);
  if (!parts.length) return "?";
  return parts
    .slice(0, 2)
    .map((p) => p[0]!.toUpperCase())
    .join("");
}

function FighterSilhouette({ className }: { className?: string }) {
  return (
    <svg viewBox="0 0 64 64" className={className} aria-hidden>
      <path
        d="M32 9a10.5 10.5 0 1 1 0 21 10.5 10.5 0 0 1 0-21Zm-22 48c0-12.6 9.9-19.5 22-19.5S54 44.4 54 57v1H10Z"
        fill="color-mix(in oklab, var(--kombat-red) 30%, black)"
      />
    </svg>
  );
}

/** Adoption strip: up to ten 5px dots, filled = teammates whose latest take
 *  earned the habit (capped at the team size). */
function AdoptionDots({ count, n }: { count: number; n: number }) {
  const total = Math.min(10, Math.max(0, n));
  const filled = Math.max(0, Math.min(count, total));
  return (
    <div className="flex gap-[3px]">
      {Array.from({ length: total }, (_, i) => (
        <span
          key={i}
          className={cn("h-[5px] w-[5px] rounded-full", i >= filled && "border border-border")}
          style={
            i < filled
              ? { background: "color-mix(in oklab, var(--neon) 70%, transparent)" }
              : undefined
          }
        />
      ))}
    </div>
  );
}

const tryGet = (key: string): string | null => {
  try {
    return window.localStorage.getItem(key);
  } catch {
    return null;
  }
};
const trySet = (key: string, value: string) => {
  try {
    window.localStorage.setItem(key, value);
  } catch {
    /* best effort — stamps and bar-moved lines just don't show */
  }
};

export function ActivityTestPanel({
  userId,
  displayName,
  isPreview,
  onLeverPulse,
}: {
  userId: string | undefined;
  displayName: string | null;
  isPreview: boolean;
  /** Fires the one-shot neon ring on the matching Goals FunnelTile. */
  onLeverPulse?: (lever: "closePct" | "sitPct") => void;
}) {
  const reduced = usePrefersReducedMotion();
  const todayISO = laTodayISO();
  const weekStart = laWeekStartISO();

  const { subjectId, canWrite, resolving } = useActivitySubject(userId, displayName, isPreview);
  const testsQuery = useActivityTests(subjectId);
  const statsQuery = useActivityTeamStats();
  const stats = statsQuery.data ?? null;

  const takes = useMemo(() => testsQuery.data?.takes ?? [], [testsQuery.data]);
  const missingMigration = testsQuery.data?.missingMigration ?? false;
  const latest: ActivityTestRow | null = takes[0] ?? null;
  // Takes of different versions are never compared — history, deltas, and
  // personal bests all live inside the current questionnaire version.
  const history = useMemo(
    () =>
      takes
        .filter((t) => t.version === TEST_VERSION)
        .slice()
        .reverse(),
    [takes],
  );
  const prevTake =
    latest && latest.version === TEST_VERSION && history.length > 1
      ? history[history.length - 2]
      : null;

  const scored = useMemo(() => (latest ? scoreActivityTest(latest.answers) : null), [latest]);
  const tier = latest ? tierForScore(latest.score) : null;
  const next = latest ? nextTier(latest.score) : null;
  const daysSinceLatest = latest ? Math.max(0, daysBetweenISO(latest.taken_on, todayISO)) : 0;
  const capped = takes.some((t) => t.taken_on >= weekStart);

  const habitByKey = useMemo(() => new Map(HABITS.map((h) => [h.key, h])), []);
  const adoptionOf = (key: string): number | null => {
    const h = habitByKey.get(key);
    return h ? adoptionCount(stats, key, h.correctAnswer) : null;
  };
  const gapHabits = useMemo(
    () =>
      scored
        ? rankGapHabits(scored.missed, (key) => {
            const h = habitByKey.get(key);
            return h ? adoptionCount(stats, key, h.correctAnswer) : null;
          }).slice(0, 3)
        : [],
    [scored, stats, habitByKey],
  );
  const bosses = useMemo(() => {
    if (!stats || !stats.n) return [];
    return HABITS.map((h) => ({ h, c: adoptionCount(stats, h.key, h.correctAnswer) }))
      .filter((x): x is { h: HabitDef; c: number } => x.c !== null)
      .sort((a, b) => a.c - b.c)
      .slice(0, 3);
  }, [stats]);
  const pipelineAdoption = stats ? adoptionCount(stats, "pipeline_reloads", "yes") : null;

  // Field receipts — the rep's OWN visit log only (never readable in preview).
  const jipQuery = useMyJipVisitsThisWeek(userId, !isPreview);
  const said = latest ? claimedJipVisitsPerWeek(latest.answers) : null;
  // DISTINCT jobs, not job×day rows — the claim is "how many JOBS do you
  // visit each week" (times-per-job is the separate, untracked question),
  // and one job visited three days must not count as three.
  const logged = jipQuery.data ? new Set(jipQuery.data.map((r) => r.monday_item_id)).size : null;

  // Purpose strip gating: flag on AND (preview placeholder OR own submitted).
  const purposeConfigQuery = usePurposeConfig(true);
  const purposeOn = purposeConfigQuery.data?.sales_rep_feature_enabled === true;
  const profileQuery = usePurposeProfile(purposeOn && !isPreview ? userId : undefined);
  const submitted = profileQuery.data?.row?.status === "submitted";
  const quoteQuery = useMyPurposeQuote(userId, purposeOn && !isPreview && submitted);
  const quote = quoteQuery.data ?? null;
  const showWhy = purposeOn && (isPreview || submitted);

  const [retakeOpen, setRetakeOpen] = useState(false);
  const [reviewTake, setReviewTake] = useState<ActivityTestRow | null>(null);
  const [boss, setBoss] = useState<{ h: HabitDef; c: number } | null>(null);

  // FIELD-VERIFIED stamp: logged ≥ said two Mon–Sun weeks running. The streak
  // lives in localStorage ({week, streak}); storage failures just mean no
  // stamp, never an error. Own-account only — a preview never stamps.
  const [verified, setVerified] = useState(false);
  useEffect(() => {
    if (isPreview || !userId) return;
    setVerified(tryGet(`ti_activity_verified:${userId}`) === "1");
  }, [isPreview, userId]);
  useEffect(() => {
    if (isPreview || !userId || said == null || logged == null || logged < said) return;
    try {
      const key = `ti_activity_receipts:${userId}`;
      const raw = window.localStorage.getItem(key);
      const stored = raw ? (JSON.parse(raw) as { week?: string; streak?: number }) : null;
      let streak = stored?.streak ?? 0;
      if (stored?.week !== weekStart) {
        streak = stored?.week === addDaysISO(weekStart, -7) ? streak + 1 : 1;
        window.localStorage.setItem(key, JSON.stringify({ week: weekStart, streak }));
      }
      if (streak >= 2) {
        window.localStorage.setItem(`ti_activity_verified:${userId}`, "1");
        setVerified(true);
      }
    } catch {
      /* storage unavailable — the stamp just doesn't show */
    }
  }, [isPreview, userId, said, logged, weekStart]);

  // "THE BAR MOVED" — compare team best against the last best this device saw.
  const [barMoved, setBarMoved] = useState<{ old: number; now: number } | null>(null);
  useEffect(() => {
    const best = stats?.best_score;
    // Own-account only: in View As, userId is the ADMIN's — reading or
    // advancing their last-seen-best during a preview would be a lie.
    if (isPreview || !userId || best == null) {
      if (isPreview) setBarMoved(null);
      return;
    }
    const key = `ti_activity_lastbest:${userId}`;
    const raw = tryGet(key);
    const old = raw == null ? null : Number(raw);
    if (old != null && Number.isFinite(old) && best > old) setBarMoved({ old, now: best });
    if (old == null || !Number.isFinite(old) || best > old) trySet(key, String(best));
  }, [isPreview, userId, stats?.best_score]);

  const { display: scoreDisplay } = useCountUp(latest?.score ?? 0, reduced);

  const dotStatus: PanelStatus | undefined = !latest
    ? undefined
    : statsQuery.isLoading
      ? undefined
      : daysSinceLatest <= 60 && stats?.avg_score != null && latest.score >= stats.avg_score
        ? "good"
        : "warn";

  const openRetake = () => {
    setReviewTake(null);
    setRetakeOpen(true);
  };

  const blockStyle = (i: number) => ({ animationDelay: `${i * 60}ms` });

  const ticks =
    latest && stats
      ? (
          [
            stats.avg_score != null
              ? {
                  label: `AVG ${stats.avg_score.toFixed(1)}`,
                  value: stats.avg_score,
                  color: "var(--warning)",
                  glow: false,
                }
              : null,
            stats.best_score != null
              ? {
                  label: `BEST ${stats.best_score}`,
                  value: stats.best_score,
                  color: "var(--kombat-gold)",
                  glow: true,
                }
              : null,
            next
              ? { label: `NEXT ${next.min}`, value: next.min, color: "var(--neon)", glow: false }
              : null,
          ] as Array<{ label: string; value: number; color: string; glow: boolean } | null>
        ).filter(
          (t): t is { label: string; value: number; color: string; glow: boolean } => t !== null,
        )
      : [];

  const myRank = !isPreview ? (stats?.my_rank ?? null) : null;
  const isChampion = myRank === 1;
  const behindBest =
    latest && stats?.best_score != null && stats.best_score > latest.score
      ? stats.best_score - latest.score
      : null;

  const vpjSaid = latest?.answers?.["visits_per_jip"];
  const prevCustSaid = latest?.answers?.["prev_customers_week"];

  let body: ReactNode;
  if (resolving || (!subjectId && !isPreview) || (subjectId && testsQuery.isLoading)) {
    body = (
      <div className="space-y-4">
        <ArcadeSkeleton className="h-40" />
        <ArcadeSkeleton className="h-28" />
        <ArcadeSkeleton className="h-32" />
      </div>
    );
  } else if (!subjectId) {
    body = (
      <p className="text-xs text-muted-foreground">
        Can&apos;t resolve who&apos;s being previewed.
      </p>
    );
  } else if (testsQuery.isError) {
    body = (
      <p className="text-sm text-warning">
        Couldn&apos;t load the Activity Test — check your connection and reopen.
      </p>
    );
  } else if (missingMigration) {
    body = (
      <p className="text-xs text-muted-foreground">
        Activity Test is warming up — check back shortly.
      </p>
    );
  } else if (!latest || !scored || !tier) {
    body = (
      <div className="flex flex-col items-center gap-4 py-6 text-center">
        <FighterSilhouette className="h-24 w-24" />
        <div className="font-display text-sm uppercase tracking-widest text-muted-foreground">
          Unranked Fighter
        </div>
        <p className="text-xs text-muted-foreground">
          22 questions · 3 minutes. Your fighter card builds itself.
        </p>
        {canWrite ? (
          <span className={cn("w-full max-w-xs", !reduced && "pulse-glow-wrapper")}>
            <button
              type="button"
              onClick={openRetake}
              className="arcade-btn-3d h-14 w-full font-display text-sm uppercase tracking-widest"
              style={{ "--btn-color": "var(--kombat-gold)" } as CSSProperties}
            >
              Enter the Test
            </button>
          </span>
        ) : (
          <p className="rounded border border-warning/40 bg-warning/5 p-3 text-xs text-warning">
            {isPreview
              ? "No take on file for this rep — the test can only be taken from their own account."
              : "Sign-in is still settling — reopen to start the test."}
          </p>
        )}
      </div>
    );
  } else {
    const TierIcon = TIER_ICONS[tier.icon] ?? Shield;
    body = (
      <div className="space-y-4">
        {/* ── BLOCK 1 · HERO ─────────────────────────────────────────────── */}
        <div
          className="section-enter min-w-0 rounded-xl border border-kombat-gold/40 bg-[color-mix(in_oklab,var(--kombat-gold)_7%,var(--surface))] p-5"
          style={blockStyle(0)}
        >
          <div className="flex flex-wrap items-start justify-between gap-3">
            <div className="min-w-0">
              <div className="font-display text-[10px] uppercase tracking-widest text-kombat-gold/80">
                Power Level · Tidal Activity Test
              </div>
              <div className="mt-1.5 font-display text-4xl leading-none tabular-nums text-kombat-gold sm:text-5xl">
                {Math.round(scoreDisplay)}
                <span className="text-lg text-muted-foreground"> / {MAX_SCORE}</span>
              </div>
              {prevTake && (
                <div className="mt-2">
                  <DeltaChip now={latest.score} base={prevTake.score} label="vs last take" />
                </div>
              )}
            </div>
            <div className="flex shrink-0 flex-col items-end gap-2">
              <Popover>
                <PopoverTrigger asChild>
                  <button
                    type="button"
                    className="inline-flex items-center gap-1.5 rounded border px-2.5 py-1 font-display text-[10px] uppercase tracking-widest"
                    style={{
                      color: tier.color,
                      borderColor: `color-mix(in oklab, ${tier.color} 45%, transparent)`,
                      background: `color-mix(in oklab, ${tier.color} 10%, transparent)`,
                      boxShadow: `0 0 12px -2px color-mix(in oklab, ${tier.color} 60%, transparent)`,
                    }}
                  >
                    <TierIcon className="h-3 w-3" />
                    {tier.label}
                  </button>
                </PopoverTrigger>
                <PopoverContent
                  align="end"
                  className="w-64 border-border bg-surface/95 p-3 backdrop-blur"
                >
                  <div
                    className="font-display text-[9px] uppercase tracking-widest"
                    style={{ color: tier.color }}
                  >
                    {tier.label} · {tier.min}–{tier.max} pts
                  </div>
                  {next ? (
                    <p className="mt-1.5 text-xs text-muted-foreground">
                      Next rung · {next.label} at {next.min} —{" "}
                      <span className="text-kombat-gold">+{next.min - latest.score} pts</span>
                    </p>
                  ) : (
                    <p className="mt-1.5 text-xs text-muted-foreground">Top of the ladder.</p>
                  )}
                  {stats?.best_score != null &&
                    TEST_TIERS.filter((t) => t.min > (stats.best_score ?? 0)).map((t) => (
                      <p
                        key={t.key}
                        className="mt-1.5 font-display text-[9px] uppercase tracking-widest text-kombat-gold"
                      >
                        No fighter holds {t.label} — claim it
                      </p>
                    ))}
                </PopoverContent>
              </Popover>
              {myRank != null && stats && (
                <div className="text-right">
                  <div className="font-display text-[10px] uppercase tracking-widest text-muted-foreground">
                    Rank
                  </div>
                  <div className="mt-0.5 font-display text-2xl tabular-nums">
                    {isChampion && (
                      <Crown
                        className="mr-1.5 inline h-6 w-6 text-kombat-gold"
                        aria-label="Champion"
                      />
                    )}
                    #{myRank}
                    <span className="text-sm text-muted-foreground"> / {stats.n}</span>
                  </div>
                </div>
              )}
            </div>
          </div>

          {/* VS screen */}
          <div className="mt-4 grid w-full grid-cols-[1fr_auto_1fr] items-center gap-3">
            <div className="min-w-0">
              <div className="relative grid h-16 place-items-center rounded-lg border border-kombat-gold/50 bg-[color-mix(in_oklab,var(--kombat-gold)_10%,transparent)] md:h-20">
                <span className="font-display text-xl text-kombat-gold">
                  {initialsOf(displayName)}
                </span>
                {verified && (
                  <span className="absolute right-1 top-1 -rotate-[8deg] rounded border-2 border-kombat-red px-1 font-display text-[8px] uppercase text-kombat-red opacity-90">
                    Field-Verified
                  </span>
                )}
              </div>
              <div className="mt-1 text-center font-display text-[9px] uppercase tracking-widest text-muted-foreground">
                You · {latest.score}
              </div>
            </div>
            <div
              className="font-display text-2xl text-kombat-red"
              style={{
                textShadow: "0 0 14px color-mix(in oklab, var(--kombat-red) 70%, transparent)",
              }}
            >
              VS
            </div>
            <div className="min-w-0">
              <div className="grid h-16 place-items-center rounded-lg border border-kombat-red/50 bg-[color-mix(in_oklab,var(--kombat-red)_8%,transparent)] md:h-20">
                <FighterSilhouette className="h-10 w-10 md:h-12 md:w-12" />
              </div>
              <div className="mt-1 text-center font-display text-[9px] uppercase tracking-widest text-muted-foreground">
                Team Best · {stats?.best_score ?? "—"}
              </div>
            </div>
          </div>
          {barMoved && (
            <div className="mt-2 text-center font-display text-[10px] uppercase tracking-widest text-warning">
              The bar moved · {barMoved.old} → {barMoved.now}
            </div>
          )}

          {/* Level bar + team ticks */}
          <div className="relative">
            <NeonBar pct={latest.score / MAX_SCORE} accent="var(--kombat-gold)" />
            {ticks.length > 0 && (
              <div className="pointer-events-none absolute inset-x-0 bottom-0 h-4">
                {ticks.map((t) => (
                  <div
                    key={t.label}
                    className="absolute bottom-0 h-full w-[2px]"
                    style={{
                      left: `calc(${(t.value / MAX_SCORE) * 100}% - 1px)`,
                      background: t.color,
                      boxShadow: t.glow ? `0 0 6px ${t.color}` : undefined,
                    }}
                  >
                    <span className="absolute bottom-full left-1/2 mb-0.5 hidden -translate-x-1/2 whitespace-nowrap font-display text-[9px] uppercase text-muted-foreground md:block">
                      {t.label}
                    </span>
                  </div>
                ))}
              </div>
            )}
          </div>
          {ticks.length > 0 && (
            <div className="mt-1.5 flex flex-wrap gap-x-3 gap-y-1 md:hidden">
              {ticks.map((t) => (
                <span
                  key={t.label}
                  className="inline-flex items-center gap-1.5 font-display text-[9px] uppercase text-muted-foreground"
                >
                  <span className="h-2 w-[2px]" style={{ background: t.color }} />
                  {t.label}
                </span>
              ))}
            </div>
          )}

          <div className="mt-2 font-display text-[10px] uppercase tracking-widest text-muted-foreground">
            {isChampion ? (
              <span className="inline-flex items-center gap-1.5 text-kombat-gold">
                Top power level on the floor <Crown className="h-3 w-3" />
              </span>
            ) : (
              <>
                {next && (
                  <span>
                    +{next.min - latest.score} pts to {next.label}
                  </span>
                )}
                {behindBest != null && (
                  <span>
                    {next ? " · " : ""}+{behindBest} behind team best
                  </span>
                )}
              </>
            )}
          </div>
        </div>

        {/* ── BLOCK 2 · NEXT RANK UP ─────────────────────────────────────── */}
        {gapHabits.length > 0 && (
          <div className="section-enter min-w-0" style={blockStyle(1)}>
            <div className="flex flex-wrap items-baseline justify-between gap-x-3 gap-y-1">
              <span className="font-display text-[10px] uppercase tracking-widest text-muted-foreground">
                Next Rank Up
              </span>
              <span className="font-display text-[10px] uppercase tracking-widest tabular-nums">
                {next && (
                  <span className="text-kombat-gold">+{next.min - latest.score} pts needed</span>
                )}
                <span className="text-muted-foreground">
                  {next ? " · " : ""}+{MAX_SCORE - latest.score} pts on the table
                </span>
              </span>
            </div>
            <div className="mt-2 space-y-2">
              {gapHabits.map((h) => {
                const c = adoptionOf(h.key);
                return (
                  <button
                    key={h.key}
                    type="button"
                    onClick={() => {
                      if (h.lever === "closePct" || h.lever === "sitPct") onLeverPulse?.(h.lever);
                    }}
                    className="flex min-h-11 w-full items-center gap-3 rounded-lg border border-border bg-background/40 px-3 py-2.5 text-left transition-colors hover:border-kombat-gold/40"
                  >
                    <span className="shrink-0 rounded border border-kombat-gold/50 bg-kombat-gold/10 px-1.5 py-0.5 font-display text-[10px] text-kombat-gold">
                      +{h.points} PTS
                    </span>
                    <span className="min-w-0 flex-1">
                      <span className="block font-sans text-sm line-clamp-2">{h.label}</span>
                      {h.leverNote && (
                        <span className="mt-0.5 block font-display text-[10px] uppercase tracking-wider text-muted-foreground">
                          {h.leverNote}
                        </span>
                      )}
                    </span>
                    {c != null && stats && (
                      <span className="flex shrink-0 flex-col items-end gap-1">
                        <AdoptionDots count={c} n={stats.n} />
                        <span className="text-[10px] tabular-nums text-muted-foreground">
                          {c}/{stats.n}
                        </span>
                      </span>
                    )}
                  </button>
                );
              })}
            </div>
          </div>
        )}

        {/* ── BLOCK 3 · TEAM BOSS FIGHTS ─────────────────────────────────── */}
        {stats && bosses.length > 0 && (
          <div className="section-enter min-w-0" style={blockStyle(2)}>
            <div className="font-display text-[10px] uppercase tracking-widest text-kombat-red">
              Team Boss Fights
            </div>
            <div className="mt-2 grid grid-cols-1 gap-3 md:grid-cols-3">
              {bosses.map(({ h, c }) => {
                const defeated = habitEarned(h, latest.answers?.[h.key]);
                return (
                  <div
                    key={h.key}
                    className={cn(
                      "arcade-card min-w-0 border-kombat-red/40 p-4",
                      defeated && "shadow-neon-gold",
                    )}
                  >
                    <div className="flex items-center gap-2">
                      <Skull className="h-4 w-4 shrink-0 text-kombat-red" />
                      <span className="min-w-0 truncate font-display text-[10px] uppercase tracking-widest text-kombat-red">
                        {BOSS_NAMES[h.key] ?? h.key}
                      </span>
                    </div>
                    <p className="mt-2 font-sans text-sm line-clamp-2">{h.label}</p>
                    <div className="mt-3 flex flex-wrap items-center gap-2">
                      <AdoptionDots count={c} n={stats.n} />
                      <span className="text-[10px] uppercase tabular-nums text-muted-foreground">
                        {c}/{stats.n} have beaten it
                      </span>
                    </div>
                    {defeated ? (
                      <div className="mt-3 flex items-center justify-center gap-1.5 rounded border border-kombat-gold/50 bg-kombat-gold/10 py-1.5 text-center font-display text-[10px] uppercase tracking-widest text-kombat-gold">
                        Defeated <Check className="h-3 w-3" />
                      </div>
                    ) : (
                      <button
                        type="button"
                        onClick={() => setBoss({ h, c })}
                        className="mt-3 min-h-11 w-full rounded border border-kombat-red/50 px-2 font-display text-[10px] uppercase tracking-widest text-kombat-red transition-colors hover:bg-kombat-red/10 md:min-h-9"
                      >
                        Undefeated — View Fight Plan
                      </button>
                    )}
                  </div>
                );
              })}
            </div>
            {pipelineAdoption != null && stats.n > 0 && pipelineAdoption === stats.n && (
              <p className="mt-2 font-display text-[10px] uppercase tracking-widest text-kombat-gold/80">
                Cleared by all · Pipeline Patrol {stats.n}/{stats.n} — the whole crew checks for
                reloads.
              </p>
            )}
          </div>
        )}

        {/* ── BLOCK 4 · RECEIPTS + HISTORY ───────────────────────────────── */}
        <div
          className="section-enter grid min-w-0 grid-cols-1 gap-4 md:grid-cols-2"
          style={blockStyle(3)}
        >
          <div
            id="field-receipts"
            className="min-w-0 rounded-lg border border-border bg-background/40 p-4"
          >
            <div className="font-display text-[10px] uppercase tracking-widest text-muted-foreground">
              Field Receipts · JIP Visits
            </div>
            {isPreview ? (
              <p className="mt-3 text-xs text-muted-foreground">
                Visit log is personal — hidden in preview.
              </p>
            ) : said == null ? (
              <p className="mt-3 text-xs text-muted-foreground">
                Your latest take didn&apos;t answer the weekly JIP question — retake to claim a
                number.
              </p>
            ) : jipQuery.isLoading ? (
              <ArcadeSkeleton className="mt-3 h-12" />
            ) : jipQuery.isError || logged == null ? (
              <p className="mt-3 text-xs text-warning">
                Couldn&apos;t load your visit log — check your connection.
              </p>
            ) : (
              <>
                {(() => {
                  const scale = Math.max(said, logged, 5);
                  return (
                    <div className="relative mt-6 h-2.5 w-full rounded-full bg-[color-mix(in_oklab,var(--foreground)_4%,transparent)]">
                      <div
                        className="absolute inset-y-0 left-0 rounded-full"
                        style={{
                          width: `${(logged / scale) * 100}%`,
                          background: "var(--kombat-gold)",
                          boxShadow:
                            "0 0 8px color-mix(in oklab, var(--kombat-gold) 60%, transparent)",
                        }}
                      />
                      <div className="pointer-events-none absolute inset-0 rounded-full scanlines opacity-30" />
                      <div
                        className="absolute inset-y-0 w-[2px] bg-foreground/70"
                        style={{ left: `calc(${(said / scale) * 100}% - 1px)` }}
                      >
                        <span className="absolute bottom-full left-1/2 mb-1 -translate-x-1/2 font-display text-[9px] uppercase text-muted-foreground">
                          Said
                        </span>
                      </div>
                    </div>
                  );
                })()}
                <p className="mt-2 font-mono text-[11px] tabular-nums">
                  You said {said}/wk — Turf Invaders counted {logged}
                </p>
                {logged >= said ? (
                  <p className="mt-1 flex items-center gap-1.5 font-mono text-[11px] tabular-nums text-victory">
                    <TrendingUp className="h-3.5 w-3.5 shrink-0" /> RECEIPTS +{logged - said}
                  </p>
                ) : (
                  <p className="mt-1 font-mono text-[11px] tabular-nums text-muted-foreground">
                    {said - logged} more back{said - logged === 1 ? "s" : ""} your claim
                  </p>
                )}
              </>
            )}
            {(vpjSaid != null || prevCustSaid != null) && (
              <div className="mt-3 space-y-1">
                {vpjSaid != null && (
                  <p className="text-[11px] text-muted-foreground">
                    Said {vpjSaid} per job · no telemetry yet
                  </p>
                )}
                {prevCustSaid != null && (
                  <p className="text-[11px] text-muted-foreground">
                    Said {prevCustSaid} past customers/wk · no telemetry yet
                  </p>
                )}
              </div>
            )}
          </div>

          <div className="min-w-0 rounded-lg border border-border bg-background/40 p-4">
            <div className="flex flex-wrap items-center justify-between gap-2">
              <span className="font-display text-[10px] uppercase tracking-widest text-muted-foreground">
                Rank-Up History
              </span>
              {prevTake && <DeltaChip now={latest.score} base={prevTake.score} label="vs last" />}
            </div>
            <div className="mt-3 min-w-0">
              {history.length > 0 ? (
                <>
                  <Sparkbars
                    points={history.map((t) => t.score)}
                    track={history.map(() => MAX_SCORE)}
                    accent="var(--kombat-gold)"
                    height={40}
                    labels={history.map(
                      (t) => `${formatTestedOn(t.taken_on)} · ${t.score}/${MAX_SCORE}`,
                    )}
                    onPick={(i) => {
                      const take = history[i];
                      if (take) setReviewTake(take);
                    }}
                  />
                  {history.length === 1 && (
                    <p className="mt-2 text-[10px] text-muted-foreground">
                      Retake to start your trend
                    </p>
                  )}
                </>
              ) : (
                <p className="text-[10px] text-muted-foreground">
                  No takes on this test version yet.
                </p>
              )}
            </div>
            <p className="mt-3 text-[10px] text-muted-foreground">
              Every retake is a rank-up challenge. History never deletes.
            </p>
          </div>
        </div>

        {/* ── BLOCK 5 · WHY YOU FIGHT ────────────────────────────────────── */}
        {showWhy && (
          <div className="section-enter min-w-0" style={blockStyle(4)}>
            <div className="purpose-surface rounded-lg p-4">
              {isPreview ? (
                <p className="text-sm text-[var(--purpose-ink-dim)]">
                  Personal — hidden in preview.
                </p>
              ) : quoteQuery.isLoading ? (
                <ArcadeSkeleton className="h-12" />
              ) : quote?.coreWhy ? (
                <div className="flex min-w-0 flex-col gap-1.5 md:flex-row md:items-center md:justify-between">
                  <div className="min-w-0">
                    <div className="text-[11px] uppercase tracking-[0.18em] text-[var(--purpose-ink-dim)]">
                      Why You Fight
                    </div>
                    <p className="mt-1 text-base italic leading-snug text-[var(--purpose-ink)] line-clamp-2">
                      {quote.coreWhy}
                    </p>
                    <div className="mt-0.5 text-[11px] text-[var(--purpose-ink-dim)]">
                      — your Core Why
                    </div>
                  </div>
                  {(quote.missionTitle || quote.missionTargetDate) && (
                    <div className="shrink-0 md:max-w-[40%] md:text-right">
                      {quote.missionTargetDate &&
                        (() => {
                          const d = daysBetweenISO(todayISO, quote.missionTargetDate);
                          return Number.isFinite(d) ? (
                            <span
                              className="inline-block rounded-full border px-2.5 py-1 text-[11px] tabular-nums"
                              style={{
                                borderColor: "var(--purpose-sand)",
                                color: "var(--purpose-sand)",
                              }}
                            >
                              90-DAY MISSION · {Math.max(0, d)} DAYS LEFT
                            </span>
                          ) : null;
                        })()}
                      {(quote.missionTitle || quote.missionDescription) && (
                        <p className="mt-1.5 text-sm text-[var(--purpose-tide)] line-clamp-2">
                          {[quote.missionTitle, quote.missionDescription]
                            .filter(Boolean)
                            .join(" — ")}
                        </p>
                      )}
                    </div>
                  )}
                </div>
              ) : (
                <p className="text-sm text-[var(--purpose-ink-dim)]">
                  No Why on file. Fighters with a Why outlast fighters with a quota.{" "}
                  <Link
                    to="/my-purpose"
                    className="underline underline-offset-2 hover:text-[var(--purpose-ink)]"
                  >
                    Finish My Purpose →
                  </Link>
                </p>
              )}
            </div>
            <p className="mt-1.5 font-display text-[10px] uppercase tracking-widest text-muted-foreground">
              Who the fighter fights for.
            </p>
          </div>
        )}

        {/* ── BLOCK 6 · REMATCH ──────────────────────────────────────────── */}
        <div className="section-enter min-w-0" style={blockStyle(5)}>
          <NeonButton
            tone="kombat-gold"
            disabled={capped || !canWrite}
            onClick={openRetake}
            className="w-full md:w-auto"
          >
            <Zap className="h-3.5 w-3.5" /> Rank-Up Challenge · Retake the Test
          </NeonButton>
          {isPreview ? (
            <p className="mt-2 rounded border border-warning/40 bg-warning/5 p-3 text-xs text-warning">
              Retakes are disabled while previewing{displayName ? ` ${displayName}` : ""} — a take
              here would save under your own account, not theirs.
            </p>
          ) : capped ? (
            <p className="mt-1.5 font-display text-[10px] uppercase tracking-widest tabular-nums text-muted-foreground">
              Unlocks Mon 12:01 AM PT
            </p>
          ) : daysSinceLatest > 30 ? (
            <p className="mt-1.5 font-display text-[10px] uppercase tracking-widest text-warning">
              Retake to re-rank — your card is {daysSinceLatest} days old
            </p>
          ) : null}
        </div>
      </div>
    );
  }

  return (
    <>
      <ArcadePanel
        faction="kombat"
        title="High-Performer Profile"
        status={dotStatus}
        action={
          latest ? (
            <span className="font-display text-[10px] uppercase tracking-widest text-muted-foreground">
              Tested {formatTestedOn(latest.taken_on)}
            </span>
          ) : undefined
        }
      >
        {body}
      </ArcadePanel>

      <ActivityTestSheet
        open={retakeOpen || reviewTake != null}
        onOpenChange={(o) => {
          if (!o) {
            setRetakeOpen(false);
            setReviewTake(null);
          }
        }}
        userId={userId}
        isPreview={isPreview}
        previousScore={history.length > 0 ? history[history.length - 1].score : null}
        bestBefore={history.length > 0 ? Math.max(...history.map((t) => t.score)) : null}
        coreWhy={!isPreview ? (quote?.coreWhy ?? null) : null}
        review={reviewTake}
      />

      {/* Boss briefing — the fight plan behind UNDEFEATED. */}
      <Sheet open={boss != null} onOpenChange={(o) => !o && setBoss(null)}>
        <SheetContent aria-describedby={undefined}>
          {boss && (
            <>
              <SheetHeader>
                <SheetTitle className="flex items-center gap-2 font-display text-xs uppercase tracking-widest text-kombat-red">
                  <Skull className="h-4 w-4 shrink-0" />
                  {BOSS_NAMES[boss.h.key] ?? boss.h.key}
                </SheetTitle>
              </SheetHeader>
              <div className="min-h-0 overflow-y-auto px-4 pb-6">
                <p className="mt-2 font-sans text-base">{boss.h.label}</p>
                <p className="mt-2 text-sm text-muted-foreground">
                  {boss.h.leverNote || "The high performers skip this one."}
                </p>
                <NeonBar
                  pct={stats && stats.n > 0 ? boss.c / stats.n : 0}
                  accent="var(--kombat-red)"
                />
                {stats && (
                  <p className="mt-1.5 text-[10px] uppercase tabular-nums text-muted-foreground">
                    {boss.c}/{stats.n} of the floor have beaten it
                  </p>
                )}
                <p className="mt-3 font-display text-[10px] uppercase tracking-widest text-muted-foreground">
                  Self-reported — the test takes your word for it.
                </p>
                <div className="mt-5">
                  {canWrite && !capped ? (
                    <NeonButton
                      tone="kombat-gold"
                      onClick={() => {
                        setBoss(null);
                        openRetake();
                      }}
                      className="w-full"
                    >
                      <Zap className="h-3.5 w-3.5" /> Rank-Up Challenge
                    </NeonButton>
                  ) : (
                    <p className="font-display text-[10px] uppercase tracking-widest tabular-nums text-muted-foreground">
                      {capped
                        ? "Challenge unlocks Mon 12:01 AM PT"
                        : "Retakes are disabled in preview."}
                    </p>
                  )}
                </div>
              </div>
            </>
          )}
        </SheetContent>
      </Sheet>
    </>
  );
}
