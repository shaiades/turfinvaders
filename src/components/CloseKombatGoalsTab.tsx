import { useEffect, useRef, useState } from "react";
import { ArcadePanel, NeonBar } from "@/components/arcade";
import { Input } from "@/components/ui/input";
import { Button } from "@/components/ui/button";
import { toast } from "sonner";
import { Target, TrendingUp, Zap } from "lucide-react";
import { clampVolumeGoal, useRepGoal, useSaveRepGoal } from "@/hooks/useRepGoal";
import {
  backSolveVolumeGoal,
  projectedPlaybookTakeHome,
  resolveRepRates,
  type RepRatesInput,
} from "@/lib/rep-goals";
import { laTodayISO, remainingWorkdaysInWeek } from "@/lib/dates";
import type { RepStats } from "@/lib/close-kombat";

/**
 * The rep-facing Goals tab, v2 (owner, 2026-09-22): a weekly VOLUME dollar
 * goal — official Sale-$, the Kombat board's own number — reverse-engineered
 * through the rep's trailing-2-completed-weeks rates into sales/sits/appts
 * needed. Rates deliberately never come from the week in progress: the old
 * design's back-solve was empty every Monday morning, exactly when goals get
 * set. Take-home is shown ONLY as a projection via the playbook's published
 * math (~8% of volume) — never a payroll figure (piggy-bank precedent).
 *
 * Honesty gates (review 2026-09-22): a loading or failed week fetch renders
 * as loading/error, never as "$0" or "not enough history" presented as fact
 * — "data absent" and "data thin" are different claims.
 */

export type WeekStatus = "loading" | "error" | "ready";

const fmtMoney = (n: number) =>
  new Intl.NumberFormat("en-US", {
    style: "currency",
    currency: "USD",
    maximumFractionDigits: 0,
  }).format(n);

/** Ceil with an epsilon: 2/0.4 is 5.000000000000001 in floats, and a rep
 *  told "6 sits" for an exact 5 would rightly call the math broken. */
function fmtInt(n: number) {
  if (!isFinite(n)) return "—";
  return Math.max(0, Math.ceil(n - 1e-9)).toLocaleString();
}

const ceilInt = (n: number) => Math.max(0, Math.ceil(n - 1e-9));

const fmtPct = (p: number) => `${Math.round(p * 100)}%`;

function useSyncedDraft(server: number) {
  const [draft, setDraft] = useState(String(server));
  const prevServer = useRef(server);
  useEffect(() => {
    setDraft((d) => (d === String(prevServer.current) ? String(server) : d));
    prevServer.current = server;
  }, [server]);
  return [draft, setDraft] as const;
}

export function CloseKombatGoalsTab({
  userId,
  weekLabel,
  weekStatus,
  weekRow,
  trailingRow,
  trailingCompanyBaseline,
  isPreview,
  previewName,
}: {
  userId: string | undefined;
  weekLabel: string;
  /** The goals block_cards fetch state — the tab renders loading/error
   *  honestly instead of passing "$0" off as fact. */
  weekStatus: WeekStatus;
  /** This rep's own RepStats for the current Mon–Sun week (or null — nothing
   *  counted yet this week). */
  weekRow: RepStats | null;
  /** This rep's own RepStats over the 2 completed weeks before this one —
   *  the back-solve's rate source. */
  trailingRow: RepStats | null;
  /** Company-wide baseline over the same trailing window, summed from
   *  per-rep rows (split-share semantics, unfiltered by the office picker)
   *  — the fallback when the rep's own history is too thin. */
  trailingCompanyBaseline: RepRatesInput;
  /** View As is active (role !== realRole) — goal editing must be disabled:
   *  user.id stays the ADMIN's own id during a preview, so a save would
   *  silently write to the wrong profile row. */
  isPreview: boolean;
  previewName: string | null;
}) {
  const goalQuery = useRepGoal(userId);
  const saveGoal = useSaveRepGoal(userId);
  // A stored 0 reads as "no goal" (a rep clearing their target), never as a
  // $0 target with a full-width empty bar and false no-data copy.
  const storedGoal = goalQuery.data ?? null;
  const goal = storedGoal && storedGoal > 0 ? storedGoal : null;
  const [draft, setDraft] = useSyncedDraft(goal ?? 0);

  const volume = weekRow?.revenue ?? 0;
  const sales = weekRow ? weekRow.sold + weekRow.reloads : 0;
  const pct = goal && goal > 0 ? Math.min(1, volume / goal) : 0;
  const met = goal !== null && volume >= goal;

  const resolved = resolveRepRates(trailingRow, trailingCompanyBaseline);
  const solve =
    goal !== null
      ? backSolveVolumeGoal({ remainingVolume: goal - volume, rates: resolved?.rates ?? null })
      : null;
  const daysLeft = remainingWorkdaysInWeek(laTodayISO());

  const submit = () => {
    // Guard here, not just on the button: Enter in the input reaches this
    // too, and an Enter while the goal is still loading would write the
    // draft's placeholder 0 over a real stored goal.
    if (isPreview || saveGoal.isPending || goalQuery.isLoading) return;
    saveGoal.mutate(clampVolumeGoal(draft), {
      onSuccess: () => toast.success("Weekly goal saved"),
      onError: (e: Error) => toast.error(e.message),
    });
  };
  const onEnter = (e: React.KeyboardEvent) => {
    if (e.key === "Enter") submit();
  };

  return (
    <ArcadePanel
      faction="kombat"
      title="Goals"
      action={
        <span className="text-[10px] font-display uppercase tracking-widest text-muted-foreground">
          {weekLabel}
        </span>
      }
    >
      <div className="space-y-5">
        {isPreview && (
          <p className="rounded border border-warning/40 bg-warning/5 p-3 text-xs text-warning">
            Goal editing is disabled while previewing{previewName ? ` ${previewName}` : ""} — saving
            here would write to your own account, not theirs.
          </p>
        )}

        {goalQuery.isLoading ? (
          <p className="text-sm text-muted-foreground">Loading your goal…</p>
        ) : goal === null ? (
          <div className="rounded-lg border border-border bg-background/40 p-5 text-center">
            <div className="font-display text-sm uppercase tracking-widest text-muted-foreground">
              No goal set yet
            </div>
            <p className="mt-2 text-xs text-muted-foreground">
              Set a weekly volume target below and your own numbers reverse-engineer it — how many
              sales, sits, and appointments this week takes.
            </p>
          </div>
        ) : (
          <div className="rounded-lg border border-kombat-gold/40 bg-[color-mix(in_oklab,var(--kombat-gold)_7%,var(--surface))] p-5">
            {weekStatus !== "ready" ? (
              <>
                <div className="text-[10px] font-display uppercase tracking-widest text-kombat-gold/80">
                  Volume this week
                </div>
                <p
                  className={`mt-2 text-sm ${weekStatus === "loading" ? "text-muted-foreground animate-pulse" : "text-warning"}`}
                >
                  {weekStatus === "loading"
                    ? "Counting your week…"
                    : "Couldn't load this week's numbers — check your connection and reopen."}
                </p>
                <div className="mt-2 text-[10px] text-muted-foreground">
                  Goal · {fmtMoney(goal)}
                </div>
              </>
            ) : (
              <>
                <div className="flex items-baseline justify-between gap-2">
                  <div className="text-[10px] font-display uppercase tracking-widest text-kombat-gold/80">
                    Volume this week
                  </div>
                  <div className="text-[10px] text-muted-foreground">
                    {sales} sale{sales === 1 ? "" : "s"} banked
                  </div>
                </div>
                <div className="mt-1.5 font-display text-4xl text-kombat-gold tabular-nums">
                  {fmtMoney(volume)}{" "}
                  <span className="text-lg text-muted-foreground">/ {fmtMoney(goal)}</span>
                </div>
                <div className="mt-3">
                  <NeonBar pct={pct} accent="var(--kombat-gold)" />
                </div>
                {/* PROJECTED take-home — playbook math only (~20% of ~40%
                    profit ≈ 8% of volume), the piggy-bank pattern. Never
                    payroll. */}
                <div className="mt-2 flex items-baseline justify-between gap-2 text-[10px] tabular-nums">
                  <span className="text-victory">
                    ≈ {fmtMoney(projectedPlaybookTakeHome(volume))} take-home so far ·{" "}
                    {fmtMoney(projectedPlaybookTakeHome(goal))} at goal
                  </span>
                  <span className="font-display uppercase tracking-widest text-muted-foreground">
                    Projected · playbook math — not payroll
                  </span>
                </div>

                {met ? (
                  <div className="mt-3 font-display text-sm text-victory">
                    🏆 Goal hit — everything else this week is gravy.
                  </div>
                ) : solve && resolved ? (
                  <>
                    <div className="mt-4 grid grid-cols-3 gap-3">
                      <FunnelTile
                        label="Sales to go"
                        value={fmtInt(solve.salesNeeded)}
                        sub={`${fmtMoney(resolved.rates.avgDealSize)} avg deal`}
                      />
                      <FunnelTile
                        label="Sits to go"
                        value={fmtInt(solve.sitsNeeded)}
                        sub={`${fmtPct(resolved.rates.closePct)} close`}
                      />
                      <FunnelTile
                        label="Appts to go"
                        value={fmtInt(solve.apptsNeeded)}
                        sub={`${fmtPct(resolved.rates.sitPct)} sit`}
                      />
                    </div>
                    <div className="mt-2 flex items-baseline justify-between gap-2 flex-wrap text-[10px]">
                      <span className="font-display uppercase tracking-widest text-muted-foreground">
                        {resolved.source === "self"
                          ? "Your last 2 weeks"
                          : "Company avg · last 2 weeks"}
                      </span>
                      {daysLeft > 0 ? (
                        <span className="text-muted-foreground tabular-nums">
                          Pace: {fmtInt(solve.apptsNeeded / daysLeft)} appt
                          {ceilInt(solve.apptsNeeded / daysLeft) === 1 ? "" : "s"}/day over the next{" "}
                          {daysLeft} day{daysLeft === 1 ? "" : "s"}
                        </span>
                      ) : (
                        <span className="text-muted-foreground">Week wraps tonight</span>
                      )}
                    </div>
                  </>
                ) : (
                  <p className="mt-4 text-[10px] font-display uppercase tracking-widest text-muted-foreground">
                    Not enough closed history in the last 2 weeks to solve what it takes — the tiles
                    light up once there's data.
                  </p>
                )}
              </>
            )}
          </div>
        )}

        <div className="flex items-end gap-3 rounded-lg border border-border bg-background/40 p-4">
          <label className="block flex-1">
            <div className="mb-1.5 text-[10px] font-display uppercase tracking-widest text-muted-foreground">
              Weekly Volume Goal
            </div>
            <div className="relative">
              <span className="absolute left-2.5 top-1/2 -translate-y-1/2 font-display text-lg text-muted-foreground pointer-events-none">
                $
              </span>
              <Input
                type="number"
                min={0}
                step={100}
                inputMode="numeric"
                disabled={isPreview}
                value={draft}
                onChange={(e) => setDraft(e.target.value)}
                onKeyDown={onEnter}
                className="h-12 pl-7 font-display text-xl bg-background/60 text-kombat-gold border-[color-mix(in_oklab,var(--kombat-gold)_40%,var(--border))]"
                placeholder="40000"
              />
            </div>
          </label>
          <Button
            onClick={submit}
            disabled={isPreview || saveGoal.isPending || goalQuery.isLoading}
            className="h-12 px-6 font-display uppercase tracking-widest bg-kombat-gold/15 hover:bg-kombat-gold/25 text-kombat-gold border border-kombat-gold/50"
          >
            <Zap className="w-4 h-4 mr-2" /> Save
          </Button>
        </div>

        <div className="space-y-1">
          <p className="flex items-center gap-1.5 text-[10px] text-muted-foreground">
            <Target className="w-3 h-3" /> Volume counts your split Sale-$ this Mon–Sun week — the
            same number the standings rank you by.
          </p>
          <p className="flex items-center gap-1.5 text-[10px] text-muted-foreground">
            <TrendingUp className="w-3 h-3" /> Sales / sits / appts come from YOUR last 2 weeks of
            results (or the company's while yours warm up) — improve those rates and the same goal
            takes fewer appointments.
          </p>
        </div>
      </div>
    </ArcadePanel>
  );
}

function FunnelTile({ label, value, sub }: { label: string; value: string; sub: string }) {
  return (
    <div className="rounded-lg border border-border bg-background/40 p-3">
      <div className="text-[10px] font-display uppercase tracking-widest text-muted-foreground">
        {label}
      </div>
      <div className="mt-1 font-display text-2xl text-neon">{value}</div>
      <div className="mt-1 text-[10px] text-muted-foreground">{sub}</div>
    </div>
  );
}
