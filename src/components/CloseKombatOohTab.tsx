import { useMemo } from "react";
import { ArcadePanel } from "@/components/arcade";
import { Button } from "@/components/ui/button";
import { toast } from "sonner";
import { AlertTriangle, CheckCircle2, Clock, Loader2, Send, X } from "lucide-react";
import { oohOnBlockLabel, oohResultLabel, type OohQueueRow } from "@/lib/ooh";
import { useMissingReports, useOohConfig, useOohMutations, useOohQueue } from "@/hooks/useOohQueue";

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

function QueueCard({ row }: { row: OohQueueRow }) {
  const { resolve, pushLead } = useOohMutations();
  const canPush = !!row.target_item_id && !!row.board_id;
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
          <Button
            variant="outline"
            className="flex-1 min-w-[8rem]"
            disabled={pushLead.isPending}
            onClick={() =>
              pushLead
                .mutateAsync({ boardId: row.board_id!, itemId: row.target_item_id! })
                .then(() => toast.success("Lead issued (Iss)"))
                .catch((e) => toast.error(String(e instanceof Error ? e.message : e)))
            }
          >
            {pushLead.isPending ? (
              <Loader2 className="size-4 animate-spin" />
            ) : (
              <Send className="size-4" />
            )}
            Push lead
          </Button>
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
  const { pushLead } = useOohMutations();

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
      <ArcadePanel title="Out of House — write-back" faction="kombat">
        <div className="space-y-3">
          <div className="flex flex-wrap items-center gap-2">
            <Chip cls={modeCopy.cls}>Mode: {modeCopy.label}</Chip>
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
                <Button
                  variant="outline"
                  className="w-full"
                  disabled={pushLead.isPending}
                  onClick={() =>
                    pushLead
                      .mutateAsync({ boardId: m.boardId, itemId: m.itemId })
                      .then(() => toast.success("Lead re-issued"))
                      .catch((e) => toast.error(String(e instanceof Error ? e.message : e)))
                  }
                >
                  <Send className="size-4" /> Push lead
                </Button>
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
