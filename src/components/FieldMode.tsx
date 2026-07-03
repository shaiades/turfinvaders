import { useState } from "react";
import { useAuth } from "@/hooks/useAuth";
import { supabase } from "@/integrations/supabase/client";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import { DoorOpen, MessagesSquare, Ban, Zap, X, Loader2 } from "lucide-react";

const MONDAY_FORM_URL =
  "https://forms.monday.com/forms/embed/2e7e2733e186b6e9f3a37c17523f6e6f?r=use1";

type TallyKey = "doors_knocked" | "people_talked_to" | "not_interested";

function todayIso() {
  const d = new Date();
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, "0");
  const day = String(d.getDate()).padStart(2, "0");
  return `${y}-${m}-${day}`;
}

export function FieldMode() {
  const { user, teamId } = useAuth();
  const qc = useQueryClient();
  const [leadOpen, setLeadOpen] = useState(false);
  const [pending, setPending] = useState<TallyKey | null>(null);
  const log_date = todayIso();

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

  async function bump(key: TallyKey) {
    if (!user?.id) return;
    setPending(key);
    try {
      const current = today?.[key] ?? 0;
      const next = current + 1;
      const payload: Record<string, unknown> = {
        canvasser_id: user.id,
        log_date,
        [key]: next,
      };
      if (teamId) payload.team_id = teamId;
      const { error } = await (supabase.from("daily_logs") as unknown as {
        upsert: (v: unknown, o: { onConflict: string }) => Promise<{ error: Error | null }>;
      }).upsert(payload, { onConflict: "canvasser_id,log_date" });
      if (error) throw error;
      qc.setQueryData(["field-tally", user.id, log_date], {
        doors_knocked: today?.doors_knocked ?? 0,
        people_talked_to: today?.people_talked_to ?? 0,
        not_interested: today?.not_interested ?? 0,
        [key]: next,
      });
      if (typeof navigator !== "undefined" && "vibrate" in navigator) {
        try { navigator.vibrate?.(15); } catch { /* ignore */ }
      }
    } catch (e) {
      toast.error((e as Error).message || "Couldn't save tap");
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
          Tap fast. Every knock counts. Data syncs instantly.
        </p>
      </div>

      <div className="grid grid-cols-2 gap-3 sm:gap-4">
        <TallyButton
          label="Log Knock"
          emoji="🚪"
          icon={DoorOpen}
          value={today?.doors_knocked ?? 0}
          onClick={() => bump("doors_knocked")}
          loading={pending === "doors_knocked"}
          color="var(--neon-blue)"
        />
        <TallyButton
          label="Talked To"
          emoji="🗣️"
          icon={MessagesSquare}
          value={today?.people_talked_to ?? 0}
          onClick={() => bump("people_talked_to")}
          loading={pending === "people_talked_to"}
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
        <button
          type="button"
          onClick={() => setLeadOpen(true)}
          className="arcade-btn-3d min-h-[9.5rem] flex flex-col items-center justify-center gap-2 p-4"
          style={{ ["--btn-color" as string]: "var(--victory)", ["--btn-fg" as string]: "#06110a" }}
        >
          <Zap className="w-8 h-8" />
          <span className="font-display text-[11px] sm:text-xs uppercase tracking-widest text-center leading-tight">
            ⚡ Submit<br />New Lead
          </span>
        </button>
      </div>

      <button
        type="button"
        onClick={() => setLeadOpen(true)}
        className="arcade-btn-3d w-full py-6 sm:py-8 font-display text-xl sm:text-2xl uppercase tracking-widest hidden"
        style={{ ["--btn-color" as string]: "var(--victory)", ["--btn-fg" as string]: "#06110a" }}
      >
        <Zap className="inline w-7 h-7 mr-2 -mt-1" />
        Submit New Lead
      </button>

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
  accent,
}: {
  label: string;
  emoji: string;
  icon: typeof DoorOpen;
  value: number;
  onClick: () => void;
  loading: boolean;
  accent: "neon" | "victory" | "warning";
}) {
  const glow =
    accent === "neon"
      ? "shadow-[0_0_36px_-8px_color-mix(in_oklab,var(--neon-magenta)_80%,transparent)] border-[var(--neon-magenta)]/60"
      : accent === "victory"
        ? "shadow-[0_0_36px_-8px_color-mix(in_oklab,var(--victory)_80%,transparent)] border-[var(--victory)]/60"
        : "shadow-[0_0_36px_-8px_color-mix(in_oklab,var(--warning)_80%,transparent)] border-[var(--warning)]/60";

  const textColor =
    accent === "neon" ? "text-neon" : accent === "victory" ? "text-victory" : "text-[var(--warning)]";

  return (
    <button
      type="button"
      onClick={onClick}
      disabled={loading}
      className={`arcade-card ${glow} border-2 rounded-2xl p-6 min-h-[9.5rem] flex flex-col items-center justify-center gap-2 active:scale-[0.97] transition disabled:opacity-70`}
    >
      <div className="text-4xl leading-none">{emoji}</div>
      <div className={`font-display text-xs uppercase tracking-widest ${textColor}`}>
        {label}
      </div>
      <div className="flex items-center gap-2 mt-1">
        {loading ? (
          <Loader2 className="w-6 h-6 animate-spin text-muted-foreground" />
        ) : (
          <>
            <Icon className={`w-6 h-6 ${textColor}`} />
            <span className={`font-display text-4xl ${textColor} tabular-nums`}>
              {value}
            </span>
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
