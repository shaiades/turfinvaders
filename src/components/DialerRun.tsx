import { useMemo, useState } from "react";
import {
  Clock3,
  MessageCircle,
  PhoneCall,
  PhoneMissed,
  Sparkles,
  ThumbsDown,
  Trophy,
  Undo2,
} from "lucide-react";
import { useAuth } from "@/hooks/useAuth";
import { ArcadePanel, ArcadeStatTile, NeonBar } from "@/components/arcade";
import { PiggyBankHUD } from "@/components/PiggyBankHUD";
import { NextDollarChip, RankChip } from "@/components/MoneyChips";
import { FieldStandingsSheet } from "@/components/FieldStandingsSheet";
import { useCallLogs, usePhonePiggy } from "@/hooks/useCallLogs";
import { sumLogCounters, useTodayLogs } from "@/hooks/useDailyLogs";
import { CALL_RESULTS, nextCombo, type CallDisposition } from "@/lib/dialer";
import { haptic } from "@/lib/arcade-fx";
import { useCountUp } from "@/hooks/useCountUp";
import { usePrefersReducedMotion } from "@/hooks/usePrefersReducedMotion";
import { cn, formatCurrency } from "@/lib/utils";

/**
 * Dial Run — the confirmation department's Active Run (owner mandate
 * 2026-10-19: same game, no map). One giant DIAL button logs the call the
 * moment it's placed; five outcome chips tag it; the call_logs trigger lands
 * every dial in daily_logs as a knock, so the ladder, the wrap, Fleet
 * Dispatch and the piggy all count phone production with the door
 * vocabulary. Leads are tallied here but WORKED on the Monday board
 * (rehash/reconfirmed/scheduled, source "room") — the webhook owns lead
 * credit, same doctrine as the field.
 */

const CHIP_ICONS: Record<string, React.ReactNode> = {
  not_home: <PhoneMissed className="h-4 w-4" />,
  talked_to: <MessageCircle className="h-4 w-4" />,
  go_back: <Clock3 className="h-4 w-4" />,
  not_interested: <ThumbsDown className="h-4 w-4" />,
  lead: <Sparkles className="h-4 w-4" />,
};

function CountBadge({ count, color }: { count: number; color: string }) {
  if (count <= 0) return null;
  return (
    <span
      aria-hidden
      className="pointer-events-none absolute -top-1.5 -right-1.5 min-w-5 rounded-full border bg-surface px-1.5 text-center text-xs font-bold leading-5"
      style={{ color, borderColor: color }}
    >
      {count}
    </span>
  );
}

export function DialerRun() {
  const { user } = useAuth();
  const userId = user?.id;
  const reduced = usePrefersReducedMotion();

  const calls = useCallLogs(userId);
  const piggy = usePhonePiggy(userId);
  const todayLogs = useTodayLogs(userId);
  const totals = useMemo(() => sumLogCounters(todayLogs.data), [todayLogs.data]);

  const [standingsOpen, setStandingsOpen] = useState(false);
  // Talk combo (ActiveRun Phase 4 §4, phone-tuned): tagged conversations
  // chain, a no-answer breaks the run, a bare dial holds it. Pure hype.
  const [combo, setCombo] = useState(0);
  // Coin burst re-fire on LEAD (PiggyBankHUD celebrate prop; 0 dollars =
  // coins only, never a fabricated number).
  const [celebrate, setCelebrate] = useState<{ seq: number; dollars: number } | null>(null);

  // Tallies merge both truths and converge: session rows are instant,
  // daily_logs is the ledger every other board reads. Leads converge to the
  // Monday webhook's credit (leads_called_in) — the tap counts on screen the
  // moment it lands so the tally always keeps up with the rep.
  const sessionTalks =
    (calls.counts.talked_to ?? 0) +
    (calls.counts.go_back ?? 0) +
    (calls.counts.lead ?? 0) +
    (calls.counts.not_interested ?? 0);
  const dials = piggy.dials;
  const talks = Math.max(totals.people_talked_to, sessionTalks);
  const leads = Math.max(totals.leads_called_in, calls.counts.lead ?? 0);
  const callbacks = calls.counts.go_back ?? 0;

  const { display: dialDisplay, bump: dialBump } = useCountUp(dials, reduced);

  const registerResult = (d: CallDisposition) => {
    setCombo((c) => {
      const next = nextCombo(c, d);
      if (next >= 3 && next > c) haptic([10, 30, 10, 30, 10]);
      return next;
    });
  };

  const onDial = () => {
    calls.logCall.mutate({ id: crypto.randomUUID(), disposition: "knock" });
  };

  // A bare dial waiting for its verdict? The chip UPGRADES it (same-day
  // correction mechanics, RLS-fenced). Otherwise the chip is its own one-tap
  // call — dial + outcome in one.
  const pendingDial = calls.lastCall?.disposition === "knock" ? calls.lastCall : undefined;
  const onOutcome = (d: CallDisposition) => {
    if (pendingDial) calls.tagCall.mutate({ id: pendingDial.id, disposition: d });
    else calls.logCall.mutate({ id: crypto.randomUUID(), disposition: d });
    registerResult(d);
    if (d === "lead") setCelebrate((p) => ({ seq: (p?.seq ?? 0) + 1, dollars: 0 }));
  };

  const undoTarget = calls.lastCall;

  return (
    <div className="mx-auto flex w-full max-w-xl flex-col gap-3 md:gap-4 lg:max-w-5xl">
      {/* Rank + nearest-dollar chips (self-positioned, Active Run parity) */}
      <div className="relative min-h-14">
        <RankChip userId={userId} onOpen={() => setStandingsOpen(true)} />
        <NextDollarChip userId={userId} />
      </div>

      <div className="grid grid-cols-1 gap-3 md:gap-4 lg:grid-cols-2 lg:items-start">
        {/* ── The dial pad ─────────────────────────────────────────────── */}
        <section className="arcade-card relative p-4 md:p-5">
          {combo >= 2 && (
            <div
              aria-live="polite"
              className="absolute -top-3 left-1/2 z-10 -translate-x-1/2 whitespace-nowrap rounded-full border border-[var(--warning)] bg-surface px-3 py-1 text-xs font-bold uppercase text-[var(--warning)]"
            >
              🔥 {combo} talks in a row
            </div>
          )}

          <div data-tour="phones-dial" className="pulse-glow-wrapper relative w-full">
            <button
              type="button"
              onClick={onDial}
              aria-label={`Log a dial — ${dials} dials today`}
              className="arcade-btn-3d flex min-h-24 w-full items-center justify-center gap-3 px-4 md:min-h-28"
              style={{
                ["--btn-color" as string]: "var(--neon)",
                ["--btn-fg" as string]: "#041014",
              }}
            >
              <PhoneCall className="h-8 w-8" />
              <span className="font-display text-2xl uppercase tracking-widest md:text-3xl">
                Dial
              </span>
              <span
                className={cn(
                  "font-display text-2xl tabular-nums md:text-3xl",
                  dialBump && !reduced && "scale-110 transition-transform duration-200",
                )}
              >
                {Math.round(dialDisplay)}
              </span>
            </button>
          </div>

          <div
            className={cn(
              "mt-2 text-center text-xs font-semibold uppercase",
              pendingDial ? "text-neon" : "text-muted-foreground",
            )}
            aria-live="polite"
          >
            {pendingDial
              ? "Tag that dial — how did it end?"
              : "Tap DIAL when you place the call, tag it when it ends"}
          </div>

          {/* Outcome chips — the door picker's phone vocabulary */}
          <div data-tour="phones-chips" className="mt-3 grid grid-cols-5 gap-1.5">
            {CALL_RESULTS.map((r) => (
              <button
                key={r.type}
                type="button"
                aria-label={`${r.fullLabel} — tag the call`}
                onClick={() => onOutcome(r.type)}
                className={cn(
                  "relative flex min-h-14 flex-col items-center justify-center gap-1 rounded-xl border px-1 py-2",
                  pendingDial ? "border-current" : "border-border",
                )}
                style={{
                  color: r.color,
                  background: `color-mix(in oklab, ${r.color} ${pendingDial ? 14 : 7}%, var(--surface))`,
                }}
              >
                {CHIP_ICONS[r.type]}
                <span className="text-[10px] font-semibold uppercase leading-tight">
                  {r.chipLabel}
                </span>
                <CountBadge count={calls.counts[r.type] ?? 0} color={r.color} />
              </button>
            ))}
          </div>

          <div className="mt-3 flex items-center justify-between gap-2">
            <button
              type="button"
              disabled={!undoTarget}
              onClick={() => undoTarget && calls.undoLast.mutate(undoTarget.id)}
              className="flex min-h-11 items-center gap-1.5 rounded-full border border-border px-3 text-xs font-semibold uppercase text-muted-foreground disabled:opacity-40"
            >
              <Undo2 className="h-4 w-4" /> Undo last
            </button>
            <span className="text-right text-[11px] text-muted-foreground">
              Leads get worked on the Monday board — this tally is your score.
            </span>
          </div>
        </section>

        {/* ── The scoreboard ───────────────────────────────────────────── */}
        <div className="flex flex-col gap-3 md:gap-4">
          <ArcadePanel
            title="Today's Numbers"
            status="good"
            action={
              <button
                type="button"
                aria-label="Open standings"
                onClick={() => setStandingsOpen(true)}
                className="flex min-h-11 items-center gap-1.5 rounded-full border border-neon/60 px-3 text-xs font-semibold uppercase text-neon md:min-h-8"
              >
                <Trophy className="h-4 w-4" /> Standings
              </button>
            }
          >
            <div className="grid grid-cols-2 gap-px overflow-hidden rounded-lg border border-border bg-border md:grid-cols-4">
              <ArcadeStatTile flat label="Dials" value={dials} accent="neon" />
              <ArcadeStatTile flat label="Talks" value={talks} accent="accent" />
              <ArcadeStatTile flat label="Leads" value={leads} accent="victory" />
              <ArcadeStatTile flat label="Callbacks" value={callbacks} accent="warning" />
            </div>
            <p className="mt-3 text-xs text-muted-foreground">
              Dials count as knocks everywhere — same ladder, same wrap, same charts.
            </p>
          </ArcadePanel>

          <div data-tour="phones-bank">
            <PiggyBankHUD
              variant="card"
              unit="dials"
              dollars={piggy.dollars}
              perKnock={piggy.perDial}
              knocks={piggy.dials}
              paceKnocks={piggy.paceDials}
              source={piggy.source}
              celebrate={celebrate}
            />
          </div>

          <div data-tour="phones-goal">
            <ArcadePanel title="Goal Engine" status={piggy.paceDials === 0 ? "good" : "warn"}>
              <div className="flex items-baseline justify-between gap-2">
                <span className="text-xs font-semibold uppercase text-muted-foreground">
                  Week goal
                </span>
                <span className="font-display text-lg tabular-nums text-victory">
                  {formatCurrency(Math.round(piggy.weekEarned))}
                  <span className="text-muted-foreground">
                    {" "}
                    / {formatCurrency(Math.round(piggy.weeklyGoal))}
                  </span>
                </span>
              </div>
              <NeonBar
                pct={piggy.weeklyGoal > 0 ? piggy.weekEarned / piggy.weeklyGoal : 0}
                accent="var(--victory)"
                sheen
              />
              <p className="mt-3 text-xs text-muted-foreground">
                {piggy.paceDials === null
                  ? "Set your income goal in Mission → Plan and the engine back-solves it into dials per day."
                  : piggy.paceDials === 0
                    ? "Week goal covered — every dial from here is gravy. 🏆"
                    : `≈${piggy.paceDials.toLocaleString()} more dials this week at your current per-dial value closes the gap.`}
              </p>
            </ArcadePanel>
          </div>
        </div>
      </div>

      <FieldStandingsSheet open={standingsOpen} onOpenChange={setStandingsOpen} />
    </div>
  );
}
