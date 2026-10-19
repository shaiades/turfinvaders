import { useMemo, useState, useEffect, useRef } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { supabase } from "@/integrations/supabase/client";
import { useAuth } from "@/hooks/useAuth";
import { requiresGratitudeGate } from "@/lib/roles";
import { assigneeColor } from "@/lib/assignee-colors";
import {
  getMondayFormUrlWithPrefill,
  isLeadCloseV2Enabled,
  LEAD_SUBMITTED_MESSAGE_TYPE,
  savePendingLead,
  clearPendingLead,
  readPendingLead,
  MAX_PENDING_LEAD_RESTORES,
} from "@/lib/monday-form";
import { useCanvasserProfile } from "@/hooks/useCanvasserProfile";
import { useGeoWatch, useFieldPins, type ActivePin } from "@/hooks/useFieldPins";
import { usePiggyBank } from "@/hooks/usePiggyBank";
import { useZipTints } from "@/hooks/useZipAssignments";
import { dailyLogKeys } from "@/hooks/useDailyLogs";
import { PiggyBankHUD } from "@/components/PiggyBankHUD";
import { BumpBadge } from "@/components/BumpBadge";
import { LeadStrikeFx } from "@/components/LeadStrikeFx";
import { usePrefersReducedMotion } from "@/hooks/usePrefersReducedMotion";
import { useRealtimeInvalidate } from "@/hooks/useRealtimeInvalidate";
import { GratitudeGate } from "@/components/GratitudeGate";
import { NeonMap, type Territory, type LatLng } from "@/components/NeonMap";
import { getLastMapView, setLastMapView, type MapView } from "@/lib/last-map-view";
import type { MapDataStatus } from "@/lib/map-status";
import { PinActionSheet } from "@/components/PinActionSheet";
import { QuickClockIn } from "@/components/QuickClockIn";
import { NextDollarChip, RankChip } from "@/components/MoneyChips";
import { HouseResultSheet } from "@/components/HouseResultSheet";
import { FieldStandingsSheet } from "@/components/FieldStandingsSheet";
import { DoorScriptSheet } from "@/components/DoorScriptSheet";
import { RebuttalCard } from "@/components/RebuttalCard";
import { prefetchTurfHouses, type OsmHouse } from "@/components/HouseBubbles";
import { ArcadePanel } from "@/components/arcade";
import { toast } from "sonner";
import { haptic } from "@/lib/arcade-fx";
import { rewardToast } from "@/lib/reward-toast";
import {
  Copy,
  DoorClosed,
  Sparkles,
  Crosshair,
  Pencil,
  ThumbsDown,
  KeyRound,
  Clock3,
  Loader2,
  RefreshCw,
  ScrollText,
  Sun,
  Trophy,
  Users,
  Zap,
  X,
} from "lucide-react";

/** The office's Address-question format ("5375 Avenida Encinas, 92008") for
 *  a house-anchored lead. OSM-grade only: no OSM housenumber, no address —
 *  a reverse-geocoded number can be interpolated onto the neighbor and must
 *  never reach the lead pipeline. */
function houseLeadAddress(h: OsmHouse | null): string | null {
  if (!h?.num || !h.street) return null;
  return `${h.num} ${h.street}${h.zip ? `, ${h.zip}` : ""}`;
}

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
 *    new builds) — >75 yd away still flags a stat-dead Remote Drop.
 *  The screen is map-first (owner 2026-09-11): no key grid — the map gets
 *  the room, Submit New Lead keeps its own big key below.
 *
 * variant="captain" (their Territory tab): all turfs with assignee labels,
 * no turf framing, no reassignment toast — captains drop and correct their
 * own pins like any canvasser. Turf drawing lives behind the route's Turf
 * Tools toggle (ManagerTerritoryView), not here.
 */

// The knock results (owner directive 2026-08-15; one-tap-counts since
// 2026-09-10; Appt REMOVED 2026-09-11 — "appt set and submit new lead are
// the same technically": setting an appointment IS submitting a lead, so
// the Lead flow owns it. Legacy appt pins keep rendering via pin-results.
// label = the short badge/legend form; fullLabel = the words the sheets
// spell out; chipLabel = the caption under the armed chips (owner ask
// 2026-09-12: icon-only chips were riddles — a HOUSE icon meaning "nobody
// home" and an undo arrow meaning "come back later" told rookies nothing).
const KNOCK_RESULTS: Array<{
  type: ActivePin;
  label: string;
  fullLabel: string;
  chipLabel: string;
  color: string;
  icon: React.ReactNode;
}> = [
  {
    type: "lead",
    label: "Lead",
    fullLabel: "Lead",
    chipLabel: "Lead",
    color: "#39ff14",
    icon: <Sparkles className="w-4 h-4" />,
  },
  {
    type: "not_home",
    label: "NH",
    fullLabel: "Not Home",
    chipLabel: "Not Home",
    color: "#ff2d55",
    icon: <DoorClosed className="w-4 h-4" />,
  },
  {
    type: "go_back",
    label: "GB",
    fullLabel: "Go Back Later",
    chipLabel: "Go Back",
    color: "#00e5ff",
    icon: <Clock3 className="w-4 h-4" />,
  },
  {
    type: "renter",
    label: "Renter",
    fullLabel: "Renter",
    chipLabel: "Renter",
    color: "#c77dff",
    icon: <KeyRound className="w-4 h-4" />,
  },
  {
    type: "not_interested",
    label: "NI",
    fullLabel: "Not Interested",
    chipLabel: "Not Int.",
    color: "#ff6b00",
    icon: <ThumbsDown className="w-4 h-4" />,
  },
];

// The sheets spell results out in full — abbreviations were the barrier,
// and the tap tiles have the room.
const SHEET_RESULTS = KNOCK_RESULTS.map((r) => ({ ...r, label: r.fullLabel }));

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
  onOpenCrewMap,
}: {
  variant: "canvasser" | "captain";
  onOpenTurfTools?: () => void;
  onOpenCrewMap?: () => void;
}) {
  const { user, role, loading, realDisplayName, teamId } = useAuth();
  const qc = useQueryClient();
  const isCaptain = variant === "captain";

  // Map + GPS start the moment the screen opens (audit 2026-10-15, Phase 3
  // §1) — the gratitude ritual no longer holds anything back; it pops as a
  // one-tap card AFTER the first logged door (see <GratitudeGate> below).
  const { me, geoStatus } = useGeoWatch(!loading && !!user);
  const pins = useFieldPins(user?.id, me);
  // Objection quick-pick toggle (captain feedback 2026-09-17) — same inline
  // company_settings read used at dashboard.tsx and canvassers.$id.tsx.
  const companySettingsQuery = useQuery({
    queryKey: ["company_settings"],
    queryFn: async () => (await supabase.from("company_settings").select("*").maybeSingle()).data,
  });
  const objectionsEnabled = !!companySettingsQuery.data?.objections_quickpick_enabled;
  // Crew Map beacon: moved to AppShell (<CrewBeacon/>, owner ask 2026-09-14)
  // so reps broadcast from EVERY tab, not just this screen — this watch's
  // first fix still writes the geo-granted marker that arms it.
  // Captains see their ZIP zones tinted while canvassing — the frame they
  // chunk turfs inside. Canvassers keep plain borders (their turf is the map).
  const zipZones = useZipTints({ enabled: isCaptain });
  // Lead-form prefill: profiles.display_name is the exact string the Monday
  // webhook's Agent matcher keys on, so prefilled beats doorstep-typed.
  // Same cache entry the HUD/piggy surfaces already warm (30s staleTime).
  const selfProfile = useCanvasserProfile(user?.id);

  // No armed result by default (audit 2026-10-15, Phase 3 §3): the old
  // "not_home" default meant any stray map tap dropped a pin. A rep now arms
  // a chip first; tapping the armed chip again disarms it.
  const [active, setActive] = useState<ActivePin | null>(null);
  const [editingPinId, setEditingPinId] = useState<string | null>(null);
  const [leadOpen, setLeadOpen] = useState(false);
  // Phase 3 §4: the lead pin drops only after the Monday form actually
  // submits — this remembers WHERE it should land (the tapped house, an
  // existing pin to convert, or the device) while the form is open.
  const pendingLeadRef = useRef<
    | { kind: "house"; lat: number; lng: number }
    | { kind: "switch"; pinId: string }
    | { kind: "device" }
    | null
  >(null);
  // House-anchored Lead flow only: the tapped house's OSM-grade address,
  // shown in the LeadSheet header + sent as the form's `address` prefill
  // param so the rep never re-types what the map already knows.
  const [leadAddress, setLeadAddress] = useState<string | null>(null);
  const [houseTarget, setHouseTarget] = useState<OsmHouse | null>(null);
  const [standingsOpen, setStandingsOpen] = useState(false);
  // The door script, one tap from the map (Phase 2 §1).
  const [scriptOpen, setScriptOpen] = useState(false);
  // 3-second rebuttal card after a tagged objection (Phase 2 §2). seq bumps
  // per showing so a repeat of the same objection re-arms the timer.
  const [rebuttal, setRebuttal] = useState<{ seq: number; objection: string } | null>(null);

  // Talk combo (Phase 4 §4): consecutive CONVERSATION results — the same pin
  // types the bump trigger counts as people_talked_to (talked_to, renter,
  // go_back, lead, not_interested) — build a streak chip; a not_home breaks
  // it. Pure hype, client-only, resets with the screen.
  const [combo, setCombo] = useState(0);
  const TALK_TYPES = useMemo(
    () => new Set<ActivePin>(["talked_to", "renter", "go_back", "lead", "not_interested"]),
    [],
  );
  const registerResult = (pin_type: ActivePin) => {
    setCombo((c) => {
      if (!TALK_TYPES.has(pin_type)) return 0;
      const next = c + 1;
      if (next >= 3) haptic([10, 30, 10, 30, 10]);
      return next;
    });
  };

  // Sun mode (Phase 3 §2): solid fills, no glow, boosted contrast — ON by
  // default for the field. Applied as a class on <html> so the portaled
  // sheets inherit it too; removed when the screen unmounts. localStorage
  // read happens post-mount (this route SSRs).
  const [sunMode, setSunMode] = useState(true);
  useEffect(() => {
    try {
      setSunMode(localStorage.getItem("ti_sun_mode_v1") !== "0");
    } catch {
      /* private mode — default stays on */
    }
  }, []);
  useEffect(() => {
    const el = document.documentElement;
    if (sunMode) el.classList.add("sun-mode");
    else el.classList.remove("sun-mode");
    return () => el.classList.remove("sun-mode");
  }, [sunMode]);
  const toggleSunMode = () =>
    setSunMode((s) => {
      const next = !s;
      try {
        localStorage.setItem("ti_sun_mode_v1", next ? "1" : "0");
      } catch {
        /* private mode */
      }
      return next;
    });

  // Piggy bank: projected dollars per knock. ?piggy_demo=1 fakes knocks
  // locally and never touches real state; parsed after mount because this
  // route SSRs and a render-time window read is a hydration mismatch.
  const piggy = usePiggyBank(user?.id);
  const [piggyDemo, setPiggyDemo] = useState<{ on: boolean; rateMs?: number }>({ on: false });
  // Lead-submitted coin burst: the pin's own coin plays while the LeadSheet
  // (z-[2000]) covers the map, so the win is replayed on close where the rep
  // can SEE it. `dollars` is the measured piggy delta across the sheet —
  // real, column-traceable, never a fabricated lead value.
  const [piggyCelebrate, setPiggyCelebrate] = useState<{ seq: number; dollars: number } | null>(
    null,
  );
  const piggyAtLeadOpenRef = useRef<number | null>(null);
  // Lead-strike cutscene: the 2.2s Doorstep Finisher plays full-screen AFTER
  // the LeadSheet closes on a detected submit, THEN hands off to
  // piggyCelebrate + rewardToast (sonner's z-999999999 and the map-layer
  // coins would both fight the overlay if fired concurrently). `dollars`
  // freezes the close-time measured delta so onDone never re-reads live
  // piggy state (a late-settling pin would double-count vs the knock-coin).
  const prefersReducedMotion = usePrefersReducedMotion();
  const [leadStrike, setLeadStrike] = useState<{ seq: number; dollars: number } | null>(null);
  useEffect(() => {
    const params = new URLSearchParams(window.location.search);
    if (params.get("piggy_demo") === "1") {
      setPiggyDemo({ on: true, rateMs: Number(params.get("piggy_rate")) || undefined });
    }
    // ?lead_strike_demo=1 screens the cutscene with zero DB traffic
    // (piggy_demo precedent — parsed post-mount, this route SSRs).
    if (params.get("lead_strike_demo") === "1") {
      setLeadStrike({ seq: 1, dollars: 0 });
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
    // Turf assignments change rarely and realtime invalidation (below)
    // pushes changes within ~1s — a remount on weak cellular should serve
    // the cached polygons instantly instead of re-fetching over the dead
    // link (CrewMap's 5m precedent).
    staleTime: 5 * 60_000,
    gcTime: 30 * 60_000,
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

  // Preload the day's houses over morning WiFi/parking-lot signal, into the
  // disk store, so weak mid-turf cellular serves circles from cache.
  // Canvassers only (a captain's query returns EVERY turf — prefetching all
  // of them would hammer the public Overpass mirrors); 4s delay cedes the
  // network to the visible viewport's own fetch; the sig-set inside
  // prefetchTurfHouses dedupes realtime turf refetches.
  useEffect(() => {
    if (isCaptain || !turfsQuery.isSuccess || lockPolygons.length === 0) return;
    const t = window.setTimeout(() => {
      void prefetchTurfHouses(lockPolygons);
    }, 4_000);
    return () => window.clearTimeout(t);
  }, [isCaptain, turfsQuery.isSuccess, lockPolygons]);

  const armedResult = active ? KNOCK_RESULTS.find((r) => r.type === active) : undefined;
  // Unarmed-tap hint, throttled so a double tap doesn't stack toasts.
  const lastArmHintRef = useRef(0);

  // Map slot state: the map mounts IMMEDIATELY — tiles start downloading
  // while turfs load, and the on-map status pill narrates loading/error
  // (with retry) instead of a text panel holding the whole slot hostage on
  // weak cellular. Only the settled "no turf assigned" state keeps its
  // panel — that's product truth with its own copy, not a network moment.
  const mapGate: "empty" | "ready" =
    !isCaptain && turfsQuery.isSuccess && (turfsQuery.data ?? []).length === 0 ? "empty" : "ready";
  const turfDataStatus: MapDataStatus = {
    // isPending (first load, no cached rows) — a background refetch never
    // flashes the pill.
    state: turfsQuery.isPending ? "loading" : turfsQuery.isError ? "error" : "ok",
    what: isCaptain ? "turfs" : "your turf",
    onRetry: () => void turfsQuery.refetch(),
  };
  // Saved-view suppression of the turf fit must FREEZE at map mount: the
  // map now mounts before turfs land, and FollowMe's first GPS pan feeds
  // onViewChange — re-evaluating getLastMapView() per render would then
  // suppress the fit forever, even on a first-ever login. Frozen on the
  // first render where auth is resolved (GratitudeGate holds children
  // until then, so the map cannot have mounted earlier).
  const savedViewRef = useRef<MapView | null | undefined>(undefined);
  if (savedViewRef.current === undefined && user?.id) {
    savedViewRef.current = getLastMapView(user.id);
  }
  const savedView = savedViewRef.current ?? null;

  const editingPin = editingPinId
    ? ((pins.pinsQuery.data ?? []).find((p) => p.id === editingPinId) ?? null)
    : null;

  function openLead(
    address: string | null = null,
    target: NonNullable<typeof pendingLeadRef.current> = { kind: "device" },
  ) {
    // Form first, pin NEVER before the lead exists (Phase 3 §4): the old
    // drop-on-open left phantom lead pins (door/talk credits, green stars,
    // lead badges) for forms that were closed unsubmitted. The pin now lands
    // in the LeadSheet close handler, only when Monday confirmed the submit.
    // No GPS fix no longer blocks the form either — the sale beats the pin;
    // a no-GPS submit gets flagged to the office instead (close handler).
    setLeadAddress(address);
    piggyAtLeadOpenRef.current = piggy.dollars;
    pendingLeadRef.current = target;
    // Crash insurance: iOS killing the page mid-form (white screen, field
    // report 2026-10-16) wiped this ref and silently ate the knock. The
    // mirror below lets the restore effect reopen the form after a reload.
    savePendingLead(target, address);
    setLeadOpen(true);
  }

  // Crash recovery: a fresh pending-lead snapshot on mount means the page
  // died (or was reloaded) while the lead form was open — reopen it with the
  // same target/address so the knock isn't lost. Waits for auth so the
  // reopened form still gets the agent-name prefill (attribution keys on
  // it); ref-guarded so it restores at most once per page load. Capped
  // restores: a device the embed reliably kills (field report 2026-10-19)
  // must not auto-reopen into the crash forever — after the cap, stop and
  // say so instead of looping white screens.
  const restoredLeadRef = useRef(false);
  useEffect(() => {
    if (restoredLeadRef.current || loading || !user?.id) return;
    restoredLeadRef.current = true;
    const snap = readPendingLead();
    if (!snap) return;
    const restores = snap.restores ?? 0;
    if (restores >= MAX_PENDING_LEAD_RESTORES) {
      clearPendingLead();
      toast.error(
        snap.address
          ? `The lead form keeps crashing this phone — your lead at ${snap.address} was NOT submitted. Write it down and log it after the shift.`
          : "The lead form keeps crashing this phone — that lead was NOT submitted. Write it down and log it after the shift.",
        { duration: 15000 },
      );
      return;
    }
    savePendingLead(snap.target, snap.address, restores + 1);
    pendingLeadRef.current = snap.target;
    setLeadAddress(snap.address);
    setLeadOpen(true);
    toast.info("Picking up where you left off — the app reloaded mid-lead.");
  }, [loading, user?.id]);

  return (
    // GRATITUDE_GATE_ROLES decides who checks in; while auth is still
    // resolving the gate holds a blank beat so neither variant flashes.
    // Phase 3 §1: it's a one-tap card AFTER the first logged door now —
    // the map and GPS never wait for it.
    <GratitudeGate
      userId={user?.id}
      bypass={!loading && !requiresGratitudeGate(role)}
      pending={loading}
      promptArmed={Object.values(pins.counts).reduce((a, n) => a + n, 0) > 0}
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
            {/* Punch in without leaving the street (Phase 3 §1) */}
            <QuickClockIn userId={user?.id} clockHref={isCaptain ? "/mission" : "/dashboard"} />
            <span className="text-xs font-semibold uppercase text-muted-foreground flex items-center gap-1.5">
              <Crosshair className="w-3 h-3 text-[#00e5ff]" />
              {geoStatus === "denied" ? (
                <span className="text-destructive">GPS OFF</span>
              ) : me ? (
                "LIVE"
              ) : (
                "GPS…"
              )}
            </span>
            {isCaptain && onOpenCrewMap && (
              <button
                onClick={onOpenCrewMap}
                aria-label="Crew Map"
                title="Crew Map — everyone's pins & live positions"
                className="min-h-11 min-w-11 inline-flex items-center justify-center rounded-md border border-[color-mix(in_oklab,var(--accent)_45%,var(--border))] text-[var(--accent)] hover:bg-surface-elevated"
              >
                <Users className="w-4 h-4" />
              </button>
            )}
            {isCaptain && onOpenTurfTools && (
              <button
                onClick={onOpenTurfTools}
                className="min-h-11 px-3 inline-flex items-center gap-1.5 rounded-md border border-[color-mix(in_oklab,var(--neon)_40%,var(--border))] text-xs font-semibold uppercase text-neon hover:bg-surface-elevated"
              >
                <Pencil className="w-3.5 h-3.5" /> Turf Tools
              </button>
            )}
          </div>
        </div>

        {/* GPS trouble is invisible otherwise — and a no-GPS pin never counts */}
        {geoStatus === "denied" && (
          <div className="rounded-lg border border-destructive/60 bg-destructive/10 p-3 text-sm text-destructive">
            <div className="text-xs font-bold uppercase mb-1">Location blocked</div>
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
          {mapGate === "empty" && (
            <ArcadePanel title="My Turf">
              <div className="text-sm text-muted-foreground">
                No turf assigned yet — your manager assigns it before the shift. ⚡ Submit New Lead
                still works; your map fills in the moment your turf lands.
              </div>
            </ArcadePanel>
          )}
          {/* !leadOpen: the satellite map UNMOUNTS while the Monday embed is
              up. Both at once is the page's peak memory, and iOS was killing
              the whole page right as the form opened (white screens, field
              reports 2026-10-16/19) — the sheet fully covers the screen
              anyway, and the close handler re-reads the persisted view so
              the map comes back exactly where the rep left it. */}
          {mapGate === "ready" && !leadOpen && (
            <NeonMap
              territories={territories}
              pins={pins.mapPins}
              houses={[]}
              me={me}
              height="clamp(420px, 64dvh, 900px)"
              follow
              // Skip the initial turf-lock fit once a view was already saved
              // AT MOUNT (Turf Tools round-trip, or yesterday's persisted
              // spot) — restore that position instead of snapping back to
              // the turf frame. Frozen (savedView) so the map's own moves
              // can't retroactively suppress a first-login fit.
              fitPolygons={savedView ? [] : lockPolygons}
              center={savedView?.center}
              initialZoom={savedView?.zoom}
              initialBearing={savedView?.bearing}
              onViewChange={(v) => setLastMapView(v, user?.id)}
              dataStatus={turfDataStatus}
              houseBubbles
              zipTints={isCaptain ? zipZones.tints : undefined}
              onHouseTap={(h) => setHouseTarget(h)}
              // Captains get Turf Tools on the map rail too (owner ask
              // 2026-09-28) — the header copy vanishes in fullscreen.
              onOpenTurfTools={isCaptain ? onOpenTurfTools : undefined}
              mode={{
                kind: "pin",
                // Nothing armed → a map tap drops NOTHING (Phase 3 §3): the
                // old not_home default turned every stray tap into a pin.
                onDrop: (ll: LatLng) => {
                  if (!active) {
                    const now = Date.now();
                    if (now - lastArmHintRef.current > 2500) {
                      lastArmHintRef.current = now;
                      toast("Pick a result chip first — then tap the house.", {
                        duration: 2000,
                      });
                    }
                    return;
                  }
                  pins.guardedMapDrop(ll, active);
                  registerResult(active);
                },
                armed: armedResult
                  ? { label: armedResult.label, color: armedResult.color }
                  : undefined,
              }}
              onPinClick={(id) => setEditingPinId(id)}
              // Inside the map frame (not siblings) so piggy/trophy/chips
              // ride along when the map goes fullscreen.
              overlay={
                <>
                  {/* Live Today rank — one tap into the standings (Phase 4 §3) */}
                  <RankChip userId={user?.id} onOpen={() => setStandingsOpen(true)} />

                  {/* The nearest real money on the table (Phase 4 §2) */}
                  <NextDollarChip userId={user?.id} />

                  {/* Piggy bank — every knock is worth money, watch it stack
                      (below the rank chip since Phase 4 took top-left) */}
                  <div data-tour="field-bank" className="absolute top-[3.75rem] left-3 z-[1000]">
                    <PiggyBankHUD
                      dollars={piggy.dollars}
                      perKnock={piggy.perKnock}
                      knocks={piggy.knocks}
                      paceKnocks={piggy.paceKnocks}
                      source={piggy.source}
                      demo={piggyDemo.on}
                      demoRateMs={piggyDemo.rateMs}
                      celebrate={piggyCelebrate}
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

                  {/* The Script — Shai's door script, one tap, stacked above
                      the trophy on the left rail (Phase 2 §1) */}
                  <button
                    type="button"
                    data-tour="field-script"
                    aria-label="Open the door script"
                    onClick={() => setScriptOpen(true)}
                    className="absolute bottom-[7.5rem] left-3 z-[1000] flex h-11 w-11 items-center justify-center rounded-full border border-neon/60 bg-surface/90 backdrop-blur text-neon"
                  >
                    <ScrollText className="h-5 w-5" />
                  </button>

                  {/* Sun mode — solid fills / no glow for direct sunlight
                      (Phase 3 §2); ON by default, remembered per device */}
                  <button
                    type="button"
                    aria-label={sunMode ? "Sun mode on — tap for arcade look" : "Turn on sun mode"}
                    aria-pressed={sunMode}
                    onClick={toggleSunMode}
                    className={`absolute bottom-[11rem] left-3 z-[1000] flex h-11 w-11 items-center justify-center rounded-full border backdrop-blur ${
                      sunMode
                        ? "border-[var(--warning)] bg-surface text-[var(--warning)]"
                        : "border-border bg-surface/90 text-muted-foreground"
                    }`}
                  >
                    <Sun className="h-5 w-5" />
                  </button>

                  {/* Rebuttal flash after a tagged objection — reads on the
                      walk to the next door, survives map fullscreen */}
                  {rebuttal && (
                    <RebuttalCard
                      key={rebuttal.seq}
                      seq={rebuttal.seq}
                      objection={rebuttal.objection}
                      onDone={() => setRebuttal(null)}
                    />
                  )}

                  {/* Talk combo — consecutive conversations, broken by a
                      Not Home (Phase 4 §4). Shows from 2 up. */}
                  {combo >= 2 && (
                    <div
                      aria-live="polite"
                      className="absolute bottom-[4.9rem] left-1/2 -translate-x-1/2 z-[1000] rounded-full border border-[var(--warning)] bg-surface px-3 py-1 text-xs font-bold uppercase text-[var(--warning)]"
                    >
                      🔥 {combo} talks in a row
                    </div>
                  )}

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
                          aria-label={`${r.fullLabel} — ${isArmed ? "disarm" : "arm"} this result`}
                          aria-pressed={isArmed}
                          // Tap again to DISARM — stray map taps then drop
                          // nothing (Phase 3 §3).
                          onClick={() => setActive(isArmed ? null : r.type)}
                          className="relative flex min-h-11 min-w-16 flex-col items-center justify-center gap-1 rounded-xl px-2 py-1.5"
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
                          {/* 12px body font — the 7px display-caps label was
                              unreadable in sunlight (Phase 3 §2) */}
                          <span className="text-xs font-semibold uppercase leading-none whitespace-nowrap">
                            {r.chipLabel}
                          </span>
                          <BumpBadge count={pins.counts[r.type] ?? 0} color={r.color} />
                        </button>
                      );
                    })}
                  </div>
                </>
              }
            />
          )}
        </div>

        {/* Submit New Lead keeps its own key (owner call 2026-09-10) — the
            other results live on the house circles and the map bar now. */}
        <div className="pulse-glow-wrapper w-full" data-tour="field-lead">
          <button
            type="button"
            onClick={() => openLead()}
            aria-label={
              (pins.counts["lead"] ?? 0) > 0
                ? `Submit New Lead — ${pins.counts["lead"]} leads today`
                : "Submit New Lead"
            }
            className="arcade-btn-3d w-full min-h-[3.75rem] md:min-h-[4.25rem] flex items-center justify-center gap-2.5 px-4"
            style={{
              ["--btn-color" as string]: "var(--victory)",
              ["--btn-fg" as string]: "#06110a",
            }}
          >
            <Zap className="w-6 h-6" />
            <span className="font-display text-xs md:text-sm uppercase tracking-widest">
              Submit New Lead
            </span>
          </button>
          {/* pointer-events-none: the badge overlays the button's corner —
              a tap there must still open the form. Count is announced via
              the button's aria-label (a bare span's isn't). */}
          {(pins.counts["lead"] ?? 0) > 0 && (
            <span
              aria-hidden
              className="pointer-events-none absolute -top-1.5 -right-1.5 z-10 min-w-5 rounded-full border bg-surface px-1.5 text-center text-xs font-bold leading-5"
              style={{ color: "#39ff14", borderColor: "#39ff14" }}
            >
              {pins.counts["lead"]}
            </span>
          )}
        </div>

        {/* The old "Today · N doors · N talked" footer and the How-it-works
            panel are gone (audit 2026-09-11): the piggy pill + chip badges
            already count the day, and the "?" tour replay owns onboarding —
            third copies earn nothing on a phone. */}
      </div>

      {leadOpen && (
        <LeadSheet
          prefill={{
            // realDisplayName, never displayName: the lead's Agent is a
            // WRITE — a View As name pick must not sign someone else's name.
            agent: selfProfile.data?.display_name ?? realDisplayName ?? null,
            office: selfProfile.data?.office_location ?? null,
            address: leadAddress,
          }}
          onClose={(submitted) => {
            // The map unmounted while the sheet was up — re-read the
            // persisted view (onViewChange kept it current) so the remount
            // lands where the rep actually was, not the morning's spot.
            if (user?.id) {
              savedViewRef.current = getLastMapView(user.id) ?? savedViewRef.current;
            }
            setLeadOpen(false);
            const closingAddress = leadAddress;
            setLeadAddress(null);
            // Phase 3 §4: the lead pin exists only once the lead does. On a
            // detected submit, land the remembered target (tapped house /
            // pin-to-convert / device spot); an abandoned form drops nothing
            // — no more phantom lead pins.
            const target = pendingLeadRef.current;
            pendingLeadRef.current = null;
            clearPendingLead();
            if (submitted && target) {
              if (target.kind === "switch") {
                pins.updatePin.mutate({ id: target.pinId, pin_type: "lead" });
              } else if (target.kind === "house") {
                pins.guardedMapDrop({ lat: target.lat, lng: target.lng }, "lead");
                registerResult("lead");
              } else {
                void pins.dropAtDevice("lead");
                registerResult("lead");
              }
              // No GPS fix → the pin can't land, but the LEAD is already in
              // Monday. Flag it to the office (Desk pending queue) so the
              // address gets confirmed with the homeowner — fire-and-forget,
              // the doorstep never waits on it.
              if (!me && target.kind !== "switch" && user?.id) {
                void supabase
                  .from("leads")
                  .insert({
                    canvasser_id: user.id,
                    team_id: teamId ?? null,
                    customer_name: null,
                    address: closingAddress,
                    is_sale: false,
                    sale_amount: null,
                    notes:
                      "⚠ Submitted from the field WITHOUT a GPS fix — confirm the address with the homeowner (full details on the Monday card).",
                  })
                  .then(({ error }) => {
                    if (!error) qc.invalidateQueries({ queryKey: ["pending_leads"] });
                  });
              }
            }
            // Close-out refresh: reconcile the pin insert, the trigger-bumped
            // daily-log counters (HUD Leads, Stats, Log), and the my-leads
            // list — the exact keys a hard refresh used to buy.
            if (user?.id) {
              qc.invalidateQueries({ queryKey: ["my_pins_today", user.id] });
              qc.invalidateQueries({ queryKey: dailyLogKeys.all(user.id) });
              qc.invalidateQueries({ queryKey: ["my_leads", user.id] });
            }
            if (submitted) {
              try {
                navigator.vibrate?.([15, 60, 15]);
              } catch {
                /* unsupported */
              }
              // Measured across the sheet — if the background pin hadn't
              // settled by close, delta is 0 and the late knock-coin carries
              // the $ instead (no double count).
              const delta =
                piggy.dollars !== null && piggyAtLeadOpenRef.current !== null
                  ? Math.max(0, piggy.dollars - piggyAtLeadOpenRef.current)
                  : 0;
              if (prefersReducedMotion) {
                // No cutscene — the reward still lands, exactly as before.
                setPiggyCelebrate((c) => ({ seq: (c?.seq ?? 0) + 1, dollars: delta }));
                rewardToast("⚡ Lead submitted — it's on the board!", { vibrate: false });
              } else {
                // Doorstep Finisher first; coins + toast fire from onDone.
                setLeadStrike((s) => ({ seq: (s?.seq ?? 0) + 1, dollars: delta }));
              }
            }
          }}
        />
      )}

      {/* Doorstep Finisher — plays over the returned map; on done the coin
          burst + gold toast land as the receipt. key={seq} guarantees a
          fresh timeline on rapid re-submits; demo: ?lead_strike_demo=1. */}
      {leadStrike && (
        <LeadStrikeFx
          key={leadStrike.seq}
          onDone={() => {
            setLeadStrike(null);
            setPiggyCelebrate((c) => ({ seq: (c?.seq ?? 0) + 1, dollars: leadStrike.dollars }));
            rewardToast("⚡ Lead submitted — it's on the board!", { vibrate: false });
          }}
        />
      )}

      {/* One-tap result on a tapped house bubble (drop or same-day switch) */}
      <HouseResultSheet
        open={!!houseTarget}
        onOpenChange={(v) => {
          if (!v) setHouseTarget(null);
        }}
        house={houseTarget}
        results={SHEET_RESULTS}
        busy={pins.dropAtPoint.isPending || pins.updatePin.isPending}
        objectionsEnabled={objectionsEnabled}
        onDrop={(h, pin_type, objection) => {
          // A lead IS the Monday form (one flow, owner directive 2026-09-10)
          // — but since Phase 3 §4 the pin waits for the SUBMIT: the house
          // target rides in pendingLeadRef and lands in the close handler,
          // so an abandoned form leaves no phantom lead pin.
          if (pin_type === "lead") {
            openLead(houseLeadAddress(h), { kind: "house", lat: h.lat, lng: h.lng });
            return;
          }
          pins.guardedMapDrop({ lat: h.lat, lng: h.lng }, pin_type, objection);
          registerResult(pin_type);
          if (objection) setRebuttal((r) => ({ seq: (r?.seq ?? 0) + 1, objection }));
        }}
        onSwitch={(pinId, pin_type, objection) => {
          // Switching a result TO lead is submitting a lead — the pin
          // conversion also waits for the Monday submit now.
          if (pin_type === "lead") {
            openLead(houseLeadAddress(houseTarget), { kind: "switch", pinId });
            return;
          }
          pins.updatePin.mutate({ id: pinId, pin_type, objection });
          if (objection) setRebuttal((r) => ({ seq: (r?.seq ?? 0) + 1, objection }));
        }}
      />

      {/* SALE / DK / PTT / CL% standings + Stats Key */}
      <FieldStandingsSheet open={standingsOpen} onOpenChange={setStandingsOpen} />

      {/* Shai's door script — 6-step stepper (src/data/door-script.ts) */}
      <DoorScriptSheet open={scriptOpen} onOpenChange={setScriptOpen} />

      {/* Pin corrections: tap a pin → switch result / delete (same-day only) */}
      <PinActionSheet
        open={!!editingPinId}
        onOpenChange={(v) => {
          if (!v) setEditingPinId(null);
        }}
        pin={editingPin}
        results={SHEET_RESULTS}
        updating={pins.updatePin.isPending}
        deleting={pins.deletePin.isPending}
        onSelect={(pin_type) => {
          // Correcting a pin TO lead opens the form; the conversion waits
          // for the Monday submit (Phase 3 §4). No house context on a bare
          // pin — no address prefill.
          if (pin_type === "lead") {
            const pinId = editingPinId;
            setEditingPinId(null);
            if (pinId) openLead(null, { kind: "switch", pinId });
            return;
          }
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

function LeadSheet({
  prefill,
  onClose,
}: {
  prefill: { agent: string | null; office: string | null; address?: string | null };
  onClose: (submitted: boolean) => void;
}) {
  // Read once on mount, never at module scope (localStorage + SSR safety) —
  // and prefill latches with it, so a profile fetch landing mid-form can
  // never swap the iframe src and wipe what the rep already typed.
  const [formUrl] = useState(() => getMondayFormUrlWithPrefill(prefill));
  const [detectOn] = useState(isLeadCloseV2Enabled);
  const [submitted, setSubmitted] = useState(false);
  // The embed used to fail silently — a white rectangle with no hint whether
  // it was still coming (field cellular) or dead (field report 2026-10-16).
  // "loading" paints a spinner until the iframe's load event; no event after
  // 12s = "stalled", a visible message + Retry. A late load event still
  // clears either state. frameGen keys the iframe so Retry rebuilds it.
  const [frameState, setFrameState] = useState<"loading" | "ready" | "stalled">("loading");
  const [frameGen, setFrameGen] = useState(0);
  const rootRef = useRef<HTMLDivElement | null>(null);
  const iframeRef = useRef<HTMLIFrameElement | null>(null);
  // The close callback closes over ActiveRun state — keep the freshest copy
  // reachable from the delayed auto-close timer without re-arming effects.
  const closeRef = useRef(onClose);
  closeRef.current = onClose;

  // The form host's origin, for the message check below. try/catch so a
  // malformed knockout.monday_form_url override can't crash the sheet.
  const mondayOrigin = useMemo(() => {
    try {
      return new URL(formUrl).origin;
    } catch {
      return null;
    }
  }, [formUrl]);

  // Deterministic submit signals, both message-typed — no height heuristics
  // to misfire on resizes or validation errors:
  //  1. Monday's workforms embed posts {source:"workforms",
  //     type:"submit_success"} to its parent the moment a submission lands
  //     (verified 2026-09-14 against a scratch form) — the primary signal,
  //     and it fires for ANY forms.monday.com form, the office's original
  //     included.
  //  2. Our /lead-submitted route (the app form's optional redirect target)
  //     posts LEAD_SUBMITTED_MESSAGE_TYPE from inside the iframe —
  //     same-origin backstop if Monday ever renames theirs.
  // Kill switch: localStorage["knockout.lead_close_v2"] = "off" degrades the
  // flow to the labelled Done bar below.
  useEffect(() => {
    if (!detectOn) return;
    let fired = false;
    let timer: number | undefined;
    function onMessage(e: MessageEvent) {
      if (fired) return;
      // Only our own iframe may speak — not some other embed on the page.
      // Fail closed: no frame, no signal.
      const frameWin = iframeRef.current?.contentWindow;
      if (!frameWin || e.source !== frameWin) return;
      const data = e.data as { type?: unknown; source?: unknown } | null;
      const fromMonday =
        mondayOrigin !== null &&
        e.origin === mondayOrigin &&
        data?.source === "workforms" &&
        data?.type === "submit_success";
      const fromRedirect =
        e.origin === window.location.origin && data?.type === LEAD_SUBMITTED_MESSAGE_TYPE;
      if (!fromMonday && !fromRedirect) return;
      fired = true;
      setSubmitted(true);
      try {
        navigator.vibrate?.(15);
      } catch {
        /* unsupported */
      }
      // A short victory beat on the Done bar, then back to the map.
      timer = window.setTimeout(() => closeRef.current(true), 900);
    }
    window.addEventListener("message", onMessage);
    return () => {
      window.removeEventListener("message", onMessage);
      if (timer !== undefined) window.clearTimeout(timer);
    };
  }, [detectOn, mondayOrigin]);

  useEffect(() => {
    if (frameState !== "loading") return;
    const t = window.setTimeout(() => {
      setFrameState((s) => (s === "loading" ? "stalled" : s));
    }, 12_000);
    return () => window.clearTimeout(t);
  }, [frameState, frameGen]);

  // iOS soft keyboard: the layout viewport pans under `fixed inset-0` and
  // can push the header X (or the Done bar) outside the visible screen.
  // Track the visual viewport so both exits stay reachable; feature-detected,
  // browsers without visualViewport keep plain inset-0 behavior.
  useEffect(() => {
    const vv = window.visualViewport;
    const el = rootRef.current;
    if (!vv || !el) return;
    function sync() {
      el!.style.height = `${vv!.height}px`;
      el!.style.transform = `translateY(${vv!.offsetTop}px)`;
    }
    sync();
    vv.addEventListener("resize", sync);
    vv.addEventListener("scroll", sync);
    return () => {
      vv.removeEventListener("resize", sync);
      vv.removeEventListener("scroll", sync);
      el.style.height = "";
      el.style.transform = "";
    };
  }, []);

  return (
    // z-[2000]: the old /field had no map, but here Leaflet's panes and the
    // in-map chrome sit at z-[1000] in the same stacking context — z-50
    // would leave the recenter button poking through the lead form.
    <div ref={rootRef} className="fixed inset-0 z-[2000] bg-background flex flex-col">
      {/* pt calc: py-3 base + notch inset — this header paints outside
          AppShell's pt-safe, so standalone PWA needs its own. */}
      <div className="flex items-center justify-between px-4 pb-3 pt-[calc(env(safe-area-inset-top)+0.75rem)] border-b border-border bg-background">
        <div className="min-w-0">
          <div className="font-display text-xs uppercase tracking-widest text-neon">
            ⚡ New Lead
          </div>
          {/* The tapped house's address, one tap to copy — Monday's Location
              question can't take a URL prefill (WorkForms limitation,
              verified 2026-09-15), so copy → paste → pick the suggestion is
              the fastest honest path into the Address box. */}
          {prefill.address && (
            <button
              type="button"
              aria-label={`Copy address ${prefill.address}`}
              onClick={() => {
                const cb = navigator.clipboard;
                if (!cb) {
                  toast.error("Couldn't copy — type it from here instead");
                  return;
                }
                cb.writeText(prefill.address!).then(
                  () => toast.success("Address copied — paste it into the form"),
                  () => toast.error("Couldn't copy — type it from here instead"),
                );
              }}
              className="flex min-w-0 max-w-full items-center gap-1 text-[11px] text-muted-foreground active:text-foreground"
            >
              <Copy className="h-3 w-3 shrink-0" />
              <span className="truncate">{prefill.address}</span>
            </button>
          )}
        </div>
        <button
          type="button"
          onClick={() => onClose(submitted)}
          aria-label="Close"
          className="min-w-11 min-h-11 inline-flex items-center justify-center rounded-full hover:bg-surface active:scale-95 transition"
        >
          <X className="w-6 h-6" />
        </button>
      </div>
      <div className="relative flex-1 min-h-0">
        <iframe
          key={frameGen}
          ref={iframeRef}
          src={formUrl}
          title="Submit New Lead"
          onLoad={() => setFrameState("ready")}
          className="h-full w-full border-0"
          allow="clipboard-write; camera; microphone; geolocation"
        />
        {frameState !== "ready" && (
          <div className="absolute inset-0 flex flex-col items-center justify-center gap-3 bg-background px-6 text-center">
            {frameState === "loading" ? (
              <>
                <Loader2 className="h-6 w-6 animate-spin text-neon" />
                <p className="text-sm text-muted-foreground">Loading the lead form…</p>
              </>
            ) : (
              <>
                <p className="text-sm font-semibold">The form is taking too long to load.</p>
                <p className="text-sm text-muted-foreground">
                  Weak signal slows it down — it may still come up, or tap retry.
                </p>
                <button
                  type="button"
                  onClick={() => {
                    setFrameState("loading");
                    setFrameGen((g) => g + 1);
                  }}
                  className="min-h-11 inline-flex items-center gap-2 rounded-md border border-border px-4 text-sm font-semibold active:scale-95 transition"
                >
                  <RefreshCw className="h-4 w-4" />
                  Retry
                </button>
              </>
            )}
          </div>
        )}
      </div>
      {/* The labelled exit the bare X never was — and the celebration rail
          when the submit signal lands. X and Done are semantically identical
          (the DETECTION state decides the celebration, not the control). */}
      <div className="border-t border-border bg-background px-4 pt-3 pb-[calc(env(safe-area-inset-bottom)+0.75rem)]">
        <div className={submitted ? "pulse-glow-wrapper w-full" : "w-full"}>
          <button
            type="button"
            onClick={() => onClose(submitted)}
            className="arcade-btn-3d w-full min-h-11 flex items-center justify-center gap-2 px-4"
            style={
              submitted
                ? {
                    ["--btn-color" as string]: "var(--victory)",
                    ["--btn-fg" as string]: "#06110a",
                  }
                : undefined
            }
          >
            <span className="font-display text-xs uppercase tracking-widest">
              {submitted ? "✓ Lead submitted — Back to the Map" : "Done — Back to the Map"}
            </span>
          </button>
        </div>
      </div>
    </div>
  );
}
