/**
 * Crew Map (captain audit C-11) — the player-coach view: every crew member's
 * TODAY pins and live position on one NeonMap.
 *
 * WHERE, not numbers: FieldStandingsSheet already ranks SALE/DK/PTT; this map
 * shows the ground truth of the day — whose dots cover which streets, who is
 * moving right now. Legend chips carry only a door count + a lead count and
 * hand off to the per-rep spectate page (the Eye) for the full timeline.
 *
 * Reads: crew pins = client query under the captain/admin view-all RLS on
 * field_pins; live positions = private `crew-live` broadcast topic (RLS on
 * realtime.messages, migration 20260912210000). Both degrade independently —
 * no beacons still shows pins, no pins still shows beacons.
 *
 * Mounted from /my-territory for captains (third CaptainTerritory mode) and
 * for the admin tier (ManagerTerritoryView toolbar). Managers must never
 * drop pins: the map stays in {kind:"view"} mode, pins inert.
 */
import { useMemo, useState } from "react";
import { Link } from "@tanstack/react-router";
import { useQuery } from "@tanstack/react-query";
import { ArrowLeft, Eye, Radio } from "lucide-react";
import { supabase } from "@/integrations/supabase/client";
import { useAuth } from "@/hooks/useAuth";
import { useCrewLive, useCrewPins } from "@/hooks/useCrewLive";
import { useGeoWatch } from "@/hooks/useFieldPins";
import { useDispatchRoster } from "@/hooks/useFleetRoster";
import { getClockPresence } from "@/lib/dispatch.functions";
import { assigneeColor } from "@/lib/assignee-colors";
import { isLeadSourceName } from "@/lib/lead-sources";
import { laTodayISO } from "@/lib/dates";
import { isManagerRole } from "@/lib/roles";
import { ArcadePanel } from "@/components/arcade";
import {
  NeonMap,
  type CrewMarker,
  type FieldPin,
  type LatLng,
  type Territory,
} from "@/components/NeonMap";

// Above ~this many DOM pin markers mid-range phones start dropping frames
// (NeonMap renders every pin it's given — no culling). The all-crew view
// keeps each rep's freshest slice; focusing a rep always shows their full day.
const PIN_BUDGET = 900;

type TurfRow = {
  id: string;
  name: string;
  color: string;
  polygon_coordinates: LatLng[];
  assigned_user_id: string | null;
  assignee: { display_name: string | null } | null;
};

type RepEntry = {
  id: string;
  name: string;
  color: string;
  doors: number;
  leads: number;
  live: boolean;
  onClock: boolean | null; // null = presence unknown (fail open: no dot, never hide)
};

export function CrewMap({ onBack }: { onBack: () => void }) {
  const { user, role } = useAuth();
  const allowed = isManagerRole(role);
  const today = laTodayISO();

  const pinsQ = useCrewPins(allowed);
  const { positions, status: liveStatus } = useCrewLive(allowed);
  const rosterQ = useDispatchRoster({ enabled: allowed });
  // Viewer's own dot for orientation. Same watch hook as every map screen;
  // captains/admins have long since answered the OS prompt on this route.
  const { me } = useGeoWatch(allowed);

  const [rawFocusId, setFocusId] = useState<string | null>(null);
  const [flyTo, setFlyTo] = useState<{
    bounds: [[number, number], [number, number]];
    key: number;
  } | null>(null);

  // Clock presence for the legend dots — display only, fail open. Local dev
  // has no service key, so this query ALWAYS fails there; nobody is hidden.
  const clockQ = useQuery({
    enabled: allowed,
    queryKey: ["crew_map", "clock", today],
    refetchInterval: 60_000,
    queryFn: async () => getClockPresence({ data: { dates: [today] } }),
  });
  const openNow = useMemo(() => new Set(clockQ.data?.openNow ?? []), [clockQ.data]);

  // All turfs as context polygons, colored per assignee like the pins so
  // "Jesse's dots inside Jesse's zone" reads at a glance. Keyed under the
  // ["turfs"] root so Turf Tools edits (which invalidate that prefix) reach
  // this copy too; the distinct second segment keeps its shape out of the
  // ["turfs", user, role] caches.
  const turfsQ = useQuery({
    enabled: allowed,
    queryKey: ["turfs", "crew_map"],
    staleTime: 5 * 60_000,
    queryFn: async () => {
      const { data, error } = await supabase.from("turfs").select(
        `id, name, color, polygon_coordinates, assigned_user_id,
           assignee:profiles!turfs_assigned_user_id_fkey(display_name)`,
      );
      if (error) throw error;
      return (data ?? []) as unknown as TurfRow[];
    },
  });
  const territories: Territory[] = useMemo(
    () =>
      (turfsQ.data ?? []).map((t) => ({
        id: t.id,
        name: t.name,
        color: assigneeColor(t.assigned_user_id),
        polygon: (t.polygon_coordinates ?? []) as LatLng[],
        dashed: !t.assigned_user_id,
        assignmentLabel: t.assigned_user_id
          ? (t.assignee?.display_name ?? "Assigned")
          : "Unassigned",
      })),
    [turfsQ.data],
  );

  const nameById = useMemo(() => {
    const m = new Map<string, string>();
    for (const p of rosterQ.data?.profiles ?? []) {
      if (p.display_name) m.set(p.id, p.display_name);
    }
    return m;
  }, [rosterQ.data]);

  // Pseudo-source rows (Job Walk, Upsell, …) live in profiles like people —
  // they can't drop pins or beacon, but belt-and-suspenders here anyway.
  const isPseudo = useMemo(() => {
    return (id: string) => isLeadSourceName(nameById.get(id));
  }, [nameById]);

  const allPins = useMemo(
    () => (pinsQ.data ?? []).filter((p) => !isPseudo(p.canvasser_id)),
    [pinsQ.data, isPseudo],
  );

  // Beacon payloads are client-authored by whoever holds the field-tier
  // publish grant — treat them as hints, not identity. Once the roster is
  // loaded, only ids that map to a real profile render (a spoofed/garbage id
  // can't flood the map with phantom avatars), and the display name always
  // comes from the roster, never the payload. Until the roster resolves,
  // fail open so a roster blip doesn't blank the live layer.
  const liveList = useMemo(
    () =>
      Object.values(positions).filter(
        (b) => !isPseudo(b.id) && (!rosterQ.isSuccess || nameById.has(b.id)),
      ),
    [positions, isPseudo, rosterQ.isSuccess, nameById],
  );

  // The crew = whoever left a mark today ∪ whoever is beaconing right now.
  const reps: RepEntry[] = useMemo(() => {
    const byId = new Map<string, RepEntry>();
    for (const p of allPins) {
      let r = byId.get(p.canvasser_id);
      if (!r) {
        r = {
          id: p.canvasser_id,
          name: nameById.get(p.canvasser_id) ?? "Player",
          color: assigneeColor(p.canvasser_id),
          doors: 0,
          leads: 0,
          live: false,
          onClock: clockQ.isSuccess ? openNow.has(p.canvasser_id) : null,
        };
        byId.set(p.canvasser_id, r);
      }
      if (!p.is_remote_drop) r.doors += 1;
      if (p.pin_type === "lead" && !p.is_remote_drop) r.leads += 1;
    }
    for (const b of liveList) {
      const existing = byId.get(b.id);
      if (existing) existing.live = true;
      else
        byId.set(b.id, {
          id: b.id,
          name: nameById.get(b.id) ?? b.name,
          color: assigneeColor(b.id),
          doors: 0,
          leads: 0,
          live: true,
          onClock: clockQ.isSuccess ? openNow.has(b.id) : null,
        });
    }
    return [...byId.values()].sort(
      (a, b) =>
        Number(b.live) - Number(a.live) || b.doors - a.doors || a.name.localeCompare(b.name),
    );
  }, [allPins, liveList, nameById, clockQ.isSuccess, openNow]);

  // A focus only holds while its rep is still on the board — a beaconing rep
  // with zero pins whose beacon goes stale would otherwise leave the map
  // filtered to nobody with the unfocus chip gone.
  const focusId = rawFocusId != null && reps.some((r) => r.id === rawFocusId) ? rawFocusId : null;

  // Map pins: focused rep = their full day; all-crew = freshest slice per rep
  // under the marker budget, always keeping every lead star and flagged pin.
  const mapPins: FieldPin[] = useMemo(() => {
    const source = focusId ? allPins.filter((p) => p.canvasser_id === focusId) : allPins;
    let rows = source;
    if (!focusId && source.length > PIN_BUDGET) {
      const repCount = Math.max(1, new Set(source.map((p) => p.canvasser_id)).size);
      const perRep = Math.max(20, Math.floor(PIN_BUDGET / repCount));
      const kept: typeof source = [];
      const seen = new Map<string, number>();
      // created_at descending = keep the freshest trail per rep.
      const sorted = [...source].sort((a, b) => (a.created_at < b.created_at ? 1 : -1));
      for (const p of sorted) {
        const n = seen.get(p.canvasser_id) ?? 0;
        if (p.pin_type === "lead" || p.is_remote_drop || n < perRep) {
          kept.push(p);
          seen.set(p.canvasser_id, n + 1);
        }
      }
      rows = kept;
    }
    return rows.map((p) => ({
      id: p.id,
      pin_type: p.pin_type,
      lat: p.lat,
      lng: p.lng,
      is_remote_drop: p.is_remote_drop,
      created_at: p.created_at,
      accent: assigneeColor(p.canvasser_id),
    }));
  }, [allPins, focusId]);

  const pinsTrimmed = !focusId && allPins.length > PIN_BUDGET;

  const crewMarkers: CrewMarker[] = useMemo(
    () =>
      liveList.map((b) => ({
        id: b.id,
        name: nameById.get(b.id) ?? b.name,
        color: assigneeColor(b.id),
        lat: b.lat,
        lng: b.lng,
      })),
    [liveList, nameById],
  );

  function focusRep(id: string) {
    if (focusId === id) {
      setFocusId(null);
      return;
    }
    setFocusId(id);
    const pts: LatLng[] = allPins
      .filter((p) => p.canvasser_id === id)
      .map((p) => ({ lat: p.lat, lng: p.lng }));
    const beacon = positions[id];
    if (beacon) pts.push({ lat: beacon.lat, lng: beacon.lng });
    if (pts.length === 0) return;
    let s = pts[0].lat,
      n = pts[0].lat,
      w = pts[0].lng,
      e = pts[0].lng;
    for (const p of pts) {
      if (p.lat < s) s = p.lat;
      if (p.lat > n) n = p.lat;
      if (p.lng < w) w = p.lng;
      if (p.lng > e) e = p.lng;
    }
    // A lone point still deserves a neighborhood-sized frame.
    const padLat = Math.max((n - s) * 0.15, 0.002);
    const padLng = Math.max((e - w) * 0.15, 0.002);
    setFlyTo((prev) => ({
      bounds: [
        [s - padLat, w - padLng],
        [n + padLat, e + padLng],
      ],
      key: (prev?.key ?? 0) + 1,
    }));
  }

  // Never a dead end: whatever path rendered this for a non-manager still
  // gets the Back control (the RLS above means they'd see no data anyway).
  if (!allowed) {
    return (
      <div className="space-y-3">
        <button
          onClick={onBack}
          className="min-h-11 px-3 inline-flex items-center gap-1.5 rounded-md border border-border text-[10px] font-display uppercase tracking-widest text-muted-foreground hover:bg-surface-elevated"
        >
          <ArrowLeft className="w-3.5 h-3.5" /> Back
        </button>
        <ArcadePanel title="Crew Map">
          <div className="text-sm text-muted-foreground">The crew map is a leadership screen.</div>
        </ArcadePanel>
      </div>
    );
  }

  const liveCount = liveList.length;
  const empty = reps.length === 0 && pinsQ.isSuccess;

  return (
    <div className="space-y-3 md:space-y-6">
      <div className="flex items-center justify-between gap-2 flex-wrap">
        <div className="flex items-center gap-3">
          <button
            onClick={onBack}
            className="min-h-11 px-3 inline-flex items-center gap-1.5 rounded-md border border-border text-[10px] font-display uppercase tracking-widest text-muted-foreground hover:bg-surface-elevated"
          >
            <ArrowLeft className="w-3.5 h-3.5" /> Back
          </button>
          <h1 className="font-display text-sm sm:text-base text-neon uppercase tracking-widest">
            Crew Map
          </h1>
        </div>
        <span className="text-[10px] font-display uppercase tracking-widest text-muted-foreground flex items-center gap-1.5">
          <Radio
            className={`w-3 h-3 ${liveCount > 0 ? "text-victory animate-pulse" : "text-muted-foreground"}`}
          />
          {liveCount > 0 ? `${liveCount} LIVE` : liveStatus === "live" ? "0 LIVE" : "PINS ONLY"}
          <span className="text-muted-foreground/60">·</span>
          {reps.length} IN THE FIELD
        </span>
      </div>

      {liveStatus === "unavailable" && (
        <div className="rounded-lg border border-border bg-surface/60 p-3 text-xs text-muted-foreground">
          Live positions are offline right now — the map still shows every pin as it lands.
        </div>
      )}

      {empty ? (
        <ArcadePanel title="Crew Map">
          <div className="text-sm text-muted-foreground">
            Nobody has dropped a pin yet today. The map lights up with the first knock.
          </div>
        </ArcadePanel>
      ) : (
        <div className="relative">
          <NeonMap
            territories={territories}
            pins={mapPins}
            crew={crewMarkers}
            me={me}
            height="clamp(420px, 62dvh, 900px)"
            flyTo={flyTo}
            mode={{ kind: "view" }}
          />
          {pinsTrimmed && (
            <div className="absolute top-3 left-3 z-[1000] rounded border border-border bg-surface/90 backdrop-blur px-3 py-2 font-display text-[9px] uppercase tracking-widest text-muted-foreground">
              Big day — showing each player's freshest pins. Tap a name for their full trail.
            </div>
          )}
        </div>
      )}

      {reps.length > 0 && (
        <div className="min-w-0">
          <div className="flex gap-2 overflow-x-auto pb-1 -mx-1 px-1">
            {reps.map((r) => {
              const self = r.id === user?.id;
              const focused = focusId === r.id;
              return (
                <div
                  key={r.id}
                  className={`shrink-0 inline-flex items-center gap-2 rounded-full border px-3 py-1.5 ${
                    focused
                      ? "border-neon/60 bg-neon/10"
                      : self
                        ? "border-neon/40 bg-neon/5"
                        : "border-border bg-surface"
                  }`}
                >
                  <button
                    onClick={() => focusRep(r.id)}
                    className="inline-flex items-center gap-2 min-h-8"
                    title={focused ? "Show the whole crew" : `Zoom to ${r.name}'s day`}
                  >
                    <span className="relative inline-flex h-2.5 w-2.5 shrink-0">
                      <span
                        className="h-2.5 w-2.5 rounded-full"
                        style={{ background: r.color, boxShadow: `0 0 6px ${r.color}` }}
                      />
                      {r.live && (
                        <span
                          aria-label="Beaconing live"
                          className="absolute -top-1 -right-1 h-1.5 w-1.5 rounded-full bg-[var(--victory)] animate-pulse"
                          style={{ boxShadow: "0 0 6px var(--victory)" }}
                        />
                      )}
                    </span>
                    <span className="font-display text-[10px] uppercase tracking-widest text-foreground whitespace-nowrap">
                      {r.name}
                      {self ? " · you" : ""}
                    </span>
                    <span className="font-display text-[10px] tabular-nums text-muted-foreground whitespace-nowrap">
                      {r.doors} drs
                      {r.leads > 0 ? ` · ${r.leads} lead${r.leads > 1 ? "s" : ""}` : ""}
                    </span>
                    {r.onClock != null && (
                      <span
                        title={r.onClock ? "On the clock right now" : "Not on the clock"}
                        className={`h-1.5 w-1.5 shrink-0 rounded-full ${
                          r.onClock
                            ? "bg-[var(--victory)] shadow-[0_0_6px_var(--victory)]"
                            : "bg-muted-foreground/50"
                        }`}
                      />
                    )}
                  </button>
                  <Link
                    to="/canvassers/$canvasserId/field"
                    params={{ canvasserId: r.id }}
                    title={`Watch ${r.name}'s run`}
                    className="inline-flex items-center justify-center min-h-8 min-w-8 -mr-1 rounded-full text-muted-foreground hover:text-neon"
                  >
                    <Eye className="h-3.5 w-3.5" />
                  </Link>
                </div>
              );
            })}
          </div>
        </div>
      )}
    </div>
  );
}
