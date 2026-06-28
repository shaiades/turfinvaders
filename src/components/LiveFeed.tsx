import { useEffect, useState } from "react";
import { supabase } from "@/integrations/supabase/client";
import { Zap, TrendingUp, Sparkles } from "lucide-react";

type HypeEvent = {
  id: string;
  kind: "sale" | "level_up" | "custom";
  canvasser_name: string | null;
  message: string;
  created_at: string;
};

const KIND_STYLES: Record<
  HypeEvent["kind"],
  { icon: typeof Zap; ring: string; text: string; glow: string }
> = {
  sale: {
    icon: TrendingUp,
    ring: "ring-emerald-400/60",
    text: "text-emerald-300",
    glow: "shadow-[0_0_24px_rgba(52,211,153,0.55)]",
  },
  level_up: {
    icon: Sparkles,
    ring: "ring-fuchsia-400/60",
    text: "text-fuchsia-300",
    glow: "shadow-[0_0_24px_rgba(232,121,249,0.55)]",
  },
  custom: {
    icon: Zap,
    ring: "ring-cyan-400/60",
    text: "text-cyan-300",
    glow: "shadow-[0_0_24px_rgba(34,211,238,0.55)]",
  },
};

function timeAgo(iso: string) {
  const s = Math.max(1, Math.floor((Date.now() - new Date(iso).getTime()) / 1000));
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h`;
  return `${Math.floor(h / 24)}d`;
}

export function LiveFeed() {
  const [events, setEvents] = useState<HypeEvent[]>([]);
  const [flashId, setFlashId] = useState<string | null>(null);

  useEffect(() => {
    let mounted = true;

    (async () => {
      const { data } = await supabase
        .from("hype_events")
        .select("id, kind, canvasser_name, message, created_at")
        .order("created_at", { ascending: false })
        .limit(30);
      if (mounted && data) setEvents(data as HypeEvent[]);
    })();

    const channel = supabase
      .channel("hype_events_feed")
      .on(
        "postgres_changes",
        { event: "INSERT", schema: "public", table: "hype_events" },
        (payload) => {
          const ev = payload.new as HypeEvent;
          setEvents((prev) => [ev, ...prev].slice(0, 30));
          setFlashId(ev.id);
          setTimeout(() => setFlashId((id) => (id === ev.id ? null : id)), 2500);
        },
      )
      .subscribe();

    return () => {
      mounted = false;
      supabase.removeChannel(channel);
    };
  }, []);

  // Duplicate for seamless marquee loop
  const stream = events.length === 0
    ? [{
        id: "empty",
        kind: "custom" as const,
        canvasser_name: null,
        message: "Awaiting first transmission… drop a Sale to light up the feed.",
        created_at: new Date().toISOString(),
      }]
    : events;
  const loop = [...stream, ...stream];

  return (
    <div className="relative overflow-hidden rounded-2xl border border-cyan-400/30 bg-gradient-to-r from-slate-950 via-slate-900 to-slate-950 shadow-[0_0_36px_rgba(34,211,238,0.15)]">
      {/* Label */}
      <div className="absolute inset-y-0 left-0 z-10 flex shrink-0 items-center gap-2 bg-gradient-to-r from-slate-950 via-slate-950/95 to-transparent pl-3 pr-6 sm:pl-4">
        <span className="grid h-7 w-7 shrink-0 place-items-center rounded-lg bg-cyan-500/10 ring-1 ring-cyan-400/50 shadow-[0_0_14px_rgba(34,211,238,0.5)]">
          <Zap className="h-3.5 w-3.5 text-cyan-300" />
        </span>
        <span className="font-display text-[10px] uppercase tracking-[0.25em] text-cyan-300 sm:text-xs">
          Live Feed
        </span>
      </div>

      {/* Right fade */}
      <div className="pointer-events-none absolute inset-y-0 right-0 z-10 w-16 bg-gradient-to-l from-slate-950 to-transparent" />

      {/* Marquee */}
      <div className="flex w-full overflow-hidden py-3 pl-32 sm:pl-36">
        <div className="flex shrink-0 animate-[hype-marquee_48s_linear_infinite] items-center gap-3 whitespace-nowrap will-change-transform">
          {loop.map((ev, i) => {
            const s = KIND_STYLES[ev.kind];
            const Icon = s.icon;
            const isFlash = flashId === ev.id;
            return (
              <span
                key={`${ev.id}-${i}`}
                className={[
                  "inline-flex items-center gap-2 rounded-full border border-white/5 bg-white/[0.03] px-3 py-1.5 text-xs sm:text-sm",
                  "ring-1 transition-shadow",
                  s.ring,
                  isFlash ? `${s.glow} animate-pulse` : "shadow-none",
                ].join(" ")}
              >
                <Icon className={`h-3.5 w-3.5 ${s.text}`} />
                <span className={`font-semibold ${s.text}`}>{ev.message}</span>
                <span className="text-[10px] uppercase tracking-widest text-slate-500">
                  · {timeAgo(ev.created_at)} ago
                </span>
              </span>
            );
          })}
        </div>
      </div>

      <style>{`
        @keyframes hype-marquee {
          0%   { transform: translateX(0); }
          100% { transform: translateX(-50%); }
        }
      `}</style>
    </div>
  );
}
