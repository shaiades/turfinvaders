import { useMemo, useState, useEffect } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { supabase } from "@/integrations/supabase/client";
import { useAuth } from "@/hooks/useAuth";
import { requiresGratitudeGate } from "@/lib/roles";
import { assigneeColor } from "@/lib/assignee-colors";
import { getMondayFormUrl } from "@/lib/monday-form";
import { useGeoWatch, useFieldPins, type ActivePin } from "@/hooks/useFieldPins";
import { usePiggyBank } from "@/hooks/usePiggyBank";
import { useZipTints } from "@/hooks/useZipAssignments";
import { dailyLogKeys } from "@/hooks/useDailyLogs";
import { PiggyBankHUD } from "@/components/PiggyBankHUD";
import { useRealtimeInvalidate } from "@/hooks/useRealtimeInvalidate";
import { GratitudeGate, hasPassedGratitudeGate } from "@/components/GratitudeGate";
import { NeonMap, type Territory, type LatLng } from "@/components/NeonMap";
import { PinActionSheet } from "@/components/PinActionSheet";
import { HouseResultSheet } from "@/components/HouseResultSheet";
import { FieldStandingsSheet } from "@/components/FieldStandingsSheet";
import type { OsmHouse } from "@/components/HouseBubbles";
import { ArcadePanel } from "@/components/arcade";
import { Button } from "@/components/ui/button";
import { toast } from "sonner";
import {
  Home,
  Sparkles,
  Crosshair,
  Pencil,
  ThumbsDown,
  KeyRound,
  Undo2,
  Trophy,
  Zap,
  X,
  Loader2,
} from "lucide-react";

/**
 * ACTIVE RUN — the one canvass screen (owner decision 2026-09-08, merging the
 * old /field tally page and /my-territory map page). Simplified 2026-09-10
 * (owner directive, D2DU-video parity): no more "hit Knock, then what
 * happened" — the rep logs THE RESULT, and every result counts as a knock
 * (the reworked bump_daily_log_from_pin cascades doors/talked server-side).
 *
 * Three ways to log, all through useFieldPins:
 *  - House bubbles: tap the house on the map → one-tap result sheet.
 *  - Armed chips + map tap: result pins on houses without a bubble (rural,
 *    new builds) — >18 m away still flags a stat-dead Remote Drop.
 *  The screen is map-first (owner 2026-09-11): no key grid — the map gets
 *  the room, Submit New Lead keeps its own big key below.
 *
 * variant="captain" (their Territory tab): all turfs with assignee labels,
 * no turf framing, no reassignment toast — captains drop and correct their
 * own pins like any canvasser. Turf drawing lives behind the route's Turf
 * Tools toggle (ManagerTerritoryView), not here.
 */

type PinType = ActivePin;

// The knock results (owner directive 2026-08-15; one-tap-counts since
// 2026-09-10; Appt REMOVED 2026-09-11 — "appt set and submit new lead are
// the same technically": setting an appointment IS submitting a lead, so
// the Lead flow owns it. Legacy appt pins keep rendering via pin-results.
const KNOCK_RESULTS: Array<{
  type: ActivePin;
  label: string;
  color: string;
  icon: React.ReactNode;
}> = [
  {
    type: "lead",
    label: "Lead",
    color: "#39ff14",
    icon: <Sparkles className="w-4 h-4" />,
  },
  {
    type: "not_home",
    label: "NH",
    color: "#ff2d55",
    icon: <Home className="w-4 h-4" />,
  },
  {
    type: "go_back",
    label: "GB",
    color: "#00e5ff",
    icon: <Undo2 className="w-4 h-4" />,
  },
  {
    type: "renter",
    label: "Renter",
    color: "#c77dff",
    icon: <KeyRound className="w-4 h-4" />,
  },
  {
    type: "not_interested",
    label: "NI",
    color: "#ff6b00",
    icon: <ThumbsDown className="w-4 h-4" />,
  },
];

// The armed-chip bar drops Lead from the vocabulary (owner call 2026-09-11:
// "just use Submit New Lead") — an armed map-tap lead pin skipped the Monday
// form entirely, minting lead pins with no lead behind them. The house sheet
// keeps its Lead tile because that path opens the form (it IS Submit New
// Lead, anchored to the tapped house), and corrections keep the full list.
const ARMED_RESULTS = KNOCK_RESULTS.filter((r) => r.type !== "lead");

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
  // Captains see their ZIP zones tinted while canvassing — the frame they
  // chunk turfs inside. Canvassers keep plain borders (their turf is the map).
  const zipZones = useZipTints({ enabled: isCaptain });

  const [active, setActive] = useState<ActivePin>("not_home");
  const [editingPinId, setEditingPinId] = useState<string | null>(null);
  const [leadOpen, setLeadOpen] = useState(false);
  const [pending, setPending] = useState<PinType | null>(null);
  const [houseTarget, setHouseTarget] = useState<OsmHouse | null>(null);
  const [standingsOpen, setStandingsOpen] = useState(false);

  // Piggy bank: projected dollars per knock. ?piggy_demo=1 fakes knocks
  // locally and never touches real state; parsed after mount because this
  // route SSRs and a render-time window read is a hydration mismatch.
  const piggy = usePiggyBank(user?.id);
  const [piggyDemo, setPiggyDemo] = useState<{ on: boolean; rateMs?: number }>({ on: false });
  useEffect(() => {
    const params = new URLSearchParams(window.location.search);
    if (params.get("piggy_demo") === "1") {
      setPiggyDemo({ on: true, rateMs: Number(params.get("piggy_rate")) || undefined });
    }
  }, []);

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

        {/* ---- Map slot — the screen IS the map (owner 2026-09-11: "way
             bigger", result-key grid removed: tapping a house circle offers
             the same results, armed chips cover bubble-less spots). The tour
             anchor covers every state so the ring lands on the "no turf yet"
             panel too. ---- */}
        <div data-tour="field-map">
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
                No turf assigned yet — your manager assigns it before the shift. ⚡ Submit New Lead
                still works; your map fills in the moment your turf lands.
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
                height="clamp(420px, 64dvh, 900px)"
                follow
                fitPolygons={!isCaptain ? lockPolygons : undefined}
                houseBubbles
                zipTints={isCaptain ? zipZones.tints : undefined}
                onHouseTap={(h) => setHouseTarget(h)}
                mode={{
                  kind: "pin",
                  onDrop: (ll: LatLng) => pins.guardedMapDrop(ll, active),
                  armed: armedResult
                    ? { label: armedResult.label, color: armedResult.color }
                    : undefined,
                }}
                onPinClick={(id) => setEditingPinId(id)}
              />

              {/* Piggy bank — every knock is worth money, watch it stack */}
              <div data-tour="field-bank" className="absolute top-3 left-3 z-[1000]">
                <PiggyBankHUD
                  dollars={piggy.dollars}
                  perKnock={piggy.perKnock}
                  knocks={piggy.knocks}
                  paceKnocks={piggy.paceKnocks}
                  source={piggy.source}
                  demo={piggyDemo.on}
                  demoRateMs={piggyDemo.rateMs}
                />
              </div>

              {/* Standings — the video app's leaderboard, one tap from the map */}
              <button
                type="button"
                data-tour="field-standings"
                aria-label="Open standings"
                onClick={() => setStandingsOpen(true)}
                className="absolute bottom-16 left-3 z-[1000] flex h-11 w-11 items-center justify-center rounded-full border border-neon/60 bg-surface/90 backdrop-blur text-neon"
              >
                <Trophy className="h-5 w-5" />
              </button>

              {/* Armed-result switcher pinned to the map — the ONE picker
                    (the old page's duplicate grid is gone with the merge) */}
              <div
                data-tour="field-chips"
                className="absolute bottom-3 left-1/2 -translate-x-1/2 z-[1000] flex items-center gap-1.5 rounded-full border border-border bg-surface/90 backdrop-blur px-2 py-1.5"
              >
                {ARMED_RESULTS.map((r) => {
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

        {/* Submit New Lead keeps its own key (owner call 2026-09-10) — the
            other results live on the house circles and the map bar now. */}
        <div className="pulse-glow-wrapper w-full" data-tour="field-lead">
          <button
            type="button"
            onClick={openLead}
            disabled={pending === "lead"}
            className="arcade-btn-3d w-full min-h-[3.75rem] md:min-h-[4.25rem] flex items-center justify-center gap-2.5 px-4"
            style={{
              ["--btn-color" as string]: "var(--victory)",
              ["--btn-fg" as string]: "#06110a",
            }}
          >
            {pending === "lead" ? (
              <Loader2 className="w-6 h-6 animate-spin" />
            ) : (
              <Zap className="w-6 h-6" />
            )}
            <span className="font-display text-xs md:text-sm uppercase tracking-widest">
              Submit New Lead
            </span>
          </button>
        </div>

        {/* The old "Today · N doors · N talked" footer and the How-it-works
            panel are gone (audit 2026-09-11): the piggy pill + chip badges
            already count the day, and the "?" tour replay owns onboarding —
            third copies earn nothing on a phone. */}
      </div>

      {leadOpen && <LeadSheet onClose={() => setLeadOpen(false)} />}

      {/* One-tap result on a tapped house bubble (drop or same-day switch) */}
      <HouseResultSheet
        open={!!houseTarget}
        onOpenChange={(v) => {
          if (!v) setHouseTarget(null);
        }}
        house={houseTarget}
        results={KNOCK_RESULTS}
        busy={pins.dropAtPoint.isPending || pins.updatePin.isPending}
        onDrop={(h, pin_type) => {
          pins.guardedMapDrop({ lat: h.lat, lng: h.lng }, pin_type);
          // A lead IS the Monday form — the pin marks the house, the form
          // submits the lead (one flow, owner directive 2026-09-10).
          if (pin_type === "lead") setLeadOpen(true);
        }}
        onSwitch={(pinId, pin_type) => pins.updatePin.mutate({ id: pinId, pin_type })}
      />

      {/* SALE / DK / PTT / CL% standings + Stats Key */}
      <FieldStandingsSheet open={standingsOpen} onOpenChange={setStandingsOpen} />

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

    </GratitudeGate>
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
