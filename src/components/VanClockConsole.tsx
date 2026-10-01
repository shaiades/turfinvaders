import { useEffect, useMemo, useState } from "react";
import { Clock, Play, Square, Utensils } from "lucide-react";
import { toast } from "sonner";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { ArcadePanel } from "@/components/arcade";
import { useDispatchRoster } from "@/hooks/useFleetRoster";
import { useRealtimeInvalidate } from "@/hooks/useRealtimeInvalidate";
import { CrewAbsenceSheet } from "@/components/CrewAbsenceSheet";
import { DayOffWeekStrip } from "@/components/DayOffWeekStrip";
import { laWeekStartISO } from "@/lib/dates";
import {
  useCrewAction,
  useVanClockStatus,
  type CrewAction,
  type CrewActionResult,
  type MemberClockState,
} from "@/hooks/useVanClock";

const LA_TIME = (iso: string) =>
  new Date(iso).toLocaleTimeString("en-US", {
    hour: "numeric",
    minute: "2-digit",
    timeZone: "America/Los_Angeles",
  });

const ACTION_LABEL: Record<CrewAction, string> = {
  clock_in: "Clock In Van",
  clock_out: "Clock Out Van",
  start_lunch: "Start Lunch",
  end_lunch: "End Lunch",
};

const SKIP_LABEL: Record<string, string> = {
  not_your_team: "not on your van",
  inactive: "archived",
  already_clocked_in: "already on the clock",
  no_open_shift: "not clocked in",
  already_on_lunch: "already on lunch",
  not_on_lunch: "not on lunch",
};

/** Members a bulk action can actually move — drives button enablement. */
function eligible(action: CrewAction, s: MemberClockState | undefined): boolean {
  if (!s) return false;
  switch (action) {
    case "clock_in":
      return !s.openEntryId;
    case "clock_out":
      return !!s.openEntryId;
    case "start_lunch":
      return !!s.openEntryId && !s.onLunchSince;
    case "end_lunch":
      return !!s.onLunchSince;
  }
}

/**
 * The captain's one-tap crew clock: the whole van clocks in together, breaks
 * for (unpaid, punched-out) lunch together, and clocks out together. Bulk
 * punches are "now"-only server-side — this console records what is actually
 * happening, and any correction goes through the reasoned, audited timesheet
 * flow instead. Per-member conflicts (someone already punched in themselves)
 * skip and report; they never block the rest of the van.
 */
export function VanClockConsole({ teamId }: { teamId: string }) {
  const roster = useDispatchRoster();
  const members = useMemo(
    () =>
      (roster.data?.profiles ?? [])
        .filter((p) => p.team_id === teamId && p.is_active !== false && !p.is_placeholder)
        .map((p) => ({ id: p.id, name: p.display_name ?? "Unknown" }))
        .sort((a, b) => a.name.localeCompare(b.name)),
    [roster.data?.profiles, teamId],
  );
  const memberIds = useMemo(() => members.map((m) => m.id), [members]);
  const nameById = useMemo(() => new Map(members.map((m) => [m.id, m.name])), [members]);

  const status = useVanClockStatus(teamId, memberIds);
  useRealtimeInvalidate({
    channel: `van-clock-${teamId}`,
    tables: ["time_entries", "meal_periods"],
    invalidateKeys: [["van-clock"]],
  });

  // Checked by default (new members included) — track the UNchecked set.
  const [unchecked, setUnchecked] = useState<Set<string>>(() => new Set());
  const selected = memberIds.filter((id) => !unchecked.has(id));

  const [confirming, setConfirming] = useState<CrewAction | null>(null);
  const [absenceFor, setAbsenceFor] = useState<{ id: string; name: string } | null>(null);
  const [lastAction, setLastAction] = useState<{
    action: CrewAction;
    at: string;
    lines: Array<{ name: string; status: string; code?: string }>;
  } | null>(null);

  const crew = useCrewAction();

  // Minute-level "since" labels only need a slow tick.
  const [, setTick] = useState(0);
  useEffect(() => {
    const t = setInterval(() => setTick((n) => n + 1), 30_000);
    return () => clearInterval(t);
  }, []);

  const counts = useMemo(() => {
    let on = 0,
      lunch = 0,
      off = 0;
    for (const id of memberIds) {
      const s = status.data?.get(id);
      if (s?.onLunchSince) lunch++;
      else if (s?.openEntryId) on++;
      else off++;
    }
    return { on, lunch, off };
  }, [memberIds, status.data]);

  const run = (action: CrewAction) => {
    const ids = selected.filter((id) => eligible(action, status.data?.get(id)));
    crew.mutate(
      { action, userIds: ids },
      {
        onSuccess: (res: CrewActionResult) => {
          const lines = (res.results ?? []).map((r) => ({
            name: nameById.get(r.user_id) ?? "Unknown",
            status: r.status,
            code: r.code,
          }));
          setLastAction({ action, at: new Date().toISOString(), lines });
          const skipped = lines.filter((l) => l.status !== "ok");
          toast.success(`${ACTION_LABEL[action]} · ${res.ok} done`, {
            description:
              skipped.length > 0
                ? `Skipped — ${skipped
                    .map((l) => `${l.name}: ${SKIP_LABEL[l.code ?? ""] ?? l.code ?? "error"}`)
                    .join(" · ")}`
                : undefined,
          });
        },
        onError: (e: Error) => toast.error(`${ACTION_LABEL[action]} failed`, { description: e.message }),
      },
    );
    setConfirming(null);
  };

  const confirmNames = confirming
    ? selected
        .filter((id) => eligible(confirming, status.data?.get(id)))
        .map((id) => nameById.get(id) ?? "Unknown")
    : [];

  if (members.length === 0) return null;

  return (
    <ArcadePanel
      title="Van Clock"
      action={
        <span className="text-[10px] font-display uppercase tracking-widest text-muted-foreground tabular-nums">
          {counts.on} on · {counts.lunch} lunch · {counts.off} off
        </span>
      }
    >
      <div className="flex items-center justify-between gap-2 mb-2">
        <div className="text-[10px] font-display uppercase tracking-widest text-muted-foreground">
          {selected.length}/{members.length} selected
        </div>
        <div className="flex items-center gap-1">
          <button
            type="button"
            onClick={() => setUnchecked(new Set())}
            className="min-h-11 md:min-h-8 px-2 text-[10px] font-display uppercase tracking-widest text-victory"
          >
            All
          </button>
          <button
            type="button"
            onClick={() => setUnchecked(new Set(memberIds))}
            className="min-h-11 md:min-h-8 px-2 text-[10px] font-display uppercase tracking-widest text-muted-foreground"
          >
            None
          </button>
        </div>
      </div>

      <div className="flex flex-col md:grid md:grid-cols-2 gap-1 md:gap-2">
        {members.map((m) => {
          const s = status.data?.get(m.id);
          const checked = !unchecked.has(m.id);
          return (
            <label
              key={m.id}
              className="flex items-center gap-3 min-h-11 px-2 rounded border border-border/40 bg-surface-elevated/40 cursor-pointer"
            >
              <input
                type="checkbox"
                checked={checked}
                onChange={(e) => {
                  setUnchecked((prev) => {
                    const next = new Set(prev);
                    if (e.target.checked) next.delete(m.id);
                    else next.add(m.id);
                    return next;
                  });
                }}
                className="accent-[var(--victory)] w-4 h-4 shrink-0"
              />
              <span className="flex-1 min-w-0 truncate text-sm">{m.name}</span>
              {!status.data ? (
                <span className="text-[9px] font-display uppercase tracking-widest text-muted-foreground">
                  …
                </span>
              ) : s?.onLunchSince ? (
                <span className="inline-flex items-center gap-1 text-[9px] font-display uppercase tracking-widest text-warning tabular-nums">
                  <Utensils className="w-3 h-3" />
                  Lunch · {Math.max(0, Math.round((Date.now() - new Date(s.onLunchSince).getTime()) / 60000))}m
                </span>
              ) : s?.openEntryId ? (
                <span className="inline-flex items-center gap-1 text-[9px] font-display uppercase tracking-widest text-victory tabular-nums">
                  <span className="w-1.5 h-1.5 rounded-full bg-victory animate-pulse" />
                  On · {s.clockIn ? LA_TIME(s.clockIn) : ""}
                </span>
              ) : s?.lastOut ? (
                <span className="text-[9px] font-display uppercase tracking-widest text-muted-foreground tabular-nums">
                  Off · {LA_TIME(s.lastOut)} · {s.todayHours.toFixed(1)}h
                </span>
              ) : (
                <span className="inline-flex items-center gap-1.5">
                  <span className="text-[9px] font-display uppercase tracking-widest text-muted-foreground">
                    Not in yet
                  </span>
                  <button
                    type="button"
                    onClick={(e) => {
                      e.preventDefault();
                      setAbsenceFor({ id: m.id, name: m.name });
                    }}
                    className="text-[9px] font-display uppercase tracking-widest text-warning/80 hover:text-warning underline-offset-2 hover:underline"
                  >
                    absent?
                  </button>
                </span>
              )}
            </label>
          );
        })}
      </div>

      <div className="mt-3 grid grid-cols-2 gap-3 md:max-w-xl">
        {(
          [
            ["clock_in", "var(--victory)", "#06110a", Play],
            ["start_lunch", "var(--warning)", "#1a1205", Utensils],
            ["end_lunch", "var(--warning)", "#1a1205", Clock],
            ["clock_out", "var(--destructive)", "#fff", Square],
          ] as const
        ).map(([action, color, fg, Icon]) => {
          const n = selected.filter((id) => eligible(action, status.data?.get(id))).length;
          return (
            <button
              key={action}
              onClick={() => setConfirming(action)}
              disabled={crew.isPending || !status.data || n === 0}
              className="arcade-btn-3d px-3 py-4 font-display text-xs uppercase tracking-widest flex items-center justify-center gap-2 disabled:opacity-40"
              style={{ ["--btn-color" as string]: color, ["--btn-fg" as string]: fg }}
            >
              <Icon className="w-4 h-4" />
              {ACTION_LABEL[action]}
              {status.data && n > 0 && <span className="tabular-nums">({n})</span>}
            </button>
          );
        })}
      </div>

      {lastAction && (
        <div className="mt-3 rounded border border-border/40 bg-surface-elevated/40 p-2">
          <div className="text-[9px] font-display uppercase tracking-widest text-muted-foreground mb-1">
            {ACTION_LABEL[lastAction.action]} · {LA_TIME(lastAction.at)}
          </div>
          <div className="flex flex-wrap gap-1">
            {lastAction.lines.map((l, i) => (
              <span
                key={i}
                className={`text-[9px] font-display uppercase tracking-widest border rounded px-1 ${
                  l.status === "ok"
                    ? "text-victory border-victory/40"
                    : "text-warning border-warning/40"
                }`}
              >
                {l.name}
                {l.status !== "ok" && ` · ${SKIP_LABEL[l.code ?? ""] ?? "error"}`}
              </span>
            ))}
          </div>
        </div>
      )}

      {/* Approved days off this week — explains an empty seat at a glance. */}
      <DayOffWeekStrip weekStartISO={laWeekStartISO()} teamId={teamId} />

      <CrewAbsenceSheet
        open={!!absenceFor}
        onOpenChange={(o) => !o && setAbsenceFor(null)}
        member={absenceFor}
      />

      <Dialog open={!!confirming} onOpenChange={(o) => !o && setConfirming(null)}>
        <DialogContent className="max-w-md">
          <DialogHeader>
            <DialogTitle className="font-display uppercase tracking-widest text-sm">
              {confirming ? ACTION_LABEL[confirming] : ""} · {confirmNames.length}
            </DialogTitle>
            <DialogDescription>
              {confirming === "clock_in" &&
                "Starts a live shift for everyone below, right now. This is a legal time record."}
              {confirming === "start_lunch" &&
                "Punches everyone below out for lunch, right now. Lunch is unpaid and off the clock — 30+ minutes before the 5th hour keeps the day compliant."}
              {confirming === "end_lunch" &&
                "Ends lunch for everyone below — they're back on the clock as of right now."}
              {confirming === "clock_out" &&
                "Ends the shift for everyone below as of right now. Anyone still on lunch has it ended at the same moment; shifts past 5 hours with no 30-minute lunch get flagged for review."}{" "}
              Their phones update within a minute.
            </DialogDescription>
          </DialogHeader>
          <div className="flex flex-wrap gap-1">
            {confirmNames.map((n) => (
              <span
                key={n}
                className="text-[10px] font-display uppercase tracking-widest border border-border rounded px-1.5 py-0.5"
              >
                {n}
              </span>
            ))}
          </div>
          <DialogFooter className="gap-2">
            <Button
              variant="outline"
              className="min-h-11 md:min-h-9"
              onClick={() => setConfirming(null)}
            >
              Cancel
            </Button>
            <Button
              disabled={crew.isPending || confirmNames.length === 0}
              onClick={() => confirming && run(confirming)}
              className="min-h-11 md:min-h-9 bg-victory text-background hover:bg-victory/90 font-display text-[10px] uppercase tracking-widest"
            >
              {confirming ? ACTION_LABEL[confirming] : ""} ({confirmNames.length})
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </ArcadePanel>
  );
}
