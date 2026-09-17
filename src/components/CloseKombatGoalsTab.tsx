import { useEffect, useRef, useState } from "react";
import { ArcadePanel, NeonBar } from "@/components/arcade";
import { Input } from "@/components/ui/input";
import { Button } from "@/components/ui/button";
import { toast } from "sonner";
import { Target, Zap } from "lucide-react";
import { clampSalesGoal, useRepGoal, useSaveRepGoal } from "@/hooks/useRepGoal";
import { backSolveRepFunnel } from "@/lib/rep-goals";
import type { RepStats } from "@/lib/close-kombat";

/**
 * The rep-facing Goals tab (owner request 2026-09-17): a weekly SALES-COUNT
 * goal — never a dollar goal, real commission visibility lives on the Money
 * tab instead and stays rep-entered, not derived from this. Back-solves
 * through this week's own closePct/sitPct (backSolveRepFunnel) — never
 * invents a number when there isn't enough data yet this week.
 */

function fmtInt(n: number) {
  if (!isFinite(n)) return "—";
  return Math.ceil(n).toLocaleString();
}

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
  weekLoading,
  weekRow,
  isPreview,
  previewName,
}: {
  userId: string | undefined;
  weekLabel: string;
  weekLoading: boolean;
  /** This rep's own RepStats for the current Mon–Sun week (or null — no
   *  resulted appt/reload/sale yet this week). */
  weekRow: RepStats | null;
  /** View As is active (role !== realRole) — goal editing must be disabled:
   *  user.id stays the ADMIN's own id during a preview, so a save would
   *  silently write to the wrong profile row. */
  isPreview: boolean;
  previewName: string | null;
}) {
  const goalQuery = useRepGoal(userId);
  const saveGoal = useSaveRepGoal(userId);
  const goal = goalQuery.data ?? null;
  const [draft, setDraft] = useSyncedDraft(goal ?? 0);

  const sales = weekRow ? weekRow.sold + weekRow.reloads : 0;
  const pct = goal && goal > 0 ? Math.min(1, sales / goal) : 0;
  const met = goal !== null && goal > 0 && sales >= goal;

  const solve =
    goal && goal > 0
      ? backSolveRepFunnel({
          salesGoal: Math.max(0, goal - sales),
          closePct: weekRow?.closePct ?? null,
          sitPct: weekRow?.sitPct ?? null,
        })
      : null;

  const submit = () => {
    if (isPreview) return;
    saveGoal.mutate(clampSalesGoal(draft), {
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

        {goal === null ? (
          <div className="rounded-lg border border-border bg-background/40 p-5 text-center">
            <div className="font-display text-sm uppercase tracking-widest text-muted-foreground">
              No goal set yet
            </div>
            <p className="mt-2 text-xs text-muted-foreground">
              Set a weekly sales target below to see your progress and what it takes to get there.
            </p>
          </div>
        ) : (
          <div className="rounded-lg border border-kombat-gold/40 bg-[color-mix(in_oklab,var(--kombat-gold)_7%,var(--surface))] p-5">
            <div className="flex items-baseline justify-between gap-2">
              <div className="text-[10px] font-display uppercase tracking-widest text-kombat-gold/80">
                Sales this week
              </div>
              <div className="text-[10px] text-muted-foreground">
                {weekLoading ? "Counting…" : `Goal · ${goal}`}
              </div>
            </div>
            <div className="mt-1.5 font-display text-4xl text-kombat-gold tabular-nums">
              {sales} <span className="text-lg text-muted-foreground">/ {goal}</span>
            </div>
            <div className="mt-3">
              <NeonBar pct={pct * 100} accent="var(--kombat-gold)" />
            </div>
            {met ? (
              <div className="mt-3 font-display text-sm text-victory">
                🏆 Goal met — everything else this week is gravy.
              </div>
            ) : solve ? (
              <div className="mt-4 grid grid-cols-2 gap-3">
                <FunnelTile
                  label="Sits still needed"
                  value={fmtInt(solve.requiredSits)}
                  sub={
                    weekRow?.closePct != null
                      ? `${Math.round(weekRow.closePct * 100)}% close this week`
                      : ""
                  }
                />
                <FunnelTile
                  label="Appts still needed"
                  value={fmtInt(solve.requiredAppts)}
                  sub={
                    weekRow?.sitPct != null
                      ? `${Math.round(weekRow.sitPct * 100)}% sit this week`
                      : ""
                  }
                />
              </div>
            ) : (
              <p className="mt-4 text-[10px] font-display uppercase tracking-widest text-muted-foreground">
                Not enough data yet this week to solve sits/appts needed.
              </p>
            )}
          </div>
        )}

        <div className="flex items-end gap-3 rounded-lg border border-border bg-background/40 p-4">
          <label className="block flex-1">
            <div className="mb-1.5 text-[10px] font-display uppercase tracking-widest text-muted-foreground">
              Weekly Sales Goal
            </div>
            <Input
              type="number"
              min={0}
              step={1}
              inputMode="numeric"
              disabled={isPreview}
              value={draft}
              onChange={(e) => setDraft(e.target.value)}
              onKeyDown={onEnter}
              className="h-12 font-display text-xl bg-background/60 text-kombat-gold border-[color-mix(in_oklab,var(--kombat-gold)_40%,var(--border))]"
              placeholder="3"
            />
          </label>
          <Button
            onClick={submit}
            disabled={isPreview || saveGoal.isPending || goalQuery.isLoading}
            className="h-12 px-6 font-display uppercase tracking-widest bg-kombat-gold/15 hover:bg-kombat-gold/25 text-kombat-gold border border-kombat-gold/50"
          >
            <Zap className="w-4 h-4 mr-2" /> Save
          </Button>
        </div>

        <p className="flex items-center gap-1.5 text-[10px] text-muted-foreground">
          <Target className="w-3 h-3" /> Counts sold + reload deals this Mon–Sun week — same total
          shown on your hero card above.
        </p>
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
      {sub && <div className="mt-1 text-[10px] text-muted-foreground">{sub}</div>}
    </div>
  );
}
