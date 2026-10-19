// Shared conversion visuals: the five-stage funnel bars and the at-the-door
// result cards. Used by the canvasser's own Stats tab (Mon–Sat live) and the
// manager's per-player profile (Day/Week/Month range) — one visual language
// for conversion everywhere. Leaflet-free on purpose (SSR-safe).

import { PIN_COLORS, type PinType } from "@/lib/pin-results";
import {
  CalendarCheck,
  DoorOpen,
  Home,
  KeyRound,
  MessageSquare,
  PhoneCall,
  PhoneMissed,
  Sparkles,
  ThumbsDown,
  Undo2,
} from "lucide-react";

export type FunnelCounts = {
  doors: number;
  talks: number;
  leads: number;
  sits: number;
  sales: number;
};

export type FunnelStage = { label: string; value: number; color: string };

export function funnelStages(c: FunnelCounts): FunnelStage[] {
  return [
    { label: "Doors", value: c.doors, color: "#ff2d55" },
    { label: "Talks", value: c.talks, color: "#ffd60a" },
    { label: "Leads", value: c.leads, color: "#39ff14" },
    { label: "Sits", value: c.sits, color: "#00e5ff" },
    { label: "Sales", value: c.sales, color: "#c77dff" },
  ];
}

/** Step ratio vs the previous stage. Stages are independent daily_logs
 *  counters (sits often land in a later week than their lead), so ratios
 *  cap at "100%+" rather than pretending the funnel is a strict cohort. */
function stepPct(n: number, of: number): string {
  if (of <= 0) return "—";
  const r = Math.round((n / of) * 100);
  return r > 100 ? "100%+" : `${r}%`;
}

export function FunnelStageBars({ stages }: { stages: FunnelStage[] }) {
  const max = Math.max(1, ...stages.map((s) => s.value));
  return (
    <div className="space-y-2.5">
      {stages.map((s, i) => {
        const prev = i > 0 ? stages[i - 1].value : null;
        return (
          <div key={s.label} className="flex items-center gap-2 min-w-0">
            <div className="w-16 shrink-0 text-[10px] font-display uppercase tracking-widest text-muted-foreground truncate">
              {s.label}
            </div>
            <div className="flex-1 min-w-0 h-4 rounded bg-background/60 overflow-hidden">
              <div
                className="h-full rounded"
                style={{
                  width: `${Math.min(100, Math.max(s.value > 0 ? 2 : 0, (s.value / max) * 100))}%`,
                  background: s.color,
                  boxShadow: `0 0 10px color-mix(in srgb, ${s.color} 60%, transparent)`,
                }}
              />
            </div>
            <div
              className="w-10 shrink-0 text-right font-display text-sm"
              style={{ color: s.color }}
            >
              {s.value.toLocaleString()}
            </div>
            <div className="w-14 shrink-0 text-right text-[10px] uppercase tracking-widest text-muted-foreground">
              {prev == null ? "" : stepPct(s.value, prev)}
            </div>
          </div>
        );
      })}
      <div className="text-[10px] uppercase tracking-widest text-muted-foreground pt-1">
        Leads = confirmed · Sits &amp; Sales sync from Monday
      </div>
    </div>
  );
}

// Result cards use the picker's abbreviations so they fit 375px; legacy pin
// types only render when they actually occur in the window.
const RESULT_ORDER: Array<{
  type: PinType;
  label: string;
  icon: React.ReactNode;
  alwaysShow: boolean;
}> = [
  { type: "lead", label: "Lead", icon: <Sparkles className="w-3.5 h-3.5" />, alwaysShow: true },
  { type: "not_home", label: "NH", icon: <Home className="w-3.5 h-3.5" />, alwaysShow: true },
  { type: "go_back", label: "GB", icon: <Undo2 className="w-3.5 h-3.5" />, alwaysShow: true },
  { type: "renter", label: "Renter", icon: <KeyRound className="w-3.5 h-3.5" />, alwaysShow: true },
  {
    type: "not_interested",
    label: "NI",
    icon: <ThumbsDown className="w-3.5 h-3.5" />,
    alwaysShow: true,
  },
  // Appt was retired as a knock result 2026-09-11 (the Lead flow owns it) —
  // legacy appt pins still render, but a permanent zero card earns nothing.
  {
    type: "appt",
    label: "Appt",
    icon: <CalendarCheck className="w-3.5 h-3.5" />,
    alwaysShow: false,
  },
  {
    type: "talked_to",
    label: "Talked",
    icon: <MessageSquare className="w-3.5 h-3.5" />,
    alwaysShow: false,
  },
  { type: "knock", label: "Knock", icon: <DoorOpen className="w-3.5 h-3.5" />, alwaysShow: false },
];

// The same vocabulary heard on the phones (Dial Run / call_logs): dial=knock,
// no answer=not_home, callback=go_back. renter/appt are door-only and absent
// from call_logs by CHECK constraint, so they're simply not listed.
const PHONE_RESULT_ORDER: Array<{
  type: PinType;
  label: string;
  icon: React.ReactNode;
  alwaysShow: boolean;
}> = [
  { type: "lead", label: "Lead", icon: <Sparkles className="w-3.5 h-3.5" />, alwaysShow: true },
  {
    type: "talked_to",
    label: "Talked",
    icon: <MessageSquare className="w-3.5 h-3.5" />,
    alwaysShow: true,
  },
  {
    type: "not_home",
    label: "No Ans",
    icon: <PhoneMissed className="w-3.5 h-3.5" />,
    alwaysShow: true,
  },
  { type: "go_back", label: "CB", icon: <Undo2 className="w-3.5 h-3.5" />, alwaysShow: true },
  {
    type: "not_interested",
    label: "NI",
    icon: <ThumbsDown className="w-3.5 h-3.5" />,
    alwaysShow: true,
  },
  // A bare dial (never tagged) counts the dial only — show the card when any
  // exist so untagged work is visible, not mysterious.
  { type: "knock", label: "Dial", icon: <PhoneCall className="w-3.5 h-3.5" />, alwaysShow: false },
];

export type PinRowLite = { pin_type: PinType; is_remote_drop: boolean | null };

export function countPins(pins: readonly PinRowLite[]) {
  const counted = pins.filter((p) => !p.is_remote_drop);
  const byType = counted.reduce<Partial<Record<PinType, number>>>((a, p) => {
    a[p.pin_type] = (a[p.pin_type] ?? 0) + 1;
    return a;
  }, {});
  return { byType, total: counted.length, remote: pins.length - counted.length };
}

export function DoorResultsGrid({
  pins,
  channel = "door",
}: {
  pins: readonly PinRowLite[];
  /** "phone" renders the Dial Run vocabulary (call_logs rows cast to
   *  PinRowLite — same enum, phone labels). */
  channel?: "door" | "phone";
}) {
  const { byType, total, remote } = countPins(pins);
  const order = channel === "phone" ? PHONE_RESULT_ORDER : RESULT_ORDER;
  return (
    <>
      <div className="grid grid-cols-2 sm:grid-cols-3 gap-2">
        {order
          .filter((r) => r.alwaysShow || (byType[r.type] ?? 0) > 0)
          .map((r) => {
            const n = byType[r.type] ?? 0;
            const color = PIN_COLORS[r.type];
            return (
              <div
                key={r.type}
                className="rounded-lg border p-3 min-w-0"
                style={{
                  borderColor: `color-mix(in oklab, ${color} 30%, var(--border))`,
                  background: `color-mix(in oklab, ${color} 5%, var(--surface))`,
                }}
              >
                <div
                  className="flex items-center gap-1.5 text-[9px] font-display uppercase tracking-widest truncate"
                  style={{ color }}
                >
                  {r.icon} <span className="truncate">{r.label}</span>
                </div>
                <div className="mt-2 flex items-end justify-between gap-2">
                  <span
                    className="font-display text-2xl leading-none"
                    style={{
                      color,
                      textShadow: `0 0 12px color-mix(in srgb, ${color} 55%, transparent)`,
                    }}
                  >
                    {n}
                  </span>
                  <span className="text-[10px] uppercase tracking-widest text-muted-foreground">
                    {total > 0 ? `${Math.round((n / total) * 100)}%` : "0%"}
                  </span>
                </div>
              </div>
            );
          })}
      </div>
      <div className="mt-3 text-[10px] uppercase tracking-widest text-muted-foreground">
        {channel === "phone"
          ? "Leads are worked on the Monday board · untagged dials count the dial only."
          : `Appt pins mark the house — appointments & sales are counted from Monday.${
              remote > 0 ? ` · ${remote} remote drop(s) excluded` : ""
            }`}
      </div>
    </>
  );
}
