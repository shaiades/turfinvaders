import { useMemo, useState } from "react";
import { ArcadePanel } from "@/components/arcade";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { toast } from "sonner";
import {
  AlertTriangle,
  CheckCircle2,
  Clock,
  Loader2,
  MessageSquarePlus,
  Send,
  UserCheck,
  UserX,
  X,
} from "lucide-react";
import { oohOnBlockLabel, oohResultLabel, type OohQueueRow } from "@/lib/ooh";
import {
  useAttendanceOverrides,
  useDispatchWrites,
  useMissingReports,
  useOohConfig,
  useOohMutations,
  useOohQueue,
} from "@/hooks/useOohQueue";
import { useAuth } from "@/hooks/useAuth";

/**
 * OOH admin tab — the office's cockpit for the Out of House write-back.
 * - A status banner (mode / form link / auto-create).
 * - "Attendance overrides": force a rep On/Off for today — beats the Monday
 *   attendance board in live issuing + the watchdog.
 * - "Needs review" queue: unmatched or errored submissions, with Push lead,
 *   Dismiss and Mark-handled.
 * - "Dry-run previews": the plan the webhook WOULD apply (while mode = dry_run
 *   or a block isn't allow-listed yet).
 * - "Missing reports": issued leads whose appointment has passed with no
 *   report; one-tap Push lead.
 * Owner / office_staff only (the tab is admin-gated in CloseKombat).
 * Mobile-first: responsive card lists, ≥44px controls (AGENTS.md).
 */

const MODE_COPY: Record<string, { label: string; cls: string; hint: string }> = {
  off: {
    label: "OFF",
    cls: "text-muted-foreground border-border",
    hint: "Acknowledges reports but writes nothing. Flip to dry-run, then live.",
  },
  dry_run: {
    label: "DRY RUN",
    cls: "text-kombat-gold border-kombat-gold/50",
    hint: "Computes every plan into the queue below; writes nothing to Monday.",
  },
  live: {
    label: "LIVE",
    cls: "text-victory border-victory/50",
    hint: "Writing dispositions to allow-listed block boards.",
  },
};

function Chip({ children, cls = "" }: { children: React.ReactNode; cls?: string }) {
  return (
    <span
      className={`rounded-full border px-2.5 py-1 text-[10px] font-display uppercase tracking-widest ${cls}`}
    >
      {children}
    </span>
  );
}

/** Live-dispatch chip: a static badge for everyone, a tap-to-cycle toggle for
 *  the owner (off → dry run → live → off). The owner-only gate is enforced on
 *  the server too (setDispatchMode); this just hides the control. 44px tap
 *  target below md, compact above (AGENTS.md). */
const DISPATCH_CYCLE: Record<string, "off" | "dry_run" | "live"> = {
  off: "dry_run",
  dry_run: "live",
  live: "off",
};
/** What each dispatch state does (distinct from the write-back MODE_COPY hints). */
const DISPATCH_HINT: Record<string, string> = {
  off: "Not issuing — a freed rep gets no next lead.",
  dry_run: "Rehearsing: logs each next-lead decision, issues nothing on Monday.",
  live: "Live: hands each freed rep their next lead on Monday.",
};

function DispatchChip({ mode, isOwner }: { mode: string; isOwner: boolean }) {
  const { dispatchMode } = useOohMutations();
  const copy = MODE_COPY[mode] ?? MODE_COPY.off;
  if (!isOwner) return <Chip cls={copy.cls}>Dispatch: {copy.label}</Chip>;
  const next = DISPATCH_CYCLE[mode] ?? "dry_run";
  const cycle = () =>
    dispatchMode
      .mutateAsync({ mode: next })
      .then((r) => toast.success(`Dispatch → ${(MODE_COPY[r.mode] ?? MODE_COPY.off).label}`))
      .catch((e) => toast.error(String(e instanceof Error ? e.message : e)));
  return (
    <button
      type="button"
      onClick={cycle}
      disabled={dispatchMode.isPending}
      aria-label={`Dispatch mode is ${copy.label}. Tap to set ${(MODE_COPY[next] ?? MODE_COPY.off).label} (cycles off → dry run → live).`}
      title="Tap to cycle: off → dry run → live"
      className={`inline-flex min-h-11 items-center gap-1 rounded-full border px-2.5 py-1 text-[10px] font-display uppercase tracking-widest transition-colors hover:bg-foreground/10 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:opacity-60 md:min-h-0 ${copy.cls}`}
    >
      {dispatchMode.isPending && <Loader2 className="size-3 animate-spin" />}
      Dispatch: {copy.label}
    </button>
  );
}

/**
 * Push lead = give the rep their NEXT not-issued lead (#12). Pressing Iss on the
 * already-issued late/missing lead did nothing; this resolves the rep's next
 * lead first and shows its name + time for confirmation before issuing it.
 */
function PushNextLeadButton({
  boardId,
  repName,
  label = "Push lead",
  className = "",
}: {
  boardId: string | null;
  repName: string | null;
  label?: string;
  className?: string;
}) {
  const { pushLead, nextLead } = useOohMutations();
  const [confirm, setConfirm] = useState<{
    itemId: string;
    name: string;
    apptLabel: string | null;
  } | null>(null);
  const disabled = !boardId || !repName;

  const findNext = () => {
    if (!boardId || !repName) return;
    nextLead
      .mutateAsync({ boardId, repName })
      .then((n) => {
        if (!n) {
          toast.info(`No upcoming lead to issue for ${repName}.`);
          return;
        }
        setConfirm(n);
      })
      .catch((e) => toast.error(String(e instanceof Error ? e.message : e)));
  };

  const doIssue = () => {
    if (!boardId || !confirm) return;
    pushLead
      .mutateAsync({ boardId, itemId: confirm.itemId })
      .then(() => {
        toast.success(`Issued ${confirm.name} to ${repName}.`);
        setConfirm(null);
      })
      .catch((e) => toast.error(String(e instanceof Error ? e.message : e)));
  };

  if (confirm) {
    return (
      <div
        className={`flex flex-col gap-2 rounded-md border border-kombat-gold/40 bg-background/40 p-2 ${className}`}
      >
        <p className="text-xs text-foreground">
          Issue next lead to {repName}: <span className="font-medium">{confirm.name}</span>
          {confirm.apptLabel ? ` · ${confirm.apptLabel}` : ""}
        </p>
        <div className="flex gap-2">
          <Button className="min-h-11 flex-1" disabled={pushLead.isPending} onClick={doIssue}>
            {pushLead.isPending ? (
              <Loader2 className="size-4 animate-spin" />
            ) : (
              <Send className="size-4" />
            )}
            Confirm
          </Button>
          <Button
            variant="ghost"
            className="min-h-11"
            disabled={pushLead.isPending}
            onClick={() => setConfirm(null)}
          >
            Cancel
          </Button>
        </div>
      </div>
    );
  }

  return (
    <Button
      variant="outline"
      className={className}
      disabled={disabled || nextLead.isPending}
      onClick={findNext}
    >
      {nextLead.isPending ? (
        <Loader2 className="size-4 animate-spin" />
      ) : (
        <Send className="size-4" />
      )}
      {label}
    </Button>
  );
}

/**
 * Attendance overrides — the 10/6 playbook's last unshipped piece (PR #363).
 * A manager forces a rep On or Off for TODAY; the dispatcher lays the row over
 * the Monday attendance-board read in live issuing AND the watchdog, so the
 * app always wins — including turning ON a rep the board doesn't list at all.
 * Owner / office_staff only (the tab is admin-gated; RLS + the server fns
 * enforce it server-side). Mobile-first per AGENTS.md.
 */
function AttendanceOverridesPanel() {
  const overrides = useAttendanceOverrides();
  const { setOverride, clearOverride } = useOohMutations();
  const [office, setOffice] = useState<"SD" | "OC">("SD");
  const [repName, setRepName] = useState("");

  const flip = (status: "on" | "off") => {
    const name = repName.trim();
    if (!name) {
      toast.info("Type the rep's name first.");
      return;
    }
    setOverride
      .mutateAsync({ office, repName: name, status })
      .then(() => {
        toast.success(`${name} forced ${status === "on" ? "On" : "Off"} for today (${office}).`);
        setRepName("");
      })
      .catch((e) => toast.error(String(e instanceof Error ? e.message : e)));
  };

  const rows = overrides.data ?? [];

  return (
    <ArcadePanel
      title="Attendance overrides"
      faction="kombat"
      info={
        <span className="text-[10px] text-muted-foreground">today · beats the Monday board</span>
      }
      headline={
        rows.length > 0 ? (
          <span className="font-display text-xs text-muted-foreground">{rows.length}</span>
        ) : undefined
      }
    >
      <div className="space-y-3">
        <p className="text-xs text-muted-foreground">
          Force a rep On or Off for today. Live issuing and the watchdog read this OVER the Monday
          attendance board — On also works for a rep the board doesn't list.
        </p>
        <div className="flex flex-col gap-2 md:flex-row md:items-center">
          <div className="flex gap-2">
            {(["SD", "OC"] as const).map((o) => (
              <Button
                key={o}
                type="button"
                variant={office === o ? "default" : "outline"}
                className="min-h-11 flex-1 md:min-h-0 md:flex-none"
                aria-pressed={office === o}
                onClick={() => setOffice(o)}
              >
                {o}
              </Button>
            ))}
          </div>
          <Input
            value={repName}
            onChange={(e) => setRepName(e.target.value)}
            placeholder="Rep name (first name is enough)"
            className="min-h-11 md:min-h-0 md:max-w-60"
            maxLength={200}
          />
          <div className="flex gap-2">
            <Button
              type="button"
              className="min-h-11 flex-1 md:min-h-0"
              disabled={setOverride.isPending}
              onClick={() => flip("on")}
            >
              {setOverride.isPending ? (
                <Loader2 className="size-4 animate-spin" />
              ) : (
                <UserCheck className="size-4" />
              )}
              On today
            </Button>
            <Button
              type="button"
              variant="outline"
              className="min-h-11 flex-1 md:min-h-0"
              disabled={setOverride.isPending}
              onClick={() => flip("off")}
            >
              <UserX className="size-4" />
              Off today
            </Button>
          </div>
        </div>
        {overrides.data === null ? (
          <p className="text-sm text-muted-foreground">
            Overrides not available yet (migration pending).
          </p>
        ) : rows.length === 0 ? (
          <p className="text-sm text-muted-foreground">
            No overrides today — the Monday attendance board decides who's working.
          </p>
        ) : (
          <div className="space-y-2">
            {rows.map((o) => (
              <div
                key={o.id}
                className="flex items-center justify-between gap-2 rounded-lg border border-border/40 bg-surface/50 p-3"
              >
                <div className="flex min-w-0 flex-wrap items-center gap-2">
                  <span className="truncate text-sm font-medium text-foreground">{o.rep_name}</span>
                  <Chip cls="text-muted-foreground border-border">{o.office}</Chip>
                  <Chip
                    cls={
                      o.status === "on"
                        ? "text-victory border-victory/50"
                        : "text-destructive border-destructive/50"
                    }
                  >
                    {o.status === "on" ? "Forced On" : "Forced Off"}
                  </Chip>
                </div>
                <Button
                  variant="ghost"
                  className="min-h-11 shrink-0 md:min-h-0"
                  disabled={clearOverride.isPending}
                  aria-label={`Remove the override for ${o.rep_name}`}
                  onClick={() =>
                    clearOverride
                      .mutateAsync({ id: o.id })
                      .then(() =>
                        toast.success(`Override removed — the board decides ${o.rep_name} again.`),
                      )
                      .catch((e) => toast.error(String(e instanceof Error ? e.message : e)))
                  }
                >
                  <X className="size-4" /> Remove
                </Button>
              </div>
            ))}
          </div>
        )}
      </div>
    </ArcadePanel>
  );
}

function QueueCard({ row }: { row: OohQueueRow }) {
  const { resolve, addNote } = useOohMutations();
  const canPush = !!row.board_id && !!row.rep_name;
  // Lead (customer) name + appointment time, stashed in `raw` by the webhook —
  // so the office can find the lead in Monday even when it couldn't auto-file.
  const raw = (row.raw ?? {}) as { customerName?: string | null; apptLabel?: string | null };
  const leadName = raw.customerName?.trim() || null;
  const apptLabel = raw.apptLabel?.trim() || null;
  // "Add note to card" rescues a report the auto-writeback skipped: it needs a
  // real matched card (target + board, so the lead resolved and is active) and
  // some note text. Error rows are excluded — their write already touched Monday.
  const canAddNote =
    row.status === "needs_review" && !!row.target_item_id && !!row.board_id && !!row.details_line;
  return (
    <div className="rounded-lg border border-border/40 bg-surface/50 p-3 space-y-2.5">
      <div className="flex items-start justify-between gap-2">
        <div className="min-w-0">
          <p className="truncate text-sm font-medium text-foreground">
            {row.rep_name ?? leadName ?? "Unknown rep"}
          </p>
          <p className="text-xs text-muted-foreground">
            {oohResultLabel(row.result)} · {oohOnBlockLabel(row.on_block)}
            {row.lead_id ? ` · lead ${row.lead_id}` : " · no lead id"}
          </p>
        </div>
        <Chip
          cls={
            row.status === "error"
              ? "text-destructive border-destructive/50"
              : "text-kombat-gold border-kombat-gold/50"
          }
        >
          {row.status === "error" ? "Error" : "Review"}
        </Chip>
      </div>
      {(leadName || apptLabel) && (
        <p className="text-xs text-foreground">
          <span className="text-muted-foreground">Lead:</span> {leadName ?? "—"}
          {apptLabel ? ` · ${apptLabel}` : ""}
        </p>
      )}
      {row.reason && <p className="text-xs text-muted-foreground">{row.reason}</p>}
      {row.details_line && (
        <p className="rounded border border-border/40 bg-background/40 p-2 text-xs text-foreground/90">
          {row.details_line}
        </p>
      )}
      {row.error && <p className="text-xs text-destructive">{row.error}</p>}
      <div className="flex flex-wrap gap-2">
        {canAddNote && (
          <Button
            variant="outline"
            className="flex-1 min-w-[8rem]"
            disabled={addNote.isPending}
            onClick={() =>
              addNote
                .mutateAsync({ id: row.id })
                .then(() => toast.success("Note added to the card"))
                .catch((e) => toast.error(String(e instanceof Error ? e.message : e)))
            }
          >
            {addNote.isPending ? (
              <Loader2 className="size-4 animate-spin" />
            ) : (
              <MessageSquarePlus className="size-4" />
            )}
            Add note to card
          </Button>
        )}
        {canPush && (
          <PushNextLeadButton
            boardId={row.board_id}
            repName={row.rep_name}
            className="flex-1 min-w-[8rem]"
          />
        )}
        <Button
          variant="ghost"
          className="flex-1 min-w-[8rem]"
          disabled={resolve.isPending}
          onClick={() =>
            resolve
              .mutateAsync({ id: row.id, action: "processed" })
              .then(() => toast.success("Marked handled"))
              .catch((e) => toast.error(String(e instanceof Error ? e.message : e)))
          }
        >
          <CheckCircle2 className="size-4" /> Handled
        </Button>
        <Button
          variant="ghost"
          className="flex-1 min-w-[8rem]"
          disabled={resolve.isPending}
          onClick={() =>
            resolve
              .mutateAsync({ id: row.id, action: "dismissed" })
              .then(() => toast.success("Dismissed"))
              .catch((e) => toast.error(String(e instanceof Error ? e.message : e)))
          }
        >
          <X className="size-4" /> Dismiss
        </Button>
      </div>
    </div>
  );
}

function PreviewCard({ row }: { row: OohQueueRow }) {
  const status = (row.plan as { status?: { label?: string } } | null)?.status?.label ?? "—";
  return (
    <div className="rounded-lg border border-border/40 bg-surface/50 p-3 space-y-1.5">
      <div className="flex items-center justify-between gap-2">
        <p className="truncate text-sm font-medium text-foreground">
          {row.rep_name ?? "Unknown rep"}
        </p>
        <Chip cls="text-neon border-neon/50">{status}</Chip>
      </div>
      <p className="text-xs text-muted-foreground">
        {oohResultLabel(row.result)} ·{" "}
        {row.target_item_id ? `→ item ${row.target_item_id}` : "no target"}
        {row.office ? ` · ${row.office}` : ""}
      </p>
      {row.details_line && <p className="text-xs text-foreground/80">{row.details_line}</p>}
    </div>
  );
}

export function CloseKombatOohTab() {
  const cfg = useOohConfig();
  const queue = useOohQueue();
  const missing = useMissingReports();
  const writes = useDispatchWrites();
  // Owner-only: the live-dispatch chip becomes a tap-to-cycle toggle. realRole
  // (not the View-As role) so an owner previewing a rep keeps the control.
  const { realRole } = useAuth();
  const isOwner = realRole === "owner";

  const rows = useMemo(() => queue.data ?? [], [queue.data]);
  const review = useMemo(
    () => rows.filter((r) => r.status === "needs_review" || r.status === "error"),
    [rows],
  );
  const previews = useMemo(() => rows.filter((r) => r.status === "dry_run"), [rows]);
  const mode = cfg.data?.mode ?? "off";
  const modeCopy = MODE_COPY[mode] ?? MODE_COPY.off;

  return (
    <div className="space-y-4 md:space-y-6">
      <ArcadePanel title="Dispo — write-back" faction="kombat">
        <div className="space-y-3">
          <div className="flex flex-wrap items-center gap-2">
            <Chip cls={modeCopy.cls}>Write-back: {modeCopy.label}</Chip>
            <DispatchChip mode={cfg.data?.dispatchMode ?? "off"} isOwner={isOwner} />
            <Chip
              cls={
                cfg.data?.formUrl
                  ? "text-victory border-victory/50"
                  : "text-muted-foreground border-border"
              }
            >
              Form link {cfg.data?.formUrl ? "set" : "missing"}
            </Chip>
            <Chip
              cls={
                cfg.data?.autocreate
                  ? "text-neon border-neon/50"
                  : "text-muted-foreground border-border"
              }
            >
              Auto-create {cfg.data?.autocreate ? "on" : "off"}
            </Chip>
          </div>
          <p className="text-xs text-muted-foreground">{modeCopy.hint}</p>
          <p className="text-xs text-muted-foreground">
            {DISPATCH_HINT[cfg.data?.dispatchMode ?? "off"] ?? DISPATCH_HINT.off}
            {isOwner ? " Tap the Dispatch chip to change it." : ""}
          </p>
        </div>
      </ArcadePanel>

      <AttendanceOverridesPanel />

      <ArcadePanel
        title="Needs review"
        faction="kombat"
        status={review.length > 0 ? "warn" : "good"}
        headline={
          <span className="font-display text-xs text-muted-foreground">{review.length}</span>
        }
      >
        {queue.data === null ? (
          <p className="text-sm text-muted-foreground">
            Queue not available yet (migration pending).
          </p>
        ) : review.length === 0 ? (
          <p className="flex items-center gap-2 text-sm text-muted-foreground">
            <CheckCircle2 className="size-4 text-victory" /> Nothing waiting — every report matched
            a lead.
          </p>
        ) : (
          <div className="space-y-2">
            {review.map((r) => (
              <QueueCard key={r.id} row={r} />
            ))}
          </div>
        )}
      </ArcadePanel>

      <ArcadePanel
        title="Missing reports"
        faction="kombat"
        info={
          <span className="inline-flex items-center gap-1 text-[10px] text-muted-foreground">
            <Clock className="size-3" /> issued · appt passed
          </span>
        }
      >
        {missing.isLoading ? (
          <p className="flex items-center gap-2 text-sm text-muted-foreground">
            <Loader2 className="size-4 animate-spin" /> Scanning the blocks…
          </p>
        ) : (missing.data ?? []).length === 0 ? (
          <p className="text-sm text-muted-foreground">
            No outstanding reports — every issued lead is in.
          </p>
        ) : (
          <div className="space-y-2">
            {(missing.data ?? []).map((m) => (
              <div
                key={m.itemId}
                className="rounded-lg border border-border/40 bg-surface/50 p-3 space-y-2"
              >
                <div className="flex items-start justify-between gap-2">
                  <div className="min-w-0">
                    <p className="truncate text-sm font-medium text-foreground">{m.name}</p>
                    <p className="text-xs text-muted-foreground">
                      {m.office} · {m.reps.join(", ") || "no reps"}
                      {m.apptLabel ? ` · ${m.apptLabel}` : ""}
                    </p>
                  </div>
                  <AlertTriangle className="size-4 shrink-0 text-kombat-gold" />
                </div>
                <PushNextLeadButton
                  boardId={m.boardId}
                  repName={m.reps[0] ?? null}
                  label="Push next lead"
                  className="w-full"
                />
              </div>
            ))}
          </div>
        )}
      </ArcadePanel>

      {previews.length > 0 && (
        <ArcadePanel
          title="Dry-run previews"
          faction="kombat"
          headline={
            <span className="font-display text-xs text-muted-foreground">{previews.length}</span>
          }
        >
          <div className="space-y-2">
            {previews.slice(0, 50).map((r) => (
              <PreviewCard key={r.id} row={r} />
            ))}
          </div>
        </ArcadePanel>
      )}

      {/* Rule 21: every people6 / status write the dispatcher made, old → new,
          with the reason and time — Shai's audit of what the dispatcher touched. */}
      <ArcadePanel
        title="Dispatch write log"
        faction="kombat"
        info={
          <span className="inline-flex items-center gap-1 text-[10px] text-muted-foreground">
            <Clock className="size-3" /> people6 · Iss · old → new
          </span>
        }
        headline={
          <span className="font-display text-xs text-muted-foreground">
            {(writes.data ?? []).length}
          </span>
        }
      >
        {writes.data === null ? (
          <p className="text-sm text-muted-foreground">
            Write log not available yet (migration pending).
          </p>
        ) : (writes.data ?? []).length === 0 ? (
          <p className="text-sm text-muted-foreground">No people6 / status writes recorded yet.</p>
        ) : (
          <>
            <div className="hidden overflow-x-auto md:block">
              <table className="w-full min-w-0 text-left text-xs">
                <thead className="text-muted-foreground">
                  <tr>
                    <th className="py-1 pr-3 font-display uppercase tracking-widest">Time</th>
                    <th className="py-1 pr-3 font-display uppercase tracking-widest">Lead</th>
                    <th className="py-1 pr-3 font-display uppercase tracking-widest">Col</th>
                    <th className="py-1 pr-3 font-display uppercase tracking-widest">Old → New</th>
                    <th className="py-1 pr-3 font-display uppercase tracking-widest">Reason</th>
                  </tr>
                </thead>
                <tbody>
                  {(writes.data ?? []).slice(0, 100).map((w) => (
                    <tr key={w.id} className="border-t border-border/40 align-top">
                      <td className="py-1 pr-3 whitespace-nowrap text-muted-foreground">
                        {new Date(w.created_at).toLocaleString()}
                      </td>
                      <td className="py-1 pr-3">{w.lead_name || w.item_id}</td>
                      <td className="py-1 pr-3">
                        {w.column_label || w.column_id}
                        {w.mode === "dry_run" ? " (dry)" : ""}
                      </td>
                      <td className="py-1 pr-3 text-muted-foreground">
                        {(w.old_value || "∅") + " → " + (w.new_value || "∅")}
                      </td>
                      <td className="py-1 pr-3 text-muted-foreground">{w.reason}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            <div className="space-y-2 md:hidden">
              {(writes.data ?? []).slice(0, 50).map((w) => (
                <div
                  key={w.id}
                  className="rounded-lg border border-border/40 bg-surface/50 p-3 space-y-1"
                >
                  <div className="flex items-center justify-between gap-2">
                    <span className="truncate text-sm font-medium text-foreground">
                      {w.lead_name || w.item_id}
                    </span>
                    <span className="shrink-0 text-[10px] text-muted-foreground">
                      {w.column_label || w.column_id}
                      {w.mode === "dry_run" ? " (dry)" : ""}
                    </span>
                  </div>
                  <p className="text-xs text-muted-foreground">
                    {(w.old_value || "∅") + " → " + (w.new_value || "∅")}
                  </p>
                  <p className="text-[11px] text-muted-foreground">
                    {new Date(w.created_at).toLocaleString()} · {w.reason}
                  </p>
                </div>
              ))}
            </div>
          </>
        )}
      </ArcadePanel>
    </div>
  );
}
