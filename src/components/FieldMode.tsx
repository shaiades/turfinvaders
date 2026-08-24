import { useEffect, useRef, useState } from "react";
import { useAuth } from "@/hooks/useAuth";
import { supabase } from "@/integrations/supabase/client";
import { getPositionOrNull } from "@/lib/utils";
import { laTodayISO } from "@/lib/dates";
import { useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import { DoorOpen, MessagesSquare, Ban, Zap, X, Loader2 } from "lucide-react";
import { getMondayFormUrl } from "@/lib/monday-form";
import { dailyLogKeys, sumLogCounters, useTodayLogs, type DailyLogRow } from "@/hooks/useDailyLogs";

type TallyKey = "doors_knocked" | "people_talked_to" | "not_interested";
type PinType = "knock" | "talked_to" | "not_interested" | "lead";

const TALLY_TO_PIN: Record<TallyKey, PinType> = {
  doors_knocked: "knock",
  people_talked_to: "talked_to",
  not_interested: "not_interested",
};

/** The three tally buttons as data (house pattern — FUNNEL_COLS,
 *  COMPANY_TILES): the Submit New Lead button stays hand-rolled because it
 *  really is different (pulse glow, no count, opens the sheet). */
const TALLIES: Array<{
  key: TallyKey;
  label: string;
  emoji: string;
  icon: typeof DoorOpen;
  color: string;
  subtle?: boolean;
}> = [
  {
    key: "doors_knocked",
    label: "Log Knock",
    emoji: "🚪",
    icon: DoorOpen,
    color: "var(--neon-blue)",
  },
  {
    key: "people_talked_to",
    label: "Talked To",
    emoji: "🗣️",
    icon: MessagesSquare,
    color: "var(--neon-orange)",
  },
  {
    key: "not_interested",
    label: "Not Interested",
    emoji: "🛑",
    icon: Ban,
    color: "oklch(0.55 0.02 270)",
    subtle: true,
  },
];

export function FieldMode() {
  const { user } = useAuth();
  const qc = useQueryClient();
  const [leadOpen, setLeadOpen] = useState(false);
  const [pending, setPending] = useState<PinType | null>(null);
  const log_date = laTodayISO();
  const watchIdRef = useRef<number | null>(null);

  // Prompt for location as soon as Field Mode opens; keep a warm GPS fix.
  useEffect(() => {
    if (typeof navigator === "undefined" || !navigator.geolocation) {
      toast.error("This device doesn't support GPS.");
      return;
    }
    // A one-shot request triggers the browser permission prompt.
    navigator.geolocation.getCurrentPosition(
      () => {},
      (err) => {
        if (err.code === err.PERMISSION_DENIED) {
          toast.error("Location denied. Pins won't drop on the map until you enable GPS.");
        }
      },
      { enableHighAccuracy: true, maximumAge: 10000, timeout: 10000 },
    );
    // Warm cache so subsequent taps resolve fast.
    watchIdRef.current = navigator.geolocation.watchPosition(
      () => {},
      () => {},
      { enableHighAccuracy: true, maximumAge: 5000, timeout: 15000 },
    );
    return () => {
      if (watchIdRef.current != null) navigator.geolocation.clearWatch(watchIdRef.current);
    };
  }, []);

  // Whole-day totals across office rows, from the shared today-logs cache —
  // the same rows the Log form, Stats page, and HUD read.
  const { data: todayRows } = useTodayLogs(user?.id);
  const today = sumLogCounters(todayRows);

  async function dropPin(pin_type: PinType, opts?: { silent?: boolean }) {
    if (!user?.id) return { ok: false as const };
    const fix = await getPositionOrNull({
      enableHighAccuracy: true,
      maximumAge: 8000,
      timeout: 8000,
    });
    if (!fix) {
      toast.error("No GPS fix yet — enable Location and try again.");
      return { ok: false as const };
    }
    const { error } = await supabase.from("field_pins").insert({
      canvasser_id: user.id,
      pin_type,
      lat: fix.coords.latitude,
      lng: fix.coords.longitude,
      log_date,
      device_lat: fix.coords.latitude,
      device_lng: fix.coords.longitude,
      distance_m: 0,
      is_remote_drop: false,
    });
    if (error) {
      toast.error(error.message || "Couldn't save pin");
      return { ok: false as const };
    }
    if (!opts?.silent && typeof navigator !== "undefined" && "vibrate" in navigator) {
      try {
        navigator.vibrate?.(15);
      } catch {
        /* ignore */
      }
    }
    return { ok: true as const };
  }

  async function bump(key: TallyKey) {
    if (!user?.id) return;
    const pin_type = TALLY_TO_PIN[key];
    const todayKey = dailyLogKeys.today(user.id, log_date);
    setPending(pin_type);
    try {
      // Optimistic +1 as an appended synthetic row via functional updater —
      // sumLogCounters folds it into the total, and a render-captured
      // snapshot would lose counts when two buttons are tapped in quick
      // succession (both would base on the same stale array).
      qc.setQueryData<DailyLogRow[]>(todayKey, (prev) => [...(prev ?? []), { log_date, [key]: 1 }]);
      const res = await dropPin(pin_type);
      if (!res.ok) {
        // Refetch server truth instead of restoring a snapshot that may
        // predate a concurrent tap's +1.
        qc.invalidateQueries({ queryKey: todayKey });
      } else {
        qc.invalidateQueries({ queryKey: ["my_pins_today", user.id] });
        // bump_daily_log_from_pin has committed — swap the synthetic row for
        // server truth and let the Log form / Stats / HUD refresh too.
        qc.invalidateQueries({ queryKey: dailyLogKeys.all(user.id) });
      }
    } finally {
      setPending(null);
    }
  }

  async function openLead() {
    setPending("lead");
    try {
      const res = await dropPin("lead");
      if (res.ok && user?.id) {
        qc.invalidateQueries({ queryKey: ["my_pins_today", user.id] });
        // Lead pins bump leads_called_in via trigger — refresh daily-log reads.
        qc.invalidateQueries({ queryKey: dailyLogKeys.all(user.id) });
      }
      setLeadOpen(true);
    } finally {
      setPending(null);
    }
  }

  return (
    <div className="space-y-6">
      <div>
        <div className="text-[10px] font-display uppercase tracking-widest text-muted-foreground">
          Field Mode
        </div>
        <h1 className="font-display text-2xl text-neon mt-1">ACTIVE RUN</h1>
        <p className="mt-2 text-sm text-muted-foreground">
          Tap fast. Every knock drops a pin on the map automatically.
        </p>
      </div>

      <div className="grid grid-cols-2 gap-3 sm:gap-4">
        {TALLIES.map((t) => (
          <TallyButton
            key={t.key}
            label={t.label}
            emoji={t.emoji}
            icon={t.icon}
            value={today?.[t.key] ?? 0}
            onClick={() => bump(t.key)}
            loading={pending === TALLY_TO_PIN[t.key]}
            color={t.color}
            subtle={t.subtle}
          />
        ))}
        <div className="pulse-glow-wrapper">
          <button
            type="button"
            onClick={openLead}
            disabled={pending === "lead"}
            className="arcade-btn-3d w-full h-full min-h-[9.5rem] flex flex-col items-center justify-center gap-2 p-4"
            style={{
              ["--btn-color" as string]: "var(--victory)",
              ["--btn-fg" as string]: "#06110a",
            }}
          >
            {pending === "lead" ? (
              <Loader2 className="w-8 h-8 animate-spin" />
            ) : (
              <Zap className="w-8 h-8" />
            )}
            <span className="font-display text-[11px] sm:text-xs uppercase tracking-widest text-center leading-tight">
              ⚡ Submit
              <br />
              New Lead
            </span>
          </button>
        </div>
      </div>

      {leadOpen && <LeadSheet onClose={() => setLeadOpen(false)} />}
    </div>
  );
}

function TallyButton({
  label,
  emoji,
  icon: Icon,
  value,
  onClick,
  loading,
  color,
  subtle,
}: {
  label: string;
  emoji: string;
  icon: typeof DoorOpen;
  value: number;
  onClick: () => void;
  loading: boolean;
  color: string;
  subtle?: boolean;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={loading}
      className="arcade-btn-3d min-h-[9.5rem] flex flex-col items-center justify-center gap-1.5 p-4"
      style={{
        ["--btn-color" as string]: color,
        ["--btn-fg" as string]: subtle ? "#f4f4f8" : "#0b0b12",
      }}
    >
      <div className="text-3xl leading-none">{emoji}</div>
      <div className="font-display text-[11px] sm:text-xs uppercase tracking-widest text-center">
        {label}
      </div>
      <div className="flex items-center gap-2 mt-1">
        {loading ? (
          <Loader2 className="w-6 h-6 animate-spin" />
        ) : (
          <>
            <Icon className="w-5 h-5" />
            <span className="font-display text-3xl tabular-nums">{value}</span>
          </>
        )}
      </div>
    </button>
  );
}

function LeadSheet({ onClose }: { onClose: () => void }) {
  // Read once on mount, never at module scope (localStorage + SSR safety).
  const [formUrl] = useState(getMondayFormUrl);
  return (
    <div className="fixed inset-0 z-50 bg-background flex flex-col">
      <div className="flex items-center justify-between px-4 py-3 border-b border-border bg-background">
        <div className="font-display text-xs uppercase tracking-widest text-neon">⚡ New Lead</div>
        <button
          type="button"
          onClick={onClose}
          aria-label="Close"
          className="rounded-full p-2 hover:bg-surface active:scale-95 transition"
        >
          <X className="w-6 h-6" />
        </button>
      </div>
      <iframe
        src={formUrl}
        title="Submit New Lead"
        className="flex-1 w-full border-0"
        allow="clipboard-write; camera; microphone; geolocation"
      />
    </div>
  );
}
