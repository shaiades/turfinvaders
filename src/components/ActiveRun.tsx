import { useMemo, useState, useEffect } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { supabase } from "@/integrations/supabase/client";
import { useAuth } from "@/hooks/useAuth";
import { requiresGratitudeGate } from "@/lib/roles";
import { assigneeColor } from "@/lib/assignee-colors";
import { laTodayISO } from "@/lib/dates";
import { getMondayFormUrl } from "@/lib/monday-form";
import { useGeoWatch, useFieldPins, type ActivePin } from "@/hooks/useFieldPins";
import { dailyLogKeys, sumLogCounters, useTodayLogs, type DailyLogRow } from "@/hooks/useDailyLogs";
import { useRealtimeInvalidate } from "@/hooks/useRealtimeInvalidate";
import { GratitudeGate, hasPassedGratitudeGate } from "@/components/GratitudeGate";
import { NeonMap, type Territory, type LatLng } from "@/components/NeonMap";
import { PinActionSheet } from "@/components/PinActionSheet";
import { ArcadePanel } from "@/components/arcade";
import { Sheet, SheetContent, SheetHeader, SheetTitle } from "@/components/ui/sheet";
import { Button } from "@/components/ui/button";
import { toast } from "sonner";
import {
  Home,
  Sparkles,
  Crosshair,
  Info,
  Pencil,
  ThumbsDown,
  KeyRound,
  Undo2,
  CalendarCheck,
  DoorOpen,
  MessagesSquare,
  Ban,
  Zap,
  X,
  Loader2,
} from "lucide-react";

/**
 * ACTIVE RUN — the one canvass screen (owner decision 2026-09-08, merging the
 * old /field tally page and /my-territory map page). Layout is one phone
 * screen: header strip, the live turf map with the armed-result switcher
 * floating on it, then the four big tally buttons. The Gratitude Gate fronts
 * the WHOLE screen now (it used to guard only the map).
 *
 * Two ways to log, both through useFieldPins:
 *  - Tally buttons: one tap per door at your own feet (pin = device fix).
 *  - Armed chips + map tap: result pins on specific houses (NH across the
 *    street, tonight's go-backs) — >18 m away flags a stat-dead Remote Drop.
 *
 * variant="captain" (their Territory tab): all turfs with assignee labels,
 * no polygon lock, no reassignment toast — and, new with the merge, captains
 * drop and correct their own pins like any canvasser. Turf drawing lives
 * behind the route's Turf Tools toggle (ManagerTerritoryView), not here.
 */

type TallyKey = "doors_knocked" | "people_talked_to" | "not_interested";
type PinType = ActivePin;

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

// The six knock results (owner directive 2026-08-15). Appt is map-only:
// appointments and sales are counted from Monday.com, never from pins.
const KNOCK_RESULTS: Array<{
  type: ActivePin;
  label: string;
  color: string;
  icon: React.ReactNode;
}> = [
  { type: "lead", label: "Lead", color: "#39ff14", icon: <Sparkles className="w-4 h-4" /> },
  { type: "not_home", label: "NH", color: "#ff2d55", icon: <Home className="w-4 h-4" /> },
  { type: "go_back", label: "GB", color: "#00e5ff", icon: <Undo2 className="w-4 h-4" /> },
  { type: "renter", label: "Renter", color: "#c77dff", icon: <KeyRound className="w-4 h-4" /> },
  {
    type: "not_interested",
    label: "NI",
    color: "#ff6b00",
    icon: <ThumbsDown className="w-4 h-4" />,
  },
  { type: "appt", label: "Appt", color: "#ffd60a", icon: <CalendarCheck className="w-4 h-4" /> },
];

type TurfRow = {
  id: string;
  name: string;
  color: string;
  polygon_coordinates: LatLng[];
  assigned_user_id: string | null;
  assigned_at: string | null;
  assignee: { display_name: string | null } | null;
};

export function ActiveRun({
  variant,
  onOpenTurfTools,
}: {
  variant: "canvasser" | "captain";
  onOpenTurfTools?: () => void;
}) {
  const { user, role, loading } = useAuth();
  const qc = useQueryClient();
  const isCaptain = variant === "captain";

  // Hold the OS location prompt until the Gratitude Gate is answered — day
  // one used to stack the prompt, the gate, and the keyboard all at once.
  // Roles the gate bypasses get GPS immediately.
  const [gatePassed, setGatePassed] = useState(false);
  useEffect(() => {
    const check = () => setGatePassed(hasPassedGratitudeGate(user?.id));
    check();
    window.addEventListener("ti-gratitude-unlocked", check);
    return () => window.removeEventListener("ti-gratitude-unlocked", check);
  }, [user?.id]);
  const { me, geoStatus } = useGeoWatch(!loading && (!requiresGratitudeGate(role) || gatePassed));
  const pins = useFieldPins(user?.id, me);

  const [active, setActive] = useState<ActivePin>("lead");
  const [editingPinId, setEditingPinId] = useState<string | null>(null);
  const [leadOpen, setLeadOpen] = useState(false);
  const [helpOpen, setHelpOpen] = useState(false);
  const [pending, setPending] = useState<PinType | null>(null);
  const log_date = laTodayISO();

  // Whole-day totals across office rows, from the shared today-logs cache —
  // the same rows the Log form, Stats page, and HUD read.
  const { data: todayRows } = useTodayLogs(user?.id);
  const today = sumLogCounters(todayRows);

  // Turfs: captains see every turf (their vans work all of them), canvassers
  // only their assigned (enforced by RLS too).
  const turfsQuery = useQuery({
    enabled: !!user?.id,
    queryKey: ["turfs", user?.id, role],
    queryFn: async () => {
      let q = supabase.from("turfs").select(
        `id, name, color, polygon_coordinates, assigned_user_id, assigned_at,
           assignee:profiles!turfs_assigned_user_id_fkey(display_name)`,
      );
      if (!isCaptain) q = q.eq("assigned_user_id", user!.id);
      const { data, error } = await q.order("created_at", { ascending: false });
      if (error) throw error;
      return (data ?? []) as unknown as TurfRow[];
    },
  });

  useRealtimeInvalidate({
    channel: "active-run-turfs",
    tables: ["turfs"],
    invalidateKeys: [["turfs"]],
    enabled: !!user?.id,
  });

  // Turf-arrival awareness — without this a mid-shift reassignment
  // (realtime refetch) just silently snaps the map to a different polygon.
  // Canvasser-only: captains see all turfs, so assignment churn would spam.
  useEffect(() => {
    if (isCaptain || !user?.id || !turfsQuery.isSuccess) return;
    const key = `turf-seen:v1:${user.id}`;
    const turfs = turfsQuery.data ?? [];
    const snapshot: Record<string, string> = {};
    for (const t of turfs) snapshot[t.id] = t.assigned_at ?? "";
    let stored: Record<string, string> | null = null;
    try {
      const raw = localStorage.getItem(key);
      stored = raw ? (JSON.parse(raw) as Record<string, string>) : null;
    } catch {
      stored = null;
    }
    if (stored != null) {
      const fresh = turfs.filter(
        (t) => stored[t.id] === undefined || (t.assigned_at ?? "") > stored[t.id],
      );
      if (fresh.length > 0) {
        const nm = fresh[0]?.name?.trim();
        toast.success(
          nm ? `🗺️ Turf assigned — ${nm}!` : "🗺️ New turf assigned — it's on your map!",
        );
      }
    }
    try {
      localStorage.setItem(key, JSON.stringify(snapshot));
    } catch {
      /* private mode etc. — awareness degrades, pins still work */
    }
  }, [isCaptain, user?.id, turfsQuery.isSuccess, turfsQuery.data]);

  const territories: Territory[] = useMemo(
    () =>
      (turfsQuery.data ?? []).map((t) => ({
        id: t.id,
        name: t.name,
        color: assigneeColor(t.assigned_user_id),
        polygon: (t.polygon_coordinates ?? []) as LatLng[],
        dashed: !t.assigned_user_id,
        // Canvassers get the turf's NAME on the pill — labeling their own map
        // with their own name told them nothing (go-live audit 2026-09-09).
        // Captains see all turfs, so assignee names stay the useful label.
        assignmentLabel: isCaptain
          ? t.assigned_user_id
            ? (t.assignee?.display_name ?? "Assigned")
            : "Unassigned"
          : t.name?.trim() || "Your turf",
      })),
    [turfsQuery.data, isCaptain],
  );

  // Memoized (structural sharing keeps turfsQuery.data stable) — this screen
  // re-renders on every GPS tick, and a fresh array identity per tick would
  // make LockToPolygon rebuild its per-vertex signature all shift long.
  const lockPolygons = useMemo(
    () =>
      (turfsQuery.data ?? [])
        .map((t) => (t.polygon_coordinates ?? []) as LatLng[])
        .filter((p) => p.length >= 3),
    [turfsQuery.data],
  );

  const armedResult = KNOCK_RESULTS.find((r) => r.type === active);

  // Map slot state: don't render a map with nothing to lock to — the
  // empty/error cards say what's happening instead of a Kansas-centered map.
  // Tally buttons stay live in every state; only the map slot swaps.
  const mapGate: "loading" | "error" | "empty" | "ready" = isCaptain
    ? "ready"
    : turfsQuery.isPending
      ? "loading"
      : turfsQuery.isError
        ? "error"
        : (turfsQuery.data ?? []).length === 0
          ? "empty"
          : "ready";

  const editingPin = editingPinId
    ? ((pins.pinsQuery.data ?? []).find((p) => p.id === editingPinId) ?? null)
    : null;

  async function bump(key: TallyKey) {
    if (!user?.id) return;
    // Block BEFORE the optimistic +1 (mirror of guardedMapDrop): without
    // this, a no-GPS tap counted up, waited out the 8 s fix timeout, then
    // silently rewound — a rookie's first knock looked like a glitch.
    if (!me) {
      toast.error("No GPS fix yet — enable Location and try again.");
      return;
    }
    const pin_type = TALLY_TO_PIN[key];
    const todayKey = dailyLogKeys.today(user.id, log_date);
    setPending(pin_type);
    try {
      // Optimistic +1 as an appended synthetic row via functional updater —
      // sumLogCounters folds it into the total, and a render-captured
      // snapshot would lose counts when two buttons are tapped in quick
      // succession (both would base on the same stale array).
      qc.setQueryData<DailyLogRow[]>(todayKey, (prev) => [...(prev ?? []), { log_date, [key]: 1 }]);
      const res = await pins.dropAtDevice(pin_type);
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
    if (!me) {
      toast.error("No GPS fix yet — enable Location and try again.");
      return;
    }
    setPending("lead");
    try {
      const res = await pins.dropAtDevice("lead");
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
    // GRATITUDE_GATE_ROLES decides who checks in; while auth is still
    // resolving the gate holds a blank beat so neither variant flashes.
    <GratitudeGate
      userId={user?.id}
      bypass={!loading && !requiresGratitudeGate(role)}
      pending={loading}
    >
      <div className="space-y-3 md:space-y-6">
        {/* One-line header: name left, GPS truth + tools right. The old
            two-page kicker/h1/blurb stack paid ~90px for words the tutorial
            already says — the map earns that space now. */}
        <div className="flex items-center justify-between gap-2">
          <h1 className="font-display text-sm sm:text-base text-neon uppercase tracking-widest">
            Active Run
          </h1>
          <div className="flex items-center gap-1.5">
            <span className="text-[10px] font-display uppercase tracking-widest text-muted-foreground flex items-center gap-1.5">
              <Crosshair className="w-3 h-3 text-[#00e5ff]" />
              {geoStatus === "denied" ? (
                <span className="text-destructive">GPS OFF</span>
              ) : me ? (
                "LIVE"
              ) : (
                "GPS…"
              )}
            </span>
            {isCaptain && onOpenTurfTools && (
              <button
                onClick={onOpenTurfTools}
                className="min-h-11 px-3 inline-flex items-center gap-1.5 rounded-md border border-[color-mix(in_oklab,var(--neon)_40%,var(--border))] text-[10px] font-display uppercase tracking-widest text-neon hover:bg-surface-elevated"
              >
                <Pencil className="w-3.5 h-3.5" /> Turf Tools
              </button>
            )}
            {/* Info, not CircleHelp — the header's "?" replays the tour, and
                two identical glyphs with different behaviors confused the
                audit's rookie pass. */}
            <button
              onClick={() => setHelpOpen(true)}
              aria-label="How Active Run works"
              className="md:hidden min-w-11 min-h-11 inline-flex items-center justify-center rounded-md text-muted-foreground hover:text-foreground hover:bg-surface-elevated"
            >
              <Info className="w-5 h-5" />
            </button>
          </div>
        </div>

        {/* GPS trouble is invisible otherwise — and a no-GPS pin never counts */}
        {geoStatus === "denied" && (
          <div className="rounded-lg border border-destructive/60 bg-destructive/10 p-3 text-sm text-destructive">
            <div className="font-display text-[10px] uppercase tracking-widest mb-1">
              Location blocked
            </div>
            Pins without GPS don't count. Enable Location for this site in your browser settings
            (iPhone: Settings → Apps → Safari → Location · Android: tap the icon left of the address
            bar), then reload.
          </div>
        )}
        {geoStatus !== "denied" && !me && (
          <div className="rounded-lg border border-border bg-surface/60 p-3 text-sm text-muted-foreground">
            Waiting for a GPS fix — pin drops unlock when the blue dot appears on the map.
          </div>
        )}

        <div className="md:grid md:grid-cols-5 md:gap-6 space-y-3 md:space-y-0">
          {/* ---- Map slot (the tour anchor covers every state, so the ring
               lands on the "no turf yet" panel too) ---- */}
          <div className="md:col-span-3" data-tour="field-map">
            {mapGate === "loading" && (
              <ArcadePanel title="My Turf">
                <div className="text-sm text-muted-foreground">Loading your turf…</div>
              </ArcadePanel>
            )}
            {mapGate === "error" && (
              <ArcadePanel title="My Turf">
                <div className="space-y-3">
                  <div className="text-sm text-muted-foreground">
                    Couldn't load your turf. Check your signal and try again.
                  </div>
                  <Button variant="outline" onClick={() => turfsQuery.refetch()}>
                    Retry
                  </Button>
                </div>
              </ArcadePanel>
            )}
            {mapGate === "empty" && (
              <ArcadePanel title="My Turf">
                <div className="text-sm text-muted-foreground">
                  No turf assigned yet — your manager assigns it before the shift. The tally buttons
                  below still work; your map fills in the moment your turf lands.
                </div>
              </ArcadePanel>
            )}
            {mapGate === "ready" && (
              <div className="relative">
                <NeonMap
                  territories={territories}
                  pins={pins.pinsQuery.data ?? []}
                  houses={[]}
                  me={me}
                  height="clamp(260px, 42dvh, 460px)"
                  follow
                  lockPolygons={!isCaptain ? lockPolygons : undefined}
                  mode={{
                    kind: "pin",
                    onDrop: (ll: LatLng) => pins.guardedMapDrop(ll, active),
                    armed: armedResult
                      ? { label: armedResult.label, color: armedResult.color }
                      : undefined,
                  }}
                  onPinClick={(id) => setEditingPinId(id)}
                />

                {/* Armed-result switcher pinned to the map — the ONE picker
                    (the old page's duplicate grid is gone with the merge) */}
                <div
                  data-tour="field-chips"
                  className="absolute bottom-3 left-1/2 -translate-x-1/2 z-[1000] flex items-center gap-1.5 rounded-full border border-border bg-surface/90 backdrop-blur px-2 py-1.5"
                >
                  {KNOCK_RESULTS.map((r) => {
                    const isArmed = active === r.type;
                    return (
                      <button
                        key={r.type}
                        type="button"
                        aria-label={`${r.label} — arm this result`}
                        onClick={() => setActive(r.type)}
                        className="relative flex h-11 w-11 items-center justify-center rounded-full"
                        style={{
                          color: r.color,
                          background: isArmed
                            ? `color-mix(in oklab, ${r.color} 22%, var(--surface))`
                            : "transparent",
                          boxShadow: isArmed
                            ? `0 0 0 2px ${r.color}, 0 0 14px -2px ${r.color}`
                            : "none",
                        }}
                      >
                        {r.icon}
                        <span
                          className="absolute -top-1 -right-1 min-w-4 rounded-full bg-surface px-1 text-center font-display text-[9px] leading-4"
                          style={{ color: r.color }}
                        >
                          {pins.counts[r.type] ?? 0}
                        </span>
                      </button>
                    );
                  })}
                </div>
              </div>
            )}
          </div>

          {/* ---- Tally slot ---- */}
          <div className="md:col-span-2 space-y-3 md:space-y-6">
            <div data-tour="field-tallies" className="grid grid-cols-2 gap-3">
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
              <div className="pulse-glow-wrapper" data-tour="field-lead">
                <button
                  type="button"
                  onClick={openLead}
                  disabled={pending === "lead"}
                  className="arcade-btn-3d w-full h-full min-h-[4.5rem] md:min-h-[8rem] flex items-center md:flex-col justify-center gap-2 p-3"
                  style={{
                    ["--btn-color" as string]: "var(--victory)",
                    ["--btn-fg" as string]: "#06110a",
                  }}
                >
                  {pending === "lead" ? (
                    <Loader2 className="w-7 h-7 animate-spin" />
                  ) : (
                    <Zap className="w-7 h-7" />
                  )}
                  <span className="font-display text-[11px] uppercase tracking-widest text-center leading-tight">
                    ⚡ Submit
                    <br />
                    New Lead
                  </span>
                </button>
              </div>
            </div>

            {/* Desktop keeps the help visible; phones get it behind the ⓘ */}
            <div className="hidden md:block">
              <HowItWorks />
            </div>
          </div>
        </div>
      </div>

      {leadOpen && <LeadSheet onClose={() => setLeadOpen(false)} />}

      {/* Pin corrections: tap a pin → switch result / delete (same-day only) */}
      <PinActionSheet
        open={!!editingPinId}
        onOpenChange={(v) => {
          if (!v) setEditingPinId(null);
        }}
        pin={editingPin}
        results={KNOCK_RESULTS}
        updating={pins.updatePin.isPending}
        deleting={pins.deletePin.isPending}
        onSelect={(pin_type) => {
          if (editingPinId) pins.updatePin.mutate({ id: editingPinId, pin_type });
          setEditingPinId(null);
        }}
        onDelete={() => {
          if (editingPinId) pins.deletePin.mutate(editingPinId);
          setEditingPinId(null);
        }}
      />

      {/* How-it-works bottom sheet (phones) */}
      <Sheet open={helpOpen} onOpenChange={setHelpOpen}>
        <SheetContent>
          <SheetHeader>
            <SheetTitle className="font-display text-sm uppercase tracking-widest text-neon">
              How Active Run works
            </SheetTitle>
          </SheetHeader>
          <div className="pt-2 pb-4">
            <HowItWorksList />
          </div>
        </SheetContent>
      </Sheet>
    </GratitudeGate>
  );
}

function HowItWorks() {
  return (
    <ArcadePanel title="How it works">
      <HowItWorksList />
    </ArcadePanel>
  );
}

function HowItWorksList() {
  return (
    <ul className="text-sm text-muted-foreground space-y-1.5">
      <li>• The big buttons log the door you're standing at — one tap each.</li>
      <li>• Your turf appears as a colored, named boundary on the map.</li>
      <li>• For other houses: pick a result on the map bar, then tap that house.</li>
      <li>
        • <span className="text-[#39ff14]">Lead</span> ·{" "}
        <span className="text-[#ff2d55]">NH = Not Home</span> ·{" "}
        <span className="text-[#00e5ff]">GB = Go Back</span> ·{" "}
        <span className="text-[#c77dff]">Renter</span> ·{" "}
        <span className="text-[#ff6b00]">NI = Not Interested</span> ·{" "}
        <span className="text-[#ffd60a]">Appt</span>.
      </li>
      <li>• Appt pins mark the house only — appointments and sales are counted from Monday.</li>
      <li>
        • Pins dropped more than about 20 yards from where you stand are flagged as Remote Drops and
        don't count.
      </li>
      <li>
        • Mis-tap? Tap the pin to switch its result or delete it — your stats adjust automatically
        (today only).
      </li>
    </ul>
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
    // Compact on phones (the map owns the vertical space now), tall on md+.
    <button
      type="button"
      onClick={onClick}
      disabled={loading}
      className="arcade-btn-3d min-h-[4.5rem] md:min-h-[8rem] flex items-center justify-between md:flex-col md:justify-center gap-2 px-3 py-2 md:p-4"
      style={{
        ["--btn-color" as string]: color,
        ["--btn-fg" as string]: subtle ? "#f4f4f8" : "#0b0b12",
      }}
    >
      <div className="flex items-center md:flex-col gap-1.5 min-w-0">
        <div className="text-2xl md:text-3xl leading-none shrink-0">{emoji}</div>
        <div className="font-display text-[10px] md:text-[11px] uppercase tracking-widest text-left md:text-center leading-tight">
          {label}
        </div>
      </div>
      <div className="flex items-center gap-1.5 shrink-0">
        {loading ? (
          <Loader2 className="w-5 h-5 animate-spin" />
        ) : (
          <>
            <Icon className="w-4 h-4 md:w-5 md:h-5" />
            <span className="font-display text-2xl md:text-3xl tabular-nums">{value}</span>
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
    // z-[2000]: the old /field had no map, but here Leaflet's panes and the
    // in-map chrome sit at z-[1000] in the same stacking context — z-50
    // would leave the recenter button poking through the lead form.
    <div className="fixed inset-0 z-[2000] bg-background flex flex-col">
      <div className="flex items-center justify-between px-4 py-3 border-b border-border bg-background">
        <div className="font-display text-xs uppercase tracking-widest text-neon">⚡ New Lead</div>
        <button
          type="button"
          onClick={onClose}
          aria-label="Close"
          className="min-w-11 min-h-11 inline-flex items-center justify-center rounded-full hover:bg-surface active:scale-95 transition"
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
