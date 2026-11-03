import { useMemo } from "react";
import { useQuery } from "@tanstack/react-query";
import { format } from "date-fns";
import { Download } from "lucide-react";
import { supabase } from "@/integrations/supabase/client";
import { ArcadePanel, MobileCardList, MobileCard, MobileCardHeader } from "@/components/arcade";
import { Button } from "@/components/ui/button";
import { nextMonthStartISO } from "@/lib/dates";
import { csvCell, downloadCsvFile } from "@/lib/csv";
import { cn } from "@/lib/utils";
import { BONUS_TIER_LABELS, type RepBonusJob, type RepBonusTierName } from "@/lib/rep-bonus";

/**
 * Double Up / Triple Up payroll panel (owner, 2026-11-03): the sales-rep
 * daily bonuses — $500 for 2+ jobs ≥ $20k in a day, $1,000 for 3+ jobs
 * ≥ $30k (best tier only) — with the date and the jobs behind each one, so
 * payroll can pay them. Rows come from rep_day_bonuses, materialized by the
 * recompute pass (rep-bonus.server.ts); the jobs breakdown is embedded on
 * the row, so payroll roles never need block_cards access. Informational /
 * export-only: sales reps have no pay lines in the weekly engine, so this
 * table (or its CSV) IS the payroll output.
 */

type BonusRow = {
  id: string;
  bonus_date: string;
  rep_name: string;
  tier: RepBonusTierName;
  amount: number;
  job_count: number;
  volume: number;
  status: "pending" | "locked" | "cancelled";
  jobs: RepBonusJob[];
};

const fmtMoney = (n: number) =>
  new Intl.NumberFormat("en-US", {
    style: "currency",
    currency: "USD",
    maximumFractionDigits: 2,
  }).format(n);

const fmtDay = (iso: string) => format(new Date(`${iso}T00:00:00`), "EEE MMM d");

const STATUS_CHIP: Record<BonusRow["status"], { label: string; className: string }> = {
  pending: { label: "Pending", className: "text-warning" },
  locked: { label: "Locked", className: "text-victory" },
  cancelled: { label: "Removed", className: "text-destructive" },
};

export function RepBonusPanel({ monthStart }: { monthStart: string }) {
  const { data, isLoading, isError } = useQuery({
    queryKey: ["rep-day-bonuses", monthStart],
    queryFn: async (): Promise<BonusRow[]> => {
      const { data, error } = await supabase
        .from("rep_day_bonuses")
        .select("id, bonus_date, rep_name, tier, amount, job_count, volume, status, jobs")
        .gte("bonus_date", monthStart)
        .lt("bonus_date", nextMonthStartISO(monthStart))
        .order("bonus_date")
        .order("rep_name");
      if (error) throw error;
      return (data ?? []) as unknown as BonusRow[];
    },
  });

  const rows = useMemo(() => data ?? [], [data]);
  // Cancelled rows stay visible (payroll must see a bonus was REMOVED, not
  // wonder where it went) but never count in the total owed.
  const totalOwed = useMemo(
    () => rows.filter((r) => r.status !== "cancelled").reduce((s, r) => s + Number(r.amount), 0),
    [rows],
  );
  const monthLabel = format(new Date(`${monthStart}T00:00:00`), "MMMM yyyy");

  function exportCsv() {
    const lines = [
      ["Date", "Rep", "Bonus", "Amount ($)", "Jobs", "Day Volume ($)", "Status", "Job Detail"].join(
        ",",
      ),
    ];
    for (const r of rows) {
      lines.push(
        [
          r.bonus_date,
          r.rep_name,
          BONUS_TIER_LABELS[r.tier],
          Number(r.amount).toFixed(2),
          r.job_count,
          Number(r.volume).toFixed(2),
          STATUS_CHIP[r.status].label,
          (r.jobs ?? [])
            .map(
              (j) =>
                `${j.customer ?? "(unnamed)"} $${Number(j.share).toFixed(2)} of $${Number(j.card_total).toFixed(2)}`,
            )
            .join("; "),
        ]
          .map(csvCell)
          .join(","),
      );
    }
    downloadCsvFile(`rep-bonuses-${monthStart.slice(0, 7)}.csv`, lines);
  }

  return (
    <ArcadePanel
      title={`Double Up / Triple Up · ${monthLabel}`}
      action={
        <div className="flex items-center gap-3">
          <span className="font-display text-xs text-victory">OWED · {fmtMoney(totalOwed)}</span>
          <Button
            size="sm"
            variant="outline"
            onClick={exportCsv}
            disabled={rows.length === 0}
            className="h-8"
          >
            <Download className="w-3.5 h-3.5 mr-1" /> CSV
          </Button>
        </div>
      }
    >
      <div className="text-xs text-muted-foreground mb-3">
        Sales-rep daily bonuses: $500 for 2+ jobs totaling $20k+ in a day, $1,000 for 3+ jobs
        totaling $30k+ (best tier only — never both). Shared jobs count each rep's split share.
        Pending rows follow the boards until the month's cancel window passes, then lock; a
        cancellation that breaks a day shows as Removed. Not wired into the weekly pay engine — this
        table is the payroll figure.
      </div>
      {isLoading ? (
        <div className="text-sm text-muted-foreground">Loading bonuses…</div>
      ) : isError ? (
        <div className="text-sm text-destructive">
          Couldn't load bonuses — check your connection and reload. Do not treat this as $0 owed.
        </div>
      ) : rows.length === 0 ? (
        <div className="text-sm text-muted-foreground">
          No Double Up / Triple Up days this month.
        </div>
      ) : (
        <>
          <MobileCardList>
            {rows.map((r) => {
              const chip = STATUS_CHIP[r.status];
              return (
                <MobileCard key={r.id}>
                  <MobileCardHeader
                    left={`${r.rep_name} · ${fmtDay(r.bonus_date)}`}
                    right={
                      <span
                        className={cn(
                          r.status === "cancelled"
                            ? "text-muted-foreground line-through"
                            : "text-victory",
                        )}
                      >
                        {fmtMoney(Number(r.amount))}
                      </span>
                    }
                  />
                  <div className="text-xs text-muted-foreground tabular-nums">
                    {BONUS_TIER_LABELS[r.tier]} · {r.job_count} jobs · {fmtMoney(Number(r.volume))}{" "}
                    day volume · <span className={chip.className}>{chip.label}</span>
                  </div>
                  <ul className="mt-1.5 space-y-0.5 text-xs text-muted-foreground">
                    {(r.jobs ?? []).map((j) => (
                      <li key={j.monday_item_id} className="flex justify-between gap-2">
                        <span className="truncate">{j.customer ?? "(unnamed)"}</span>
                        <span className="shrink-0 tabular-nums">
                          {fmtMoney(Number(j.share))}
                          {Number(j.share) !== Number(j.card_total) &&
                            ` of ${fmtMoney(Number(j.card_total))}`}
                        </span>
                      </li>
                    ))}
                  </ul>
                </MobileCard>
              );
            })}
          </MobileCardList>
          <div className="hidden md:block overflow-x-auto">
            <table className="w-full text-sm">
              <thead>
                <tr className="text-[10px] font-display uppercase tracking-widest text-muted-foreground border-b border-border">
                  <th className="text-left py-2 pr-3">Date</th>
                  <th className="text-left py-2 pr-3">Rep</th>
                  <th className="text-left py-2 pr-3">Bonus</th>
                  <th className="text-left py-2 pr-3">Jobs</th>
                  <th className="text-right py-2 pr-3">Day Volume ($)</th>
                  <th className="text-left py-2 pr-3">Status</th>
                  <th className="text-right py-2 pr-1">Amount ($)</th>
                </tr>
              </thead>
              <tbody>
                {rows.map((r) => {
                  const chip = STATUS_CHIP[r.status];
                  return (
                    <tr
                      key={r.id}
                      className="border-b border-border/40 align-top transition-colors duration-200 hover:bg-surface-elevated"
                    >
                      <td className="py-2.5 pr-3 whitespace-nowrap">{fmtDay(r.bonus_date)}</td>
                      <td className="py-2.5 pr-3 font-medium">{r.rep_name}</td>
                      <td className="py-2.5 pr-3 whitespace-nowrap">{BONUS_TIER_LABELS[r.tier]}</td>
                      <td className="py-2.5 pr-3">
                        <ul className="space-y-0.5 text-xs text-muted-foreground">
                          {(r.jobs ?? []).map((j) => (
                            <li key={j.monday_item_id} className="tabular-nums">
                              {j.customer ?? "(unnamed)"} — {fmtMoney(Number(j.share))}
                              {Number(j.share) !== Number(j.card_total) &&
                                ` of ${fmtMoney(Number(j.card_total))}`}
                            </li>
                          ))}
                        </ul>
                      </td>
                      <td className="py-2.5 pr-3 text-right font-display tabular-nums">
                        {fmtMoney(Number(r.volume))}
                      </td>
                      <td className={cn("py-2.5 pr-3 text-xs", chip.className)}>{chip.label}</td>
                      <td
                        className={cn(
                          "py-2.5 pr-1 text-right font-display",
                          r.status === "cancelled"
                            ? "text-muted-foreground line-through"
                            : "text-victory",
                        )}
                      >
                        {fmtMoney(Number(r.amount))}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
              <tfoot>
                <tr className="border-t border-neon/40">
                  <td
                    colSpan={6}
                    className="py-3 text-right text-[10px] font-display uppercase tracking-widest text-muted-foreground"
                  >
                    Total owed (pending + locked)
                  </td>
                  <td className="py-3 pr-1 text-right font-display text-victory">
                    {fmtMoney(totalOwed)}
                  </td>
                </tr>
              </tfoot>
            </table>
          </div>
        </>
      )}
    </ArcadePanel>
  );
}
