import { useMemo } from "react";
import { useQuery } from "@tanstack/react-query";
import { supabase } from "@/integrations/supabase/client";
import {
  Sheet,
  SheetContent,
  SheetDescription,
  SheetHeader,
  SheetTitle,
} from "@/components/ui/sheet";
import { History } from "lucide-react";
import { laDateTimeLabel } from "@/lib/dates";

/** Audit actions → reviewer-readable labels. */
const ACTION_LABEL: Record<string, string> = {
  insert: "Created",
  update: "Edited",
  punch_out: "Clock out",
  void: "Voided",
  auto_close: "Auto-closed",
  approve: "Approved",
  meal_insert: "Lunch punched",
  meal_update: "Lunch updated",
};

type AuditRow = {
  id: number;
  time_entry_id: string;
  happened_at: string;
  actor: string | null;
  action: string;
  reason: string | null;
  old_row: Record<string, unknown> | null;
  new_row: Record<string, unknown> | null;
};

/** The before→after fields a wage reviewer actually reads. */
const DIFF_FIELDS: Array<{ key: string; label: string; time: boolean }> = [
  { key: "clock_in", label: "Clock in", time: true },
  { key: "clock_out", label: "Clock out", time: true },
  { key: "meal_start", label: "Lunch out", time: true },
  { key: "meal_end", label: "Lunch in", time: true },
  { key: "meal_status", label: "Meal", time: false },
  { key: "second_meal_status", label: "2nd meal", time: false },
  { key: "voided_at", label: "Voided", time: true },
];

function fmtVal(v: unknown, isTime: boolean): string {
  if (v === null || v === undefined || v === "") return "—";
  if (isTime && typeof v === "string") return laDateTimeLabel(v);
  return String(v);
}

function diffLines(r: AuditRow): Array<{ label: string; from: string; to: string }> {
  if (!r.new_row) return [];
  // A creation (no old row) diffs against nothing: "— → value".
  const oldRow = r.old_row ?? {};
  const out: Array<{ label: string; from: string; to: string }> = [];
  for (const f of DIFF_FIELDS) {
    const a = oldRow[f.key];
    const b = r.new_row[f.key];
    if (a === undefined && b === undefined) continue;
    if (JSON.stringify(a ?? null) === JSON.stringify(b ?? null)) continue;
    out.push({ label: f.label, from: fmtVal(a, f.time), to: fmtVal(b, f.time) });
  }
  return out;
}

/**
 * The legal record, readable: every change to the selected time entries —
 * who, when, why, and exactly what moved (before → after, LA times). Pure
 * read of the append-only time_entry_audit; there are no actions here.
 */
export function TimeEntryAuditSheet({
  open,
  onOpenChange,
  entryIds,
  title,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  entryIds: string[];
  title: string;
}) {
  const idsKey = useMemo(() => [...entryIds].sort().join("|"), [entryIds]);

  const auditQ = useQuery({
    enabled: open && entryIds.length > 0,
    queryKey: ["time-entry-audit", idsKey],
    queryFn: async () => {
      const { data, error } = await supabase
        .from("time_entry_audit")
        .select("id, time_entry_id, happened_at, actor, action, reason, old_row, new_row")
        .in("time_entry_id", entryIds)
        .order("happened_at", { ascending: false })
        .limit(200);
      if (error) throw error;
      const rows = (data ?? []) as AuditRow[];
      const actorIds = [...new Set(rows.map((r) => r.actor).filter(Boolean))] as string[];
      const names = new Map<string, string>();
      if (actorIds.length > 0) {
        const { data: profs } = await supabase
          .from("profiles")
          .select("id, display_name")
          .in("id", actorIds);
        for (const p of profs ?? []) names.set(p.id, p.display_name ?? "Unknown");
      }
      return { rows, names };
    },
  });

  const rows = auditQ.data?.rows ?? [];
  const names = auditQ.data?.names ?? new Map<string, string>();

  return (
    <Sheet open={open} onOpenChange={onOpenChange}>
      <SheetContent className="px-4 pb-safe">
        <SheetHeader className="text-left pt-2">
          <SheetTitle className="font-display uppercase tracking-widest text-sm flex items-center gap-2">
            <History className="w-4 h-4 text-neon" />
            {title}
          </SheetTitle>
          <SheetDescription>
            Every change, append-only: who, when, the required reason, and the before → after
            values. Times are Pacific.
          </SheetDescription>
        </SheetHeader>

        <div className="mt-4 space-y-3 overflow-y-auto pb-6">
          {auditQ.isLoading ? (
            <div className="text-sm text-muted-foreground">Loading history…</div>
          ) : rows.length === 0 ? (
            <div className="text-sm text-muted-foreground py-6 text-center">
              No recorded changes.
            </div>
          ) : (
            rows.map((r) => {
              const diffs = diffLines(r);
              return (
                <div key={r.id} className="rounded border border-border/50 bg-surface-elevated/40 p-3">
                  <div className="flex flex-wrap items-baseline justify-between gap-x-3 gap-y-1">
                    <span className="text-xs font-medium">
                      {ACTION_LABEL[r.action] ?? r.action}
                      <span className="ml-2 text-muted-foreground font-normal">
                        by {r.actor ? (names.get(r.actor) ?? "Unknown") : "System (auto)"}
                      </span>
                    </span>
                    <span className="text-[10px] text-muted-foreground tabular-nums">
                      {laDateTimeLabel(r.happened_at)}
                    </span>
                  </div>
                  {r.reason && (
                    <div className="mt-1 text-xs text-foreground/80 border-l-2 border-neon/40 pl-2">
                      “{r.reason}”
                    </div>
                  )}
                  {diffs.length > 0 && (
                    <div className="mt-2 space-y-0.5">
                      {diffs.map((d, i) => (
                        <div key={i} className="text-[11px] tabular-nums">
                          <span className="text-muted-foreground">{d.label}:</span>{" "}
                          <span className="line-through text-muted-foreground/70">{d.from}</span>
                          {" → "}
                          <span className="text-foreground">{d.to}</span>
                        </div>
                      ))}
                    </div>
                  )}
                </div>
              );
            })
          )}
        </div>
      </SheetContent>
    </Sheet>
  );
}
