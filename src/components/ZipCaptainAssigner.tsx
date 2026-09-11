// Captain-first ZIP assignment form (owner ask 2026-09-11): pick the captain,
// then list the ZIP codes for them — the two sections are the owner's exact
// words. Complements the map flow (Assign ZIPs → tap a boundary); this one is
// for dispatch mornings where the ZIP list is already known. Admin tier only.

import { useMemo, useState } from "react";
import { Plus, Send, X } from "lucide-react";
import { ArcadePanel } from "@/components/arcade";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { assigneeColor, initials } from "@/lib/assignee-colors";
import type { AssignableCaptain } from "@/components/AssignZipSheet";
import type { ZipAssignmentRow } from "@/hooks/useZipAssignments";
import { toast } from "sonner";

export function ZipCaptainAssigner({
  captains,
  assignments,
  saving,
  onAssign,
}: {
  captains: AssignableCaptain[];
  assignments: ZipAssignmentRow[];
  saving: boolean;
  /** Batch-assign; resolves on commit so the staged list only clears on success. */
  onAssign: (zips: string[], captainId: string) => Promise<unknown>;
}) {
  const [captainId, setCaptainId] = useState<string | null>(null);
  const [entry, setEntry] = useState("");
  const [staged, setStaged] = useState<string[]>([]);

  const byZip = useMemo(() => new Map(assignments.map((r) => [r.zip, r])), [assignments]);
  const countByCaptain = useMemo(() => {
    const m = new Map<string, number>();
    for (const r of assignments) m.set(r.captain_id, (m.get(r.captain_id) ?? 0) + 1);
    return m;
  }, [assignments]);

  const selected = captains.find((c) => c.id === captainId) ?? null;
  const firstName = selected?.display_name.trim().split(/\s+/)[0] ?? "";

  // Everything staged that isn't already this captain's gets written.
  const toWrite = useMemo(
    () => staged.filter((z) => byZip.get(z)?.captain_id !== captainId),
    [staged, byZip, captainId],
  );

  function addFromEntry() {
    const raw = entry.trim();
    if (!raw) return;
    const tokens = raw.split(/[^\d]+/).filter(Boolean);
    const good = tokens.filter((t) => /^\d{5}$/.test(t));
    const bad = tokens.filter((t) => !/^\d{5}$/.test(t));
    if (bad.length > 0) {
      toast.error(`ZIP codes are 5 digits — skipped: ${bad.join(", ")}`);
    }
    if (good.length > 0) {
      setStaged((prev) => [...new Set([...prev, ...good])]);
    }
    setEntry("");
  }

  async function submit() {
    if (!captainId || toWrite.length === 0) return;
    await onAssign(toWrite, captainId);
    setStaged([]);
  }

  return (
    <ArcadePanel title="Assign ZIPs to a Captain">
      <div className="space-y-5">
        {/* ---- Section 1 ---- */}
        <div className="space-y-2.5">
          <div className="font-display text-[10px] uppercase tracking-widest text-neon">
            Assigning to captain
          </div>
          {captains.length === 0 ? (
            <div className="text-sm text-muted-foreground">
              No captains on the roster yet — promote one in Manage Players first.
            </div>
          ) : (
            <div className="flex flex-wrap gap-2">
              {captains.map((c) => {
                const color = assigneeColor(c.id);
                const active = captainId === c.id;
                const owned = countByCaptain.get(c.id) ?? 0;
                return (
                  <button
                    key={c.id}
                    type="button"
                    onClick={() => setCaptainId(active ? null : c.id)}
                    className="flex min-h-11 items-center gap-2 rounded-full border px-3 py-1.5"
                    style={{
                      borderColor: active ? color : "var(--border)",
                      background: active
                        ? `color-mix(in oklab, ${color} 16%, var(--surface))`
                        : "var(--surface)",
                      boxShadow: active ? `0 0 12px -3px ${color}` : "none",
                    }}
                  >
                    <span
                      className="flex h-7 w-7 shrink-0 items-center justify-center rounded-full font-display text-[9px]"
                      style={{
                        background: `color-mix(in oklab, ${color} 25%, var(--surface))`,
                        color,
                        border: `1px solid ${color}`,
                      }}
                    >
                      {initials(c.display_name)}
                    </span>
                    <span className="text-left">
                      <span className="block text-sm leading-tight">{c.display_name}</span>
                      <span className="block text-[9px] uppercase tracking-widest text-muted-foreground leading-tight">
                        {owned} ZIP{owned === 1 ? "" : "s"}
                        {c.office_location ? ` · ${c.office_location}` : ""}
                      </span>
                    </span>
                  </button>
                );
              })}
            </div>
          )}
        </div>

        {/* ---- Section 2 ---- */}
        <div className="space-y-2.5">
          <div className="font-display text-[10px] uppercase tracking-widest text-neon">
            ZIP codes you want assigned to that captain
          </div>
          <form
            onSubmit={(e) => {
              e.preventDefault();
              addFromEntry();
            }}
            className="flex items-center gap-2"
          >
            <Input
              value={entry}
              onChange={(e) => setEntry(e.target.value)}
              placeholder="92008, 92117…"
              aria-label="ZIP codes to assign"
              className="w-52"
            />
            <Button type="submit" variant="outline" disabled={!entry.trim()} className="gap-1.5">
              <Plus className="w-3.5 h-3.5" /> Add
            </Button>
          </form>
          <div className="text-[10px] uppercase tracking-widest text-muted-foreground">
            Type or paste ZIPs (commas or spaces), then Add — or tap ZIPs on the map above.
          </div>

          {staged.length > 0 && (
            <div className="flex flex-wrap gap-1.5">
              {staged.map((z) => {
                const current = byZip.get(z);
                const theirs = !!captainId && current?.captain_id === captainId;
                const movingFrom =
                  current && current.captain_id !== captainId
                    ? (current.captain?.display_name ?? "another captain")
                    : null;
                return (
                  <span
                    key={z}
                    className="inline-flex items-center gap-1 rounded-full border border-border bg-surface px-2.5 py-1 text-xs"
                  >
                    <span className="font-mono tabular-nums">{z}</span>
                    {theirs && (
                      <span className="text-[9px] uppercase tracking-widest text-muted-foreground">
                        already theirs
                      </span>
                    )}
                    {movingFrom && (
                      <span className="text-[9px] uppercase tracking-widest text-[#ffd60a]">
                        from {movingFrom}
                      </span>
                    )}
                    <button
                      type="button"
                      aria-label={`Remove ZIP ${z}`}
                      onClick={() => setStaged((prev) => prev.filter((x) => x !== z))}
                      className="text-muted-foreground hover:text-destructive"
                    >
                      <X className="h-3 w-3" />
                    </button>
                  </span>
                );
              })}
            </div>
          )}

          <Button
            onClick={() => void submit()}
            disabled={!captainId || toWrite.length === 0 || saving}
            className="gap-2 bg-victory text-black hover:bg-victory/90 font-display uppercase tracking-widest text-[11px]"
          >
            <Send className="w-3.5 h-3.5" />
            {saving
              ? "Assigning…"
              : !captainId
                ? "Pick a captain first"
                : toWrite.length === 0
                  ? "Add ZIP codes above"
                  : `Assign ${toWrite.length} ZIP${toWrite.length === 1 ? "" : "s"} to ${firstName}`}
          </Button>
        </div>
      </div>
    </ArcadePanel>
  );
}
