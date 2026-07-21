import { useEffect, useRef, useState } from "react";
import { useAuth } from "@/hooks/useAuth";
import { supabase } from "@/integrations/supabase/client";
import { laTodayISO } from "@/lib/dates";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import { DoorOpen, MessagesSquare, Ban, Zap, X, Loader2 } from "lucide-react";

const MONDAY_FORM_URL =
  "https://forms.monday.com/forms/embed/2e7e2733e186b6e9f3a37c17523f6e6f?r=use1";

type TallyKey = "doors_knocked" | "people_talked_to" | "not_interested";
type PinType = "knock" | "talked_to" | "not_interested" | "lead";

const TALLY_TO_PIN: Record<TallyKey, PinType> = {
  doors_knocked: "knock",
  people_talked_to: "talked_to",
  not_interested: "not_interested",
};

// Field-pin log_date is the LA calendar day (never viewer-local).
const todayIso = () => laTodayISO();

function getFix(): Promise<GeolocationPosition | null> {
  return new Promise((resolve) => {
    if (typeof navigator === "undefined" || !navigator.geolocation) return resolve(null);
    navigator.geolocation.getCurrentPosition(
      (p) => resolve(p),
      () => resolve(null),
      { enableHighAccuracy: true, maximumAge: 8000, timeout: 8000 },
    );
  });
}

export function FieldMode() {
  const { user, teamId } = useAuth();
  const qc = useQueryClient();
  const [leadOpen, setLeadOpen] = useState(false);
  const [pending, setPending] = useState<PinType | null>(null);
  const log_date = todayIso();
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

  const { data: today } = useQuery({
    queryKey: ["field-tally", user?.id, log_date],
    enabled: !!user?.id,
    queryFn: async () => {
      const { data } = await supabase
        .from("daily_logs")
        .select("doors_knocked, people_talked_to, not_interested")
        .eq("canvasser_id", user!.id)
        .eq("log_date", log_date)
        .maybeSingle();
      return {
        doors_knocked: data?.doors_knocked ?? 0,
        people_talked_to: data?.people_talked_to ?? 0,
        not_interested: (data as { not_interested?: number } | null)?.not_interested ?? 0,
      };
    },
  });

  async function dropPin(pin_type: PinType, opts?: { silent?: boolean }) {
    if (!user?.id) return { ok: false as const };
    const fix = await getFix();
    if (!fix) {
      toast.error("No GPS fix yet — enable Location and try again.");
      return { ok: false as const };
    }
    const payload: Record<string, unknown> = {
      canvasser_id: user.id,
      pin_type,
      lat: fix.coords.latitude,
      lng: fix.coords.longitude,
      log_date,
      device_lat: fix.coords.latitude,
      device_lng: fix.coords.longitude,
      distance_m: 0,
      is_remote_drop: false,
    };
    if (teamId) payload.team_id = teamId;
    const { error } = await supabase.from("field_pins").insert(payload as never);
    if (error) {
      toast.error(error.message || "Couldn't save pin");
      return { ok: false as const };
    }
    if (!opts?.silent && typeof navigator !== "undefined" && "vibrate" in navigator) {
      try { navigator.vibrate?.(15); } catch { /* ignore */ }
    }
    return { ok: true as const };
  }

  async function bump(key: TallyKey) {
    const pin_type = TALLY_TO_PIN[key];
    setPending(pin_type);
    try {
      // Optimistic UI
      qc.setQueryData(["field-tally", user?.id, log_date], {
        doors_knocked: (today?.doors_knocked ?? 0) + (key === "doors_knocked" ? 1 : 0),
        people_talked_to: (today?.people_talked_to ?? 0) + (key === "people_talked_to" ? 1 : 0),
        not_interested: (today?.not_interested ?? 0) + (key === "not_interested" ? 1 : 0),
      });
      const res = await dropPin(pin_type);
      if (!res.ok) {
        // Revert
        qc.setQueryData(["field-tally", user?.id, log_date], today);
      } else {
        qc.invalidateQueries({ queryKey: ["territory_pins_today"] });
      }
    } finally {
      setPending(null);
    }
  }

  async function openLead() {
    setPending("lead");
    try {
      const res = await dropPin("lead");
      if (res.ok) qc.invalidateQueries({ queryKey: ["territory_pins_today"] });
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
        <TallyButton
          label="Log Knock"
          emoji="🚪"
          icon={DoorOpen}
          value={today?.doors_knocked ?? 0}
          onClick={() => bump("doors_knocked")}
          loading={pending === "knock"}
          color="var(--neon-blue)"
        />
        <TallyButton
          label="Talked To"
          emoji="🗣️"
          icon={MessagesSquare}
          value={today?.people_talked_to ?? 0}
          onClick={() => bump("people_talked_to")}
          loading={pending === "talked_to"}
          color="var(--neon-orange)"
        />
        <TallyButton
          label="Not Interested"
          emoji="🛑"
          icon={Ban}
          value={today?.not_interested ?? 0}
          onClick={() => bump("not_interested")}
          loading={pending === "not_interested"}
          color="oklch(0.55 0.02 270)"
          subtle
        />
        <div className="pulse-glow-wrapper">
          <button
            type="button"
            onClick={openLead}
            disabled={pending === "lead"}
            className="arcade-btn-3d w-full h-full min-h-[9.5rem] flex flex-col items-center justify-center gap-2 p-4"
            style={{ ["--btn-color" as string]: "var(--victory)", ["--btn-fg" as string]: "#06110a" }}
          >
            {pending === "lead" ? (
              <Loader2 className="w-8 h-8 animate-spin" />
            ) : (
              <Zap className="w-8 h-8" />
            )}
            <span className="font-display text-[11px] sm:text-xs uppercase tracking-widest text-center leading-tight">
              ⚡ Submit<br />New Lead
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
  return (
    <div className="fixed inset-0 z-50 bg-background flex flex-col">
      <div className="flex items-center justify-between px-4 py-3 border-b border-border bg-background">
        <div className="font-display text-xs uppercase tracking-widest text-neon">
          ⚡ New Lead
        </div>
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
        src={MONDAY_FORM_URL}
        title="Submit New Lead"
        className="flex-1 w-full border-0"
        allow="clipboard-write; camera; microphone; geolocation"
      />
    </div>
  );
}
