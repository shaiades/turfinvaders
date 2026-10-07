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
  Send,
  UserCheck,
  UserX,
  X,
} from "lucide-react";
import { oohOnBlockLabel, oohResultLabel, type OohQueueRow } from "@/lib/ooh";
import {
  type DispatchDecisionRow,
  useAttendanceOverrideMutations,
  useAttendanceOverrides,
  useDispatchDecisions,
  useMissingReports,
  useOohConfig,
  useOohMutations,
  useOohQueue,
} from "@/hooks/useOohQueue";
import { laTimeHM } from "@/lib/dates";

/**
 * OOH admin tab — the office's cockpit for the Out of House write-back.
 * - A status banner (mode / form link / auto-create).
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

/** One decision's action → the chip the office reads at a glance. */
function decisionChip(d: DispatchDecisionRow): { label: string; cls: string } {
  if (d.action === "issue") {
    if (d.mode === "live" && d.issued)
      return { label: "Issued", cls: "text-victory border-victory/50" };
    if (d.mode === "live")
      return { label: "Issue failed", cls: "text-destructive border-destructive/50" };
    return { label: "Would issue", cls: "text-kombat-gold border-kombat-gold/50" };
  }
  if (d.action === "manager") return { label: "Manager", cls: "text-neon border-neon/50" };
  if (d.action === "alert")
    return { label: "Alert", cls: "text-destructive border-destructive/50" };
  return { label: "No lead", cls: "text-muted-foreground border-border" };
}

/**
 * Dispatch decisions (today, LA): the dispatcher's audit trail — who it issued
 * (or would issue) which lead and why, straight from ooh_dispatch_decisions.
 * This is the review loop for the dry-run shadow day and the live audit after:
 * no chat window required.
 */
function DispatchDecisionsPanel() {
  const decisions = useDispatchDecisions();
  const rows = decisions.data ?? [];
  return (
    <ArcadePanel
      title="Dispatch decisions"
      faction="kombat"
      info={<span className="text-[10px] text-muted-foreground">today · newest first</span>}
      headline={<span className="font-display text-xs text-muted-foreground">{rows.length}</span>}
    >
      {decisions.data === null ? (
        <p className="text-sm text-muted-foreground">
          Decision log not available yet (migration pending).
        </p>
      ) : rows.length === 0 ? (
        <p className="text-sm text-muted-foreground">
          No decisions yet today — they appear the moment a report frees a rep.
        </p>
      ) : (
        <div className="space-y-2">
          {rows.map((d) => {
            const chip = decisionChip(d);
            const fit =
              d.action === "issue"
                ? [
                    d.drive_minutes != null ? `${d.drive_minutes}m drive` : null,
                    d.strength != null ? `strength ${d.strength}` : null,
                    d.score != null ? `score ${d.score}` : null,
                  ]
                    .filter(Boolean)
                    .join(" · ")
                : null;
            return (
              <div
                key={d.id}
                className="rounded-lg border border-border/40 bg-surface/50 p-3 space-y-1.5"
              >
                <div className="flex items-start justify-between gap-2">
                  <p className="min-w-0 truncate text-sm font-medium text-foreground">
                    {d.rep_name ?? "—"}
                    {d.lead_name ? ` → ${d.lead_name}` : ""}
                  </p>
                  <Chip cls={chip.cls}>{chip.label}</Chip>
                </div>
                <p className="text-xs text-muted-foreground">
                  {laTimeHM(d.created_at)}
                  {d.office ? ` · ${d.office}` : ""}
                  {d.trigger === "watchdog" ? " · watchdog" : ""}
                  {fit ? ` · ${fit}` : ""}
                </p>
                {d.reason && <p className="text-xs text-foreground/80">{d.reason}</p>}
              </div>
            );
          })}
        </div>
      )}
    </ArcadePanel>
  );
}

/**
 * Attendance overrides (owner 10/6): the Monday attendance board is sometimes
 * wrong, so a manager can flip a rep On/Off for TODAY here — live dispatch
 * reads these first and the override always beats the board.
 */
function AttendanceOverridesPanel() {
  const overrides = useAttendanceOverrides();
  const { upsert, remove } = useAttendanceOverrideMutations();
  const [office, setOffice] = useState<"SD" | "OC">("SD");
  const [name, setName] = useState("");

  const add = (status: "on" | "off") => {
    const repName = name.trim();
    if (!repName) {
      toast.info("Type the rep's name first.");
      return;
    }
    upsert
      .mutateAsync({ office, repName, status })
      .then(() => {
        toast.success(`${repName} marked ${status.toUpperCase()} today (${office}).`);
        setName("");
      })
      .catch((e) => toast.error(String(e instanceof Error ? e.message : e)));
  };

  return (
    <ArcadePanel
      title="Attendance overrides"
      faction="kombat"
      info={
        <span className="text-[10px] text-muted-foreground">today · beats the Monday board</span>
      }
    >
      <div className="space-y-3">
        <div className="flex flex-col gap-2 md:flex-row md:items-center">
          <div className="flex gap-2">
            {(["SD", "OC"] as const).map((o) => (
              <Button
                key={o}
                variant={office === o ? "default" : "outline"}
                className="flex-1 md:flex-none"
                onClick={() => setOffice(o)}
              >
                {o}
              </Button>
            ))}
          </div>
          <Input
            value={name}
            onChange={(e) => setName(e.target.value)}
            placeholder="Rep name"
            className="text-base md:text-xs"
          />
          <div className="flex gap-2">
            <Button className="flex-1" disabled={upsert.isPending} onClick={() => add("on")}>
              <UserCheck className="size-4" /> On
            </Button>
            <Button
              variant="outline"
              className="flex-1"
              disabled={upsert.isPending}
              onClick={() => add("off")}
            >
              <UserX className="size-4" /> Off
            </Button>
          </div>
        </div>
        {overrides.data === null ? (
          <p className="text-sm text-muted-foreground">
            Overrides not available yet (migration pending).
          </p>
        ) : (overrides.data ?? []).length === 0 ? (
          <p className="text-xs text-muted-foreground">
            No overrides today — dispatch trusts the attendance board.
          </p>
        ) : (
          <div className="space-y-2">
            {(overrides.data ?? []).map((o) => (
              <div
                key={o.id}
                className="flex items-center justify-between gap-2 rounded-lg border border-border/40 bg-surface/50 p-2.5"
              >
                <div className="min-w-0">
                  <p className="truncate text-sm text-foreground">{o.rep_name}</p>
                  <p className="text-[10px] uppercase tracking-widest text-muted-foreground">
                    {o.office}
                  </p>
                </div>
                <div className="flex items-center gap-2">
                  <Chip
                    cls={
                      o.status === "on"
                        ? "text-victory border-victory/50"
                        : "text-destructive border-destructive/50"
                    }
                  >
                    {o.status === "on" ? "On" : "Off"}
                  </Chip>
                  <Button
                    variant="ghost"
                    size="icon"
                    disabled={remove.isPending}
                    onClick={() =>
                      remove
                        .mutateAsync(o.id)
                        .then(() => toast.success("Override removed"))
                        .catch((e) => toast.error(String(e instanceof Error ? e.message : e)))
                    }
                  >
                    <X className="size-4" />
                  </Button>
                </div>
              </div>
            ))}
          </div>
        )}
      </div>
    </ArcadePanel>
  );
}

function QueueCard({ row }: { row: OohQueueRow }) {
  const { resolve } = useOohMutations();
  const canPush = !!row.board_id && !!row.rep_name;
  return (
    <div className="rounded-lg border border-border/40 bg-surface/50 p-3 space-y-2.5">
      <div className="flex items-start justify-between gap-2">
        <div className="min-w-0">
          <p className="truncate text-sm font-medium text-foreground">
            {row.rep_name ?? "Unknown rep"}
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
      {row.reason && <p className="text-xs text-muted-foreground">{row.reason}</p>}
      {row.details_line && (
        <p className="rounded border border-border/40 bg-background/40 p-2 text-xs text-foreground/90">
          {row.details_line}
        </p>
      )}
      {row.error && <p className="text-xs text-destructive">{row.error}</p>}
      <div className="flex flex-wrap gap-2">
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
            <Chip cls={(MODE_COPY[cfg.data?.dispatchMode ?? "off"] ?? MODE_COPY.off).cls}>
              Dispatch: {(MODE_COPY[cfg.data?.dispatchMode ?? "off"] ?? MODE_COPY.off).label}
            </Chip>
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
        </div>
      </ArcadePanel>

      <DispatchDecisionsPanel />

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
    </div>
  );
}
