// Tidal Activity Test — the retake flow (and read-only review of a past
// take). One question per screen, neutral equal buttons so the sheet can't
// leak scoring direction (reverse-scored habits render NO lever line), draft
// in localStorage so a dropped connection never eats 21 answers. The reveal
// runs INSIDE the sheet: red progress bar flips gold, the score counts up
// with a coin blip per point, then (when a Core Why exists) a 2s navy
// purpose-surface beat before closing. Every fx path is one-shot and gated
// by prefers-reduced-motion → static score + toast instead.

import { useEffect, useMemo, useRef, useState, type CSSProperties } from "react";
import { ChevronLeft } from "lucide-react";
import { toast } from "sonner";
import { Sheet, SheetContent, SheetHeader, SheetTitle } from "@/components/ui/sheet";
import { NeonBar, NeonButton } from "@/components/arcade";
import { cn } from "@/lib/utils";
import { usePrefersReducedMotion } from "@/hooks/usePrefersReducedMotion";
import { useCountUp } from "@/hooks/useCountUp";
import { makeBeeper, popText } from "@/components/intro-fx";
import { rewardToast } from "@/lib/reward-toast";
import { useInsertActivityTest, type ActivityTestRow } from "@/hooks/useActivityTests";
import { TEST_TIERS, tierForScore } from "@/lib/activity-test";
import {
  ACTIVITY_QUESTIONS,
  HABITS,
  MAX_SCORE,
  type ActivityQuestionDef,
  type HabitDef,
} from "@/data/activity-test-content";

type QuizItem =
  | { kind: "habit"; key: string; habit: HabitDef }
  | { kind: "activity"; key: string; activity: ActivityQuestionDef };

// Form order: the 19 habits, then the 3 activity questions = 22 rounds.
const QUIZ: QuizItem[] = [
  ...HABITS.map((h) => ({ kind: "habit" as const, key: h.key, habit: h })),
  ...ACTIVITY_QUESTIONS.map((q) => ({ kind: "activity" as const, key: q.key, activity: q })),
];
const TOTAL = QUIZ.length;

const draftKey = (uid: string | undefined) => `ti_activity_draft:${uid ?? "anon"}`;

function readDraft(uid: string | undefined): Record<string, string> {
  try {
    const raw = window.localStorage.getItem(draftKey(uid));
    const parsed = raw ? (JSON.parse(raw) as unknown) : null;
    return parsed && typeof parsed === "object" ? (parsed as Record<string, string>) : {};
  } catch {
    return {};
  }
}

function writeDraft(uid: string | undefined, answers: Record<string, string>) {
  try {
    window.localStorage.setItem(draftKey(uid), JSON.stringify(answers));
  } catch {
    /* private mode — the in-memory answers still submit */
  }
}

function clearDraft(uid: string | undefined) {
  try {
    window.localStorage.removeItem(draftKey(uid));
  } catch {
    /* best effort */
  }
}

/** THPS-style "RANK UP" callout drawn with the shared intro-fx popText —
 *  a short raf loop on a transparent canvas, one-shot. */
function RankUpPop({ label }: { label: string }) {
  const ref = useRef<HTMLCanvasElement>(null);
  useEffect(() => {
    const canvas = ref.current;
    if (!canvas) return;
    const dpr = window.devicePixelRatio || 1;
    const w = canvas.clientWidth;
    const h = canvas.clientHeight;
    canvas.width = Math.max(1, Math.round(w * dpr));
    canvas.height = Math.max(1, Math.round(h * dpr));
    const ctx = canvas.getContext("2d");
    if (!ctx) return;
    ctx.scale(dpr, dpr);
    const start = performance.now();
    let raf = 0;
    const draw = (now: number) => {
      const t = now - start;
      ctx.clearRect(0, 0, w, h);
      popText(ctx, label, w / 2, h / 2 + 8, 0, t, Math.min(24, w / 16), "#ffd24a", "#ffb02a");
      if (t < 900) raf = requestAnimationFrame(draw);
    };
    raf = requestAnimationFrame(draw);
    return () => cancelAnimationFrame(raf);
  }, [label]);
  return (
    <canvas
      ref={ref}
      aria-hidden
      className="pointer-events-none absolute inset-x-0 top-8 h-20 w-full"
    />
  );
}

const CONFETTI_COLORS = ["var(--kombat-gold)", "var(--kombat-red)", "#ffffff"];

const quizButton =
  "min-h-14 w-full rounded-lg border bg-background/40 px-4 text-sm font-sans text-left transition-colors";
const quizSelected = "border-foreground/60 bg-background/70";
const quizIdle = "border-border hover:border-foreground/30";

export function ActivityTestSheet({
  open,
  onOpenChange,
  userId,
  isPreview,
  previousScore,
  bestBefore,
  coreWhy,
  review = null,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  userId: string | undefined;
  isPreview: boolean;
  /** Latest same-version score BEFORE this attempt — tier-cross + flat/lower verdicts. */
  previousScore: number | null;
  /** Best same-version score BEFORE this attempt — personal-best verdict. */
  bestBefore: number | null;
  /** The rep's own Core Why (null = skip the final beat). */
  coreWhy: string | null;
  /** When set, render this take read-only — no quiz, no submit. */
  review?: ActivityTestRow | null;
}) {
  const reduced = usePrefersReducedMotion();
  const insert = useInsertActivityTest(userId, isPreview);

  const [answers, setAnswers] = useState<Record<string, string>>({});
  const [idx, setIdx] = useState(0);
  const [phase, setPhase] = useState<"quiz" | "reveal" | "why">("quiz");
  const [finalScore, setFinalScore] = useState(0);
  const [revealTarget, setRevealTarget] = useState(0);
  const [rankUpLabel, setRankUpLabel] = useState<string | null>(null);
  const [personalBest, setPersonalBest] = useState(false);

  const advanceTimer = useRef(0);
  const revealTimer = useRef(0);
  const whyTimer = useRef(0);
  const beep = useRef<ReturnType<typeof makeBeeper> | null>(null);
  const lastBeeped = useRef(0);

  // Restore the draft (or reset) each time the sheet opens.
  useEffect(() => {
    if (!open) return;
    setPhase("quiz");
    setRevealTarget(0);
    setFinalScore(0);
    setRankUpLabel(null);
    setPersonalBest(false);
    lastBeeped.current = 0;
    if (review) return;
    const draft = readDraft(userId);
    setAnswers(draft);
    const first = QUIZ.findIndex((q) => draft[q.key] === undefined);
    setIdx(first === -1 ? TOTAL : first);
  }, [open, review, userId]);

  useEffect(() => {
    if (open) return;
    window.clearTimeout(advanceTimer.current);
    window.clearTimeout(revealTimer.current);
    window.clearTimeout(whyTimer.current);
  }, [open]);
  useEffect(
    () => () => {
      window.clearTimeout(advanceTimer.current);
      window.clearTimeout(revealTimer.current);
      window.clearTimeout(whyTimer.current);
    },
    [],
  );

  const answered = useMemo(
    () => QUIZ.reduce((n, q) => n + (answers[q.key] !== undefined ? 1 : 0), 0),
    [answers],
  );
  const allAnswered = answered >= TOTAL;

  const { display } = useCountUp(revealTarget, reduced);
  const shown = Math.floor(display + 1e-6);
  // Coin blip per point while the reveal counts up (shared AudioContext —
  // construct the beeper once; reduced motion skips entirely).
  useEffect(() => {
    if (phase !== "reveal" || reduced) return;
    if (shown > lastBeeped.current) {
      beep.current ??= makeBeeper();
      beep.current(620 + shown * 16, 45);
      lastBeeped.current = shown;
    }
  }, [shown, phase, reduced]);

  const confetti = useMemo(
    () =>
      Array.from({ length: 24 }, (_, i) => ({
        left: 4 + Math.random() * 92,
        dx: Math.round(Math.random() * 80 - 40),
        delay: Math.round(Math.random() * 500),
        color: CONFETTI_COLORS[i % CONFETTI_COLORS.length],
      })),
    // Re-roll per rank-up reveal, not per render.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [rankUpLabel],
  );

  const pick = (key: string, value: string) => {
    setAnswers((a) => {
      const next = { ...a, [key]: value };
      writeDraft(userId, next);
      return next;
    });
    window.clearTimeout(advanceTimer.current);
    advanceTimer.current = window.setTimeout(() => setIdx((i) => Math.min(i + 1, TOTAL)), 150);
  };

  const beginReveal = (score: number) => {
    setFinalScore(score);
    setPhase("reveal");
    const prevTier = previousScore != null ? tierForScore(previousScore) : null;
    const tier = tierForScore(score);
    const crossed =
      prevTier != null &&
      TEST_TIERS.findIndex((t) => t.key === tier.key) >
        TEST_TIERS.findIndex((t) => t.key === prevTier.key);
    const isBest = bestBefore != null && score > bestBefore;
    setRankUpLabel(crossed ? tier.label : null);
    setPersonalBest(isBest);
    if (isBest) rewardToast("NEW PERSONAL BEST", { description: `${score}/${MAX_SCORE}` });
    else if (previousScore == null) toast("Logged — your fighter card is live");
    else if (score <= previousScore) toast("Logged — your card is current");
    // Hand the count-up its target a beat after the 0 renders so it tweens.
    window.setTimeout(() => setRevealTarget(score), 50);
    revealTimer.current = window.setTimeout(() => {
      if (coreWhy) {
        setPhase("why");
        whyTimer.current = window.setTimeout(() => onOpenChange(false), 2000);
      } else {
        onOpenChange(false);
      }
    }, 2500);
  };

  const submit = () => {
    if (!allAnswered || insert.isPending || isPreview) return;
    insert.mutate(answers, {
      onSuccess: (score) => {
        clearDraft(userId);
        beginReveal(score);
      },
      onError: (e: Error) => toast.error(e.message),
    });
  };

  const q = idx < TOTAL ? QUIZ[idx] : null;
  const flatOrLower = phase === "reveal" && previousScore != null && finalScore <= previousScore;
  const revealTier = tierForScore(finalScore);

  return (
    <Sheet open={open} onOpenChange={onOpenChange}>
      <SheetContent aria-describedby={undefined} className="h-[92dvh] max-h-[92dvh]">
        <SheetHeader>
          <SheetTitle className="font-display text-xs uppercase tracking-widest text-kombat-gold">
            {review
              ? `Take · ${review.score}/${review.max_score} · ${review.taken_on}`
              : "Tidal Activity Test"}
          </SheetTitle>
        </SheetHeader>

        {review ? (
          <div className="min-h-0 flex-1 overflow-y-auto px-5 pb-8">
            <div className="mx-auto w-full max-w-md space-y-5 pt-4">
              {QUIZ.map((item) => {
                const a = review.answers?.[item.key];
                const options = item.kind === "habit" ? ["yes", "no"] : item.activity.options;
                return (
                  <div key={item.key} className="min-w-0">
                    <p className="text-sm font-sans">
                      {item.kind === "habit" ? item.habit.label : item.activity.label}
                    </p>
                    <div className="mt-2 flex flex-wrap gap-2">
                      {options.map((o) => (
                        <span
                          key={o}
                          className={cn(
                            "rounded border px-2.5 py-1 text-xs font-sans",
                            a === o
                              ? "border-foreground/60 bg-background/70 text-foreground"
                              : "border-border text-muted-foreground/60",
                          )}
                        >
                          {item.kind === "habit" ? (o === "yes" ? "Yes" : "No") : o}
                        </span>
                      ))}
                      {a === undefined && (
                        <span className="self-center text-[10px] text-muted-foreground">
                          No answer recorded
                        </span>
                      )}
                    </div>
                  </div>
                );
              })}
            </div>
          </div>
        ) : (
          <>
            <div className="px-5 pt-1">
              <div className="flex items-center justify-between gap-3">
                <button
                  type="button"
                  onClick={() => setIdx((i) => Math.max(0, i - 1))}
                  disabled={idx === 0 || phase !== "quiz"}
                  aria-label="Previous question"
                  className="inline-flex min-h-11 min-w-11 items-center justify-center rounded-md border border-border text-muted-foreground transition-colors hover:text-foreground disabled:opacity-40 md:min-h-9 md:min-w-9"
                >
                  <ChevronLeft className="h-4 w-4" />
                </button>
                <span className="font-mono text-xs tabular-nums text-muted-foreground">
                  ROUND {Math.min(answered + 1, TOTAL)} / {TOTAL}
                </span>
              </div>
              {/* The rail: red while fighting, gold the moment the score lands. */}
              <NeonBar
                pct={phase === "quiz" ? answered / TOTAL : display / MAX_SCORE}
                accent={phase === "quiz" ? "var(--kombat-red)" : "var(--kombat-gold)"}
              />
            </div>

            {phase === "quiz" && (
              <div className="min-h-0 flex-1 overflow-y-auto px-5 pb-8">
                <div className="mx-auto w-full max-w-md pt-8">
                  {q ? (
                    <>
                      <p className="text-base font-sans md:text-lg">
                        {q.kind === "habit" ? q.habit.label : q.activity.label}
                      </p>
                      {q.kind === "habit" ? (
                        <div className="mt-5 flex flex-col gap-3">
                          {(["yes", "no"] as const).map((v) => (
                            <button
                              key={v}
                              type="button"
                              onClick={() => pick(q.key, v)}
                              className={cn(
                                quizButton,
                                answers[q.key] === v ? quizSelected : quizIdle,
                              )}
                            >
                              {v === "yes" ? "Yes" : "No"}
                            </button>
                          ))}
                        </div>
                      ) : (
                        <div className="mt-5 flex flex-wrap gap-3">
                          {q.activity.options.map((o) => (
                            <button
                              key={o}
                              type="button"
                              onClick={() => pick(q.key, o)}
                              className={cn(
                                "min-h-11 min-w-11 rounded-lg border bg-background/40 px-4 text-sm font-sans tabular-nums transition-colors",
                                answers[q.key] === o ? quizSelected : quizIdle,
                              )}
                            >
                              {o}
                            </button>
                          ))}
                        </div>
                      )}
                      {q.kind === "habit" && q.habit.leverNote && (
                        <p className="mt-5 font-display text-[10px] uppercase tracking-widest text-muted-foreground">
                          {q.habit.leverNote}
                        </p>
                      )}
                    </>
                  ) : (
                    <div className="pt-6 text-center">
                      <p className="font-display text-sm uppercase tracking-widest text-kombat-gold">
                        All {TOTAL} answered
                      </p>
                      <p className="mt-3 text-xs text-muted-foreground">
                        Your answers score the moment you submit. History never deletes.
                      </p>
                      {isPreview && (
                        <p className="mt-4 rounded border border-warning/40 bg-warning/5 p-3 text-left text-xs text-warning">
                          Submitting is disabled while previewing — a take here would save under
                          your own account.
                        </p>
                      )}
                      <NeonButton
                        tone="kombat-gold"
                        disabled={!allAnswered || insert.isPending || isPreview}
                        onClick={submit}
                        className="mt-6 w-full"
                      >
                        {insert.isPending ? "SCORING…" : "SUBMIT — REVEAL POWER LEVEL"}
                      </NeonButton>
                    </div>
                  )}
                </div>
              </div>
            )}

            {phase !== "quiz" && (
              <div className="relative min-h-0 flex-1 overflow-hidden px-5 pb-8">
                {rankUpLabel && !reduced && (
                  <>
                    <RankUpPop label={`RANK UP · ${rankUpLabel}`} />
                    <div
                      aria-hidden
                      className="pointer-events-none absolute inset-0 overflow-hidden"
                    >
                      {confetti.map((c, i) => (
                        <span
                          key={i}
                          className="confetti-piece"
                          style={
                            {
                              left: `${c.left}%`,
                              background: c.color,
                              animationDelay: `${c.delay}ms`,
                              "--dx": `${c.dx}px`,
                            } as CSSProperties
                          }
                        />
                      ))}
                    </div>
                  </>
                )}
                <div className="flex h-full flex-col items-center justify-center text-center">
                  <div
                    className={cn(
                      "rounded-xl border border-kombat-gold/40 bg-[color-mix(in_oklab,var(--kombat-gold)_7%,var(--surface))] px-10 py-6",
                      personalBest && "kombat-kaching",
                    )}
                  >
                    <div className="font-display text-[10px] uppercase tracking-widest text-kombat-gold/80">
                      Power Level
                    </div>
                    <div className="mt-2 font-display text-5xl tabular-nums text-kombat-gold">
                      {shown}
                      <span className="text-lg text-muted-foreground"> / {MAX_SCORE}</span>
                    </div>
                    <div className="mt-3 font-display text-[10px] uppercase tracking-widest text-muted-foreground">
                      {revealTier.label}
                    </div>
                  </div>
                  {rankUpLabel && reduced && (
                    <p className="mt-4 font-display text-xs uppercase tracking-widest text-kombat-gold">
                      RANK UP · {rankUpLabel}
                    </p>
                  )}
                  {flatOrLower && (
                    <p className="mt-4 max-w-xs text-xs text-muted-foreground">
                      Honest beats inflated — the test only works if it&apos;s true.
                    </p>
                  )}
                </div>
              </div>
            )}

            {phase === "why" && coreWhy && (
              <div className="purpose-surface absolute inset-0 z-10 flex items-center justify-center rounded-t-2xl px-8">
                <div className="max-w-md text-center">
                  <p className="text-xl italic leading-snug">{coreWhy}</p>
                  <p className="mt-4 text-[11px] uppercase tracking-[0.18em] text-[var(--purpose-ink-dim)]">
                    This is why you train
                  </p>
                </div>
              </div>
            )}
          </>
        )}
      </SheetContent>
    </Sheet>
  );
}
