import { useState } from "react";
import { toast } from "sonner";
import { CalendarCheck2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { addDaysISO, laTodayISO } from "@/lib/dates";
import { cn } from "@/lib/utils";
import { KIND_LABEL, useDayOffMutations, type DayOffKind } from "@/hooks/useDayOff";

/** Kinds an admin/captain records about someone else, in the order HR
 *  reaches for them. (Workers self-request day_off/sick/other elsewhere.) */
const MARK_KINDS: Array<{ kind: DayOffKind; tone: string }> = [
  { kind: "sick", tone: "border-warning/50 text-warning hover:bg-warning/10" },
  { kind: "excused", tone: "border-victory/50 text-victory hover:bg-victory/10" },
  { kind: "unexcused", tone: "border-destructive/50 text-destructive hover:bg-destructive/10" },
  { kind: "no_show", tone: "border-destructive/50 text-destructive hover:bg-destructive/10" },
  { kind: "day_off", tone: "border-border text-muted-foreground hover:bg-surface-elevated" },
  { kind: "other", tone: "border-border text-muted-foreground hover:bg-surface-elevated" },
];

/** Expand an inclusive from→to range into ISO dates (the RPC's 31-day cap
 *  enforced here too, so the UI can say why). */
function expandRange(fromISO: string, toISO: string): string[] | null {
  if (!fromISO || !toISO || toISO < fromISO) return null;
  const out: string[] = [];
  for (let d = fromISO; d <= toISO && out.length <= 31; d = addDaysISO(d, 1)) out.push(d);
  return out.length > 31 ? null : out;
}

/**
 * Admin absence marking (owner ask 2026-10-14): mark anyone sick / excused /
 * unexcused / no-show for ANY date or range — past days included, unlike the
 * captain's today-only quick sheet. Entries for someone else are records
 * (born approved); a 'sick' record draws paid sick leave automatically. The
 * server enforces who may mark whom.
 */
export function AdminAbsenceDialog({
  profiles,
  onDone,
}: {
  profiles: Array<{ id: string; display_name: string }>;
  onDone?: () => void;
}) {
  const today = laTodayISO();
  const { submit } = useDayOffMutations();
  const [userId, setUserId] = useState("");
  const [kind, setKind] = useState<DayOffKind>("sick");
  const [from, setFrom] = useState(today);
  const [to, setTo] = useState(today);
  const [note, setNote] = useState("");

  const dates = expandRange(from, to);
  const sorted = [...profiles].sort((a, b) =>
    (a.display_name ?? "").localeCompare(b.display_name ?? ""),
  );

  const mark = () => {
    if (!userId || !dates) return;
    submit.mutate(
      { userId, dates, kind, reason: note.trim() || undefined },
      {
        onSuccess: (res) => {
          const name = profiles.find((p) => p.id === userId)?.display_name ?? "them";
          if (res.ok > 0) {
            toast.success(
              `${name} marked ${KIND_LABEL[kind].toLowerCase()} · ${res.ok} day${res.ok > 1 ? "s" : ""}`,
              {
                description:
                  res.skipped > 0
                    ? `${res.skipped} day${res.skipped > 1 ? "s" : ""} skipped — already recorded.`
                    : undefined,
              },
            );
            setNote("");
            onDone?.();
          } else {
            toast.error("Nothing recorded", {
              description: "Every selected day already has a live absence or request.",
            });
          }
        },
        onError: (e: Error) => toast.error("Couldn't record that", { description: e.message }),
      },
    );
  };

  return (
    <div className="space-y-3">
      <label className="block space-y-1">
        <span className="text-[10px] font-display uppercase tracking-widest text-muted-foreground">
          Who
        </span>
        <Select value={userId} onValueChange={setUserId}>
          <SelectTrigger className="text-base md:text-sm">
            <SelectValue placeholder="Pick a person…" />
          </SelectTrigger>
          <SelectContent className="z-[10000] max-h-72">
            {sorted.map((p) => (
              <SelectItem key={p.id} value={p.id}>
                {p.display_name}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      </label>

      <div className="space-y-1">
        <span className="text-[10px] font-display uppercase tracking-widest text-muted-foreground">
          Kind
        </span>
        <div className="grid grid-cols-2 sm:grid-cols-3 gap-1.5">
          {MARK_KINDS.map((k) => (
            <button
              key={k.kind}
              type="button"
              onClick={() => setKind(k.kind)}
              className={cn(
                "min-h-11 md:min-h-9 rounded border px-2 text-[10px] font-display uppercase tracking-widest transition-colors",
                k.tone,
                kind === k.kind && "ring-1 ring-current",
              )}
            >
              {KIND_LABEL[k.kind]}
            </button>
          ))}
        </div>
        {kind === "sick" && (
          <div className="text-[10px] text-muted-foreground">
            Sick days draw the person's paid sick leave automatically (balance and the 40h/year cap
            permitting) and show on their paycheck.
          </div>
        )}
      </div>

      <div className="grid grid-cols-2 gap-2">
        <label className="block space-y-1">
          <span className="text-[10px] font-display uppercase tracking-widest text-muted-foreground">
            From
          </span>
          <Input
            type="date"
            value={from}
            onChange={(e) => {
              setFrom(e.target.value);
              if (e.target.value > to) setTo(e.target.value);
            }}
            className="text-base md:text-sm"
          />
        </label>
        <label className="block space-y-1">
          <span className="text-[10px] font-display uppercase tracking-widest text-muted-foreground">
            To
          </span>
          <Input
            type="date"
            value={to}
            min={from}
            onChange={(e) => setTo(e.target.value)}
            className="text-base md:text-sm"
          />
        </label>
      </div>
      {!dates && (
        <div className="text-[10px] text-destructive">
          Pick a valid range — up to 31 days, end on or after start.
        </div>
      )}

      <label className="block space-y-1">
        <span className="text-[10px] font-display uppercase tracking-widest text-muted-foreground">
          Note · optional
        </span>
        <Input
          value={note}
          onChange={(e) => setNote(e.target.value)}
          placeholder='e.g. "called in at 6:40, doctor note coming"'
          className="text-base md:text-sm"
        />
      </label>

      <Button
        disabled={!userId || !dates || submit.isPending}
        onClick={mark}
        className="w-full min-h-11 md:min-h-9 bg-victory text-background hover:bg-victory/90 font-display text-[10px] uppercase tracking-widest"
      >
        <CalendarCheck2 className="w-3.5 h-3.5 mr-1.5" />
        Record {dates ? `${dates.length} day${dates.length > 1 ? "s" : ""}` : "absence"}
      </Button>
    </div>
  );
}
