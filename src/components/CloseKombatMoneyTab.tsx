import { useEffect, useMemo, useState } from "react";
import { ArcadePanel, ArcadeCard } from "@/components/arcade";
import { Input } from "@/components/ui/input";
import { Button } from "@/components/ui/button";
import { toast } from "sonner";
import { ChevronDown, ChevronUp, Wallet } from "lucide-react";
import {
  useRepCommissionNotes,
  useSaveCommissionNote,
  type RepCommissionNote,
} from "@/hooks/useRepCommissionNotes";
import type { MyDeal } from "@/components/CloseKombat";
import { laTodayISO } from "@/lib/dates";

/**
 * The rep-facing Money tab (owner request 2026-09-17): a self-tracked
 * commission scratchpad, NOT synced from Monday.com's Builder Accounts board
 * — that board holds a rep's whole history with no per-paycheck grouping and
 * numbers that shift daily as bids/finance fees land. Instead the rep enters
 * their own approximate commission per deal, toggles whether it's going out
 * on the next paycheck, and edits in the exact payout once actually paid.
 * Every figure here is explicitly the rep's own estimate — never presented
 * as an official payroll number, never read by the pay engine.
 */

const fmtMoney = (n: number) =>
  new Intl.NumberFormat("en-US", {
    style: "currency",
    currency: "USD",
    maximumFractionDigits: 0,
  }).format(n);

function noteFor(notes: RepCommissionNote[], id: string): RepCommissionNote | null {
  return notes.find((n) => n.monday_item_id === id) ?? null;
}

export function CloseKombatMoneyTab({
  repId,
  deals,
  rangeLabel,
  rangeStart,
  rangeEnd,
}: {
  repId: string | undefined;
  /** The same "My Deals" rows Close Kombat already computes — Money only
   *  ever shows SOLD deals (reloads included — a sold outcome flag). */
  deals: MyDeal[];
  rangeLabel: string;
  rangeStart: string;
  rangeEnd: string;
}) {
  const notesQuery = useRepCommissionNotes(repId);
  const saveNote = useSaveCommissionNote(repId);
  const notes = useMemo(() => notesQuery.data ?? [], [notesQuery.data]);
  const [openId, setOpenId] = useState<string | null>(null);

  const soldDeals = useMemo(() => deals.filter((d) => d.outcome === "sold"), [deals]);

  const totals = useMemo(() => {
    let nextPaycheck = 0;
    let pending = 0;
    let paid = 0;
    for (const n of notes) {
      if (n.paid_at) {
        if (n.paid_at >= rangeStart && n.paid_at <= rangeEnd) paid += n.actual_amount ?? 0;
        continue;
      }
      if (n.next_payroll) nextPaycheck += n.estimated_amount ?? 0;
      else if (n.estimated_amount != null) pending += n.estimated_amount;
    }
    return { nextPaycheck, pending, paid };
  }, [notes, rangeStart, rangeEnd]);

  return (
    <ArcadePanel
      faction="kombat"
      title="Money"
      action={
        <span className="text-[10px] font-display uppercase tracking-widest text-muted-foreground">
          Your estimates
        </span>
      }
    >
      <div className="space-y-5">
        <div className="grid grid-cols-3 gap-3">
          <MoneyTile
            label="Next Paycheck"
            value={fmtMoney(totals.nextPaycheck)}
            accent="var(--kombat-gold)"
          />
          <MoneyTile label="Pending" value={fmtMoney(totals.pending)} accent="var(--neon)" />
          <MoneyTile
            label={`Paid · ${rangeLabel}`}
            value={fmtMoney(totals.paid)}
            accent="var(--victory)"
          />
        </div>

        <p className="text-[10px] text-muted-foreground">
          These are YOUR estimates, not an official payroll figure — track what you expect per deal,
          mark it for the next paycheck, then edit in the exact payout once you're actually paid.
        </p>

        {soldDeals.length === 0 ? (
          <p className="text-sm text-muted-foreground">No sold deals in this range yet.</p>
        ) : (
          <ul className="space-y-2">
            {soldDeals.map((d) => {
              const note = noteFor(notes, d.id);
              return (
                <MoneyDealRow
                  key={d.id}
                  d={d}
                  note={note}
                  open={openId === d.id}
                  onToggle={() => setOpenId((v) => (v === d.id ? null : d.id))}
                  onSave={(patch) =>
                    saveNote.mutate(
                      { monday_item_id: d.id, ...patch },
                      {
                        onError: (e: Error) => toast.error(e.message),
                      },
                    )
                  }
                  saving={saveNote.isPending}
                />
              );
            })}
          </ul>
        )}
      </div>
    </ArcadePanel>
  );
}

function MoneyTile({ label, value, accent }: { label: string; value: string; accent: string }) {
  return (
    <div
      className="rounded-lg border p-3"
      style={{
        borderColor: `color-mix(in oklab, ${accent} 40%, var(--border))`,
        background: `color-mix(in oklab, ${accent} 6%, var(--surface))`,
      }}
    >
      <div className="text-[9px] font-display uppercase tracking-widest text-muted-foreground">
        {label}
      </div>
      <div className="mt-1 font-display text-lg tabular-nums" style={{ color: accent }}>
        {value}
      </div>
    </div>
  );
}

function chipFor(note: RepCommissionNote | null): { label: string; className: string } {
  if (!note) return { label: "Add estimate", className: "text-muted-foreground" };
  if (note.paid_at) {
    return {
      label: `${fmtMoney(note.actual_amount ?? 0)} paid ${note.paid_at}`,
      className: "text-victory",
    };
  }
  if (note.estimated_amount == null)
    return { label: "Add estimate", className: "text-muted-foreground" };
  return {
    label: note.next_payroll
      ? `${fmtMoney(note.estimated_amount)} est. · Next payroll`
      : `${fmtMoney(note.estimated_amount)} est.`,
    className: note.next_payroll ? "text-kombat-gold" : "text-neon",
  };
}

function MoneyDealRow({
  d,
  note,
  open,
  onToggle,
  onSave,
  saving,
}: {
  d: MyDeal;
  note: RepCommissionNote | null;
  open: boolean;
  onToggle: () => void;
  onSave: (patch: {
    estimated_amount?: number | null;
    actual_amount?: number | null;
    next_payroll?: boolean;
    paid_at?: string | null;
  }) => void;
  saving: boolean;
}) {
  const chip = chipFor(note);
  const [estDraft, setEstDraft] = useState(String(note?.estimated_amount ?? ""));
  const [actualDraft, setActualDraft] = useState(String(note?.actual_amount ?? ""));

  useEffect(() => {
    setEstDraft(String(note?.estimated_amount ?? ""));
    setActualDraft(String(note?.actual_amount ?? ""));
  }, [note?.estimated_amount, note?.actual_amount]);

  const saveEstimate = () => {
    const n = Number(estDraft);
    onSave({ estimated_amount: Number.isFinite(n) && n > 0 ? n : null });
  };
  const toggleNextPayroll = () => {
    onSave({ next_payroll: !note?.next_payroll });
  };
  const markPaid = () => {
    const n = Number(actualDraft);
    if (!Number.isFinite(n) || n <= 0) {
      toast.error("Enter the actual payout first");
      return;
    }
    onSave({ actual_amount: n, paid_at: laTodayISO(), next_payroll: false });
  };

  return (
    <ArcadeCard faction="kombat" className="p-0 overflow-hidden">
      <button
        type="button"
        onClick={onToggle}
        className="flex w-full items-center gap-2 p-3 text-left min-h-11"
      >
        <span className="min-w-0 flex-1">
          <span className="block truncate text-sm font-medium">{d.name ?? "(unnamed card)"}</span>
          <span className="text-[10px] text-muted-foreground">
            {d.date ?? "no date"}
            {d.price != null && d.price > 0 ? ` · Sale ${fmtMoney(d.price)}` : ""}
          </span>
        </span>
        <span className={`shrink-0 text-xs tabular-nums ${chip.className}`}>{chip.label}</span>
        {open ? (
          <ChevronUp className="w-4 h-4 shrink-0 text-muted-foreground" />
        ) : (
          <ChevronDown className="w-4 h-4 shrink-0 text-muted-foreground" />
        )}
      </button>
      {open && (
        <div className="space-y-3 border-t border-border/40 p-3">
          <div className="flex items-end gap-2">
            <label className="block flex-1">
              <div className="mb-1 text-[10px] font-display uppercase tracking-widest text-muted-foreground">
                Your estimate
              </div>
              <Input
                type="number"
                min={0}
                step={10}
                inputMode="numeric"
                value={estDraft}
                onChange={(e) => setEstDraft(e.target.value)}
                className="h-10"
                placeholder="0"
              />
            </label>
            <Button size="sm" disabled={saving} onClick={saveEstimate}>
              Save
            </Button>
          </div>
          <button
            type="button"
            onClick={toggleNextPayroll}
            disabled={saving || !note?.estimated_amount}
            className={`min-h-11 w-full rounded-md border px-3 py-2 text-[10px] font-display uppercase tracking-widest transition-colors ${
              note?.next_payroll
                ? "border-kombat-gold bg-kombat-gold/15 text-kombat-gold"
                : "border-border text-muted-foreground hover:text-foreground"
            }`}
          >
            {note?.next_payroll ? "On next payroll ✓" : "Add to next payroll"}
          </button>
          <div className="flex items-end gap-2 border-t border-border/40 pt-3">
            <label className="block flex-1">
              <div className="mb-1 text-[10px] font-display uppercase tracking-widest text-muted-foreground">
                Actual payout {note?.paid_at ? `(paid ${note.paid_at})` : ""}
              </div>
              <Input
                type="number"
                min={0}
                step={10}
                inputMode="numeric"
                value={actualDraft}
                onChange={(e) => setActualDraft(e.target.value)}
                className="h-10"
                placeholder="0"
              />
            </label>
            <Button size="sm" variant="secondary" disabled={saving} onClick={markPaid}>
              Mark Paid
            </Button>
          </div>
        </div>
      )}
    </ArcadeCard>
  );
}
