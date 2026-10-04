import { useEffect, useMemo, useState } from "react";
import { ArcadePanel, ArcadeCard, ArcadePill } from "@/components/arcade";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";
import { toast } from "sonner";
import { CalendarOff, Check, ChevronLeft, ChevronRight, Clock, Loader2, X } from "lucide-react";
import { addDaysISO, dateFromISO, formatWeekRange, laWeekStartISO } from "@/lib/dates";
import {
  DAY_KEYS,
  DAY_LABEL,
  SHIFT_LABEL,
  comingWeekStartISO,
  isLateForWeek,
  normalizeShifts,
  summarizeShifts,
  type RespawnStatus,
  type ShiftKey,
} from "@/lib/respawn";
import {
  useMyRespawn,
  useMyRespawnForWeek,
  useRespawnMutations,
  useRespawnQueue,
  type RespawnRow,
} from "@/hooks/useRespawn";

const WEEKS_AHEAD = 8;

function weekLabel(iso: string): string {
  return formatWeekRange(dateFromISO(iso), dateFromISO(addDaysISO(iso, 6)));
}

function StatusChip({ status, late }: { status: RespawnStatus; late?: boolean }) {
  const cls =
    status === "approved"
      ? "border-victory/50 text-victory"
      : status === "denied"
        ? "border-destructive/50 text-destructive"
        : "border-kombat-gold/50 text-kombat-gold";
  return (
    <span className="inline-flex items-center gap-1.5">
      <span
        className={`rounded-full border px-2.5 py-1 text-[10px] font-display uppercase tracking-widest ${cls}`}
      >
        {status}
      </span>
      {late && (
        <span className="rounded-full border border-destructive/50 px-2.5 py-1 text-[10px] font-display uppercase tracking-widest text-destructive">
          Late
        </span>
      )}
    </span>
  );
}

function ShiftChips({ shifts }: { shifts: string[] }) {
  const keys = normalizeShifts(shifts);
  if (keys.length === 0) return <span className="text-xs text-muted-foreground">No shifts</span>;
  return (
    <div className="flex flex-wrap gap-1.5">
      {keys.map((s) => (
        <span
          key={s}
          className="rounded border border-border bg-surface px-2 py-1 text-[10px] font-display uppercase tracking-widest text-foreground"
        >
          {SHIFT_LABEL[s]}
        </span>
      ))}
    </div>
  );
}

// ── Rep: request / edit a week ──────────────────────────────────────────────

function RepRespawn({ userId }: { userId: string }) {
  const floor = laWeekStartISO(new Date());
  const cap = addDaysISO(floor, WEEKS_AHEAD * 7);
  const [week, setWeek] = useState<string>(() => comingWeekStartISO());
  const [picked, setPicked] = useState<Set<ShiftKey>>(new Set());
  const [reason, setReason] = useState("");

  const existing = useMyRespawnForWeek(userId, week);
  const mine = useMyRespawn(userId, floor);
  const { submit, cancel } = useRespawnMutations();

  const row = existing.data ?? null;
  // Reset the form to the week's current request whenever the week changes or
  // its row loads (edit = start from what's on file).
  useEffect(() => {
    setPicked(new Set(normalizeShifts(row?.shifts ?? []) as ShiftKey[]));
    setReason(row?.reason ?? "");
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [week, row?.id]);

  const late = isLateForWeek(week);
  const toggle = (s: ShiftKey) =>
    setPicked((prev) => {
      const next = new Set(prev);
      if (next.has(s)) next.delete(s);
      else next.add(s);
      return next;
    });

  const onSubmit = () => {
    const shifts = [...picked];
    if (shifts.length === 0) {
      toast.error("Pick at least one shift to request off.");
      return;
    }
    submit.mutate(
      { weekStart: week, shifts, reason: reason.trim() || undefined },
      {
        onSuccess: (r) => {
          toast.success(
            r.late
              ? "Request sent (flagged late for the office)."
              : "Request sent — pending approval.",
          );
        },
        onError: (e) => toast.error(e instanceof Error ? e.message : "Could not send request."),
      },
    );
  };

  const onWithdraw = () => {
    if (!row) return;
    cancel.mutate(row.id, {
      onSuccess: () => toast.success("Request withdrawn."),
      onError: (e) => toast.error(e instanceof Error ? e.message : "Could not withdraw."),
    });
  };

  const upcoming = (mine.data ?? []).filter((r) => r.week_start !== week);

  return (
    <div className="space-y-4">
      <ArcadePanel
        faction="kombat"
        title="Request shifts off"
        info={
          <span className="text-[10px] font-display uppercase tracking-widest text-muted-foreground">
            Due Sun 12 PM
          </span>
        }
      >
        <div className="space-y-4">
          {/* Week stepper */}
          <div className="flex items-center justify-between gap-2">
            <Button
              variant="outline"
              size="icon"
              aria-label="Previous week"
              disabled={week <= floor}
              onClick={() => setWeek((w) => (w > floor ? addDaysISO(w, -7) : w))}
            >
              <ChevronLeft className="h-4 w-4" />
            </Button>
            <div className="min-w-0 flex-1 text-center">
              <div className="truncate font-display text-sm text-kombat-gold">
                {weekLabel(week)}
              </div>
              {week === comingWeekStartISO() && (
                <div className="text-[10px] font-display uppercase tracking-widest text-muted-foreground">
                  Coming week
                </div>
              )}
            </div>
            <Button
              variant="outline"
              size="icon"
              aria-label="Next week"
              disabled={week >= cap}
              onClick={() => setWeek((w) => (w < cap ? addDaysISO(w, 7) : w))}
            >
              <ChevronRight className="h-4 w-4" />
            </Button>
          </div>

          {row && (
            <div className="flex flex-wrap items-center gap-2 rounded-lg border border-border/60 bg-surface/50 p-3">
              <StatusChip status={row.status} late={row.late} />
              {row.decision_note && (
                <span className="text-xs text-muted-foreground">“{row.decision_note}”</span>
              )}
              {row.status === "approved" && (
                <span className="text-[10px] font-display uppercase tracking-widest text-muted-foreground">
                  Editing sends it back to pending
                </span>
              )}
            </div>
          )}

          {late && (
            <div className="flex items-center gap-2 rounded-lg border border-destructive/40 bg-destructive/5 p-3 text-xs text-destructive">
              <Clock className="h-4 w-4 shrink-0" />
              Past the Sunday-noon deadline — this will be flagged late, but still goes to the
              office.
            </div>
          )}

          {/* Day × AM/PM grid */}
          <div className="space-y-2">
            {DAY_KEYS.map((d) => {
              const am = `${d}_am` as ShiftKey;
              const pm = `${d}_pm` as ShiftKey;
              return (
                <div
                  key={d}
                  className="grid grid-cols-[3rem_minmax(0,1fr)_minmax(0,1fr)] items-center gap-2"
                >
                  <span className="font-display text-xs uppercase tracking-widest text-muted-foreground">
                    {DAY_LABEL[d]}
                  </span>
                  <ArcadePill
                    tone="kombat-gold"
                    active={picked.has(am)}
                    onClick={() => toggle(am)}
                    className="w-full justify-center"
                  >
                    AM off
                  </ArcadePill>
                  <ArcadePill
                    tone="kombat-gold"
                    active={picked.has(pm)}
                    onClick={() => toggle(pm)}
                    className="w-full justify-center"
                  >
                    PM off
                  </ArcadePill>
                </div>
              );
            })}
          </div>

          <div className="space-y-1.5">
            <label className="font-display text-[10px] uppercase tracking-widest text-muted-foreground">
              Reason / notes (optional)
            </label>
            <Textarea
              value={reason}
              onChange={(e) => setReason(e.target.value)}
              placeholder="e.g. family trip, doctor's appointment…"
              className="min-h-16 text-base md:text-sm"
              maxLength={1000}
            />
          </div>

          <div className="flex flex-wrap gap-2">
            <Button
              className="min-h-11 flex-1"
              onClick={onSubmit}
              disabled={submit.isPending || picked.size === 0}
            >
              {submit.isPending ? (
                <Loader2 className="h-4 w-4 animate-spin" />
              ) : row ? (
                "Update request"
              ) : (
                "Send request"
              )}
            </Button>
            {row && (
              <Button
                variant="outline"
                className="min-h-11"
                onClick={onWithdraw}
                disabled={cancel.isPending}
              >
                {cancel.isPending ? <Loader2 className="h-4 w-4 animate-spin" /> : "Withdraw"}
              </Button>
            )}
          </div>
        </div>
      </ArcadePanel>

      {upcoming.length > 0 && (
        <ArcadePanel title="Your other requests">
          <ul className="space-y-2">
            {upcoming.map((r) => (
              <li
                key={r.id}
                className="flex flex-wrap items-center justify-between gap-2 rounded-lg border border-border/50 bg-surface/50 p-3"
              >
                <button
                  className="min-w-0 text-left font-display text-xs text-neon hover:underline"
                  onClick={() => setWeek(r.week_start)}
                >
                  {weekLabel(r.week_start)}
                </button>
                <span className="text-xs text-muted-foreground">
                  {summarizeShifts(normalizeShifts(r.shifts) as ShiftKey[])}
                </span>
                <StatusChip status={r.status} late={r.late} />
              </li>
            ))}
          </ul>
        </ArcadePanel>
      )}
    </div>
  );
}

// ── Admin: the approval queue ───────────────────────────────────────────────

function AdminRow({ r }: { r: RespawnRow }) {
  const { review, cancel } = useRespawnMutations();
  const [denying, setDenying] = useState(false);
  const [note, setNote] = useState("");

  const decide = (approve: boolean) =>
    review.mutate(
      { id: r.id, approve, note: note.trim() || undefined },
      {
        onSuccess: (res) =>
          toast.success(
            approve
              ? res.attendanceApplied
                ? "Approved — attendance updated."
                : "Approved (attendance applies when the week is live)."
              : "Denied.",
          ),
        onError: (e) => toast.error(e instanceof Error ? e.message : "Could not save decision."),
      },
    );

  return (
    <ArcadeCard className="space-y-2.5">
      <div className="flex items-start justify-between gap-2">
        <div className="min-w-0">
          <div className="truncate font-medium">{r.rep_name}</div>
          <div className="text-[10px] font-display uppercase tracking-widest text-muted-foreground">
            {r.office === "OC" ? "Orange County" : "San Diego"}
          </div>
        </div>
        <StatusChip status={r.status} late={r.late} />
      </div>

      <ShiftChips shifts={r.shifts} />
      {r.reason && <p className="text-xs text-muted-foreground">“{r.reason}”</p>}
      {r.decision_note && r.status !== "pending" && (
        <p className="text-xs text-muted-foreground">Office note: “{r.decision_note}”</p>
      )}

      {r.status === "pending" ? (
        <div className="space-y-2">
          {denying && (
            <Textarea
              value={note}
              onChange={(e) => setNote(e.target.value)}
              placeholder="Note for the rep (optional)…"
              className="min-h-14 text-base md:text-sm"
              maxLength={1000}
            />
          )}
          <div className="flex flex-wrap gap-2">
            <Button
              className="min-h-11 flex-1"
              onClick={() => decide(true)}
              disabled={review.isPending}
            >
              <Check className="mr-1 h-4 w-4" /> Approve
            </Button>
            {denying ? (
              <>
                <Button
                  variant="destructive"
                  className="min-h-11 flex-1"
                  onClick={() => decide(false)}
                  disabled={review.isPending}
                >
                  Confirm deny
                </Button>
                <Button
                  variant="outline"
                  className="min-h-11"
                  onClick={() => setDenying(false)}
                  disabled={review.isPending}
                >
                  Cancel
                </Button>
              </>
            ) : (
              <Button
                variant="outline"
                className="min-h-11 flex-1"
                onClick={() => setDenying(true)}
                disabled={review.isPending}
              >
                <X className="mr-1 h-4 w-4" /> Deny
              </Button>
            )}
          </div>
        </div>
      ) : (
        <div className="flex justify-end">
          <Button
            variant="ghost"
            size="sm"
            className="text-xs text-muted-foreground"
            onClick={() =>
              cancel.mutate(r.id, {
                onSuccess: () => toast.success("Request removed."),
                onError: (e) => toast.error(e instanceof Error ? e.message : "Could not remove."),
              })
            }
            disabled={cancel.isPending}
          >
            Remove
          </Button>
        </div>
      )}
    </ArcadeCard>
  );
}

function AdminRespawn() {
  const fromWeek = laWeekStartISO(new Date());
  const queue = useRespawnQueue(fromWeek);
  const { applyWeek } = useRespawnMutations();

  const groups = useMemo(() => {
    const rows = queue.data ?? [];
    const byWeek = new Map<string, RespawnRow[]>();
    for (const r of rows) {
      const list = byWeek.get(r.week_start) ?? [];
      list.push(r);
      byWeek.set(r.week_start, list);
    }
    return [...byWeek.entries()].sort(([a], [b]) => a.localeCompare(b));
  }, [queue.data]);

  const pendingTotal = (queue.data ?? []).filter((r) => r.status === "pending").length;

  return (
    <div className="space-y-4">
      <ArcadePanel
        faction="kombat"
        title={`Time-off queue · ${pendingTotal} pending`}
        action={
          <Button
            variant="outline"
            size="sm"
            className="text-xs"
            onClick={() =>
              applyWeek.mutate(fromWeek, {
                onSuccess: (res) =>
                  toast.success(
                    `Attendance synced: ${res.applied} applied, ${res.missing} unmatched.`,
                  ),
                onError: (e) =>
                  toast.error(e instanceof Error ? e.message : "Could not sync attendance."),
              })
            }
            disabled={applyWeek.isPending}
          >
            {applyWeek.isPending ? (
              <Loader2 className="h-4 w-4 animate-spin" />
            ) : (
              "Sync approved → attendance"
            )}
          </Button>
        }
      >
        {queue.isLoading ? (
          <p className="text-sm text-muted-foreground">Loading…</p>
        ) : groups.length === 0 ? (
          <p className="text-sm text-muted-foreground">No requests for the weeks ahead.</p>
        ) : (
          <div className="space-y-5">
            {groups.map(([wk, rows]) => (
              <div key={wk} className="space-y-2">
                <div className="flex items-center gap-2">
                  <span className="font-display text-xs uppercase tracking-widest text-neon">
                    {weekLabel(wk)}
                  </span>
                  <span className="text-[10px] font-display uppercase tracking-widest text-muted-foreground">
                    {rows.filter((r) => r.status === "pending").length} pending · {rows.length}{" "}
                    total
                  </span>
                </div>
                <div className="grid gap-2 md:grid-cols-2">
                  {rows.map((r) => (
                    <AdminRow key={r.id} r={r} />
                  ))}
                </div>
              </div>
            ))}
          </div>
        )}
      </ArcadePanel>
    </div>
  );
}

export function CloseKombatRespawnTab({
  userId,
  isRep,
  isAdmin,
}: {
  userId: string | null;
  isRep: boolean;
  isAdmin: boolean;
  displayName?: string | null;
  isPreview?: boolean;
}) {
  if (!userId) {
    return (
      <ArcadePanel faction="kombat" title="Respawn">
        <p className="text-sm text-muted-foreground">Sign in to request time off.</p>
      </ArcadePanel>
    );
  }
  return (
    <div className="space-y-4">
      <div className="flex items-start gap-2 text-xs text-muted-foreground">
        <CalendarOff className="mt-0.5 h-4 w-4 shrink-0 text-kombat-gold" />
        <p>
          Step off the floor to recharge. Request the AM/PM shifts you need off — any week, weeks
          ahead. Requests for the coming week are due <strong>Sunday 12 PM PT</strong>; later ones
          still go through, just flagged late. Tyler, Shai or Jorge approve them.
        </p>
      </div>
      {isAdmin && <AdminRespawn />}
      {isRep && <RepRespawn userId={userId} />}
    </div>
  );
}
