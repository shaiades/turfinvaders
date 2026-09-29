import { createFileRoute, Navigate } from "@tanstack/react-router";
import { useEffect, useMemo, useRef, useState } from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { supabase } from "@/integrations/supabase/client";
import { useAuth } from "@/hooks/useAuth";
import { isManagerRole } from "@/lib/roles";
import { useGeoWatch } from "@/hooks/useFieldPins";
import { useRealtimeInvalidate } from "@/hooks/useRealtimeInvalidate";
import { assigneeColor } from "@/lib/assignee-colors";
import { isLaToday } from "@/lib/dates";
import { ArcadePanel } from "@/components/arcade";
import { ActiveRun } from "@/components/ActiveRun";
import { CrewMap } from "@/components/CrewMap";
import { NeonMap, type Territory, type LatLng } from "@/components/NeonMap";
import { getLastMapView, setLastMapView, type MapView } from "@/lib/last-map-view";
import type { MapDataStatus } from "@/lib/map-status";
import { simplifyRing } from "@/lib/simplify-polygon";
import {
  AreaDetailsSheet,
  DeleteAreaConfirmDialog,
  type AssignableUser,
  type AreaDetailsTurf,
  type LastWorked,
  type AssignmentHistoryEntry,
} from "@/components/AreaDetailsSheet";
import { AssignZipSheet, type AssignableCaptain } from "@/components/AssignZipSheet";
import { ZipCaptainAssigner } from "@/components/ZipCaptainAssigner";
import { useZipTints, useZipAssignmentActions } from "@/hooks/useZipAssignments";
import {
  fetchAllRepcardTerritoryRows,
  fetchZctaBoundaries,
  historyRowsInsideZip,
  matchHistoryRowsToZips,
} from "@/lib/zip-history-sweep";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { toast } from "sonner";
import { Crosshair, History, Pencil, MapPin, Trash2, Users, X, Zap } from "lucide-react";

export const Route = createFileRoute("/_authenticated/my-territory")({
  head: () => ({ meta: [{ title: "My Territory — Turf Invaders" }] }),
  component: MyTerritoryPage,
});

type TurfRow = {
  id: string;
  name: string;
  color: string;
  polygon_coordinates: LatLng[];
  assigned_user_id: string | null;
  assigned_by: string | null;
  assigned_at: string | null;
  assignee: { display_name: string | null } | null;
  assigner: { display_name: string | null } | null;
};

type PlaceHit = { bounds: [[number, number], [number, number]]; label: string };

// One lookup per query per session — Nominatim asks for restraint, and a
// dispatch morning re-types the same handful of ZIPs and streets.
const placeCache = new Map<string, PlaceHit>();

const isZip = (q: string) => /^\d{5}$/.test(q);

/** ZIP or free text (street, city, place) → bounding box via OpenStreetMap's
 *  free geocoder (keyless, CORS-open, US-scoped). A 5-digit query uses the
 *  structured postcode field; anything else is a free-text search — so
 *  "Manchester Ave, Encinitas" or "Balboa Park San Diego" both work. Returns
 *  null for no match; throws only on network failure. */
async function lookupPlace(query: string): Promise<PlaceHit | null> {
  const key = query.toLowerCase();
  const cached = placeCache.get(key);
  if (cached) return cached;
  const field = isZip(query) ? `postalcode=${query}` : `q=${encodeURIComponent(query)}`;
  const res = await fetch(
    `https://nominatim.openstreetmap.org/search?${field}&countrycodes=us&format=jsonv2&limit=1`,
  );
  if (!res.ok) throw new Error(`geocoder ${res.status}`);
  const rows = (await res.json()) as Array<{ display_name?: string; boundingbox?: string[] }>;
  const bb = rows[0]?.boundingbox; // [south, north, west, east]
  if (!bb || bb.length !== 4) return null;
  const [s, n, w, e] = bb.map(Number);
  if ([s, n, w, e].some(Number.isNaN)) return null;
  // Normalize the frame to a neighborhood: a single street segment comes back
  // as a ~30 m sliver (too tight to draw in), a centroid-only ZIP as a
  // county-sized box (orbits). Re-center on the match and clamp the span to a
  // comfortable draw-level range in both cases.
  const cLat = (n + s) / 2;
  const cLng = (e + w) / 2;
  const halfLat = Math.min(Math.max(n - s, 0.03), 0.12) / 2;
  const halfLng = Math.min(Math.max(e - w, 0.03), 0.15) / 2;
  const hit: PlaceHit = {
    bounds: [
      [cLat - halfLat, cLng - halfLng],
      [cLat + halfLat, cLng + halfLng],
    ],
    label: rows[0]?.display_name?.split(", United States")[0]?.slice(0, 72) ?? query,
  };
  placeCache.set(key, hit);
  return hit;
}

// Role fan-out (dashboard.tsx pattern). Since the Active Run merge
// (2026-09-08) canvassing lives on /field — canvassers bounce there, captains
// get the canvass screen with a Turf Tools escape hatch, and the Admin tier
// defaults to the manager drawing/assignment view below with an opt-in
// Canvass Mode (owner decision 2026-09-28: owners mark their own doors too).
function MyTerritoryPage() {
  const { role, loading } = useAuth();
  if (loading) return <div className="text-sm text-muted-foreground">Loading…</div>;
  if (role === "canvasser" || !role) return <Navigate to="/field" replace />;
  if (role === "captain") return <CaptainTerritory />;
  return <AdminTerritory />;
}

// Captains canvass by default (owner decision 2026-09-08 — the merge also
// UPGRADED captains from view-only to dropping/correcting their own pins),
// with turf drawing and the crew map each one tap away. Plain state: both
// are short tasks, and a reload landing back on the canvass screen is the
// right default.
function CaptainTerritory() {
  const [view, setView] = useState<"run" | "tools" | "crew">("run");
  if (view === "tools") return <ManagerTerritoryView onBackToCanvassing={() => setView("run")} />;
  if (view === "crew") return <CrewMap onBack={() => setView("run")} />;
  return (
    <ActiveRun
      variant="captain"
      onOpenTurfTools={() => setView("tools")}
      onOpenCrewMap={() => setView("crew")}
    />
  );
}

// Admin tier defaults to Turf Tools; marking their own doors is OPT-IN behind
// one deliberate tap (owner decision 2026-09-28). This keeps the /field
// stray-tap protection intact (commit 6e74c2d — field.tsx still redirects
// admins here, and this default screen never drops pins), while an owner who
// actually canvasses gets the same ActiveRun captains use. Plain state: a
// reload lands back on Turf Tools, the right default for admins — the inverse
// of the captain rationale above.
function AdminTerritory() {
  const [view, setView] = useState<"tools" | "run" | "crew">("tools");
  if (view === "run")
    return (
      <ActiveRun
        variant="captain"
        onOpenTurfTools={() => setView("tools")}
        onOpenCrewMap={() => setView("crew")}
      />
    );
  if (view === "crew") return <CrewMap onBack={() => setView("tools")} />;
  return (
    <ManagerTerritoryView
      onOpenCrewMap={() => setView("crew")}
      onStartCanvassing={() => setView("run")}
    />
  );
}

function ManagerTerritoryView({
  onBackToCanvassing,
  onOpenCrewMap,
  onStartCanvassing,
}: {
  // Captain entry: "Back to Canvassing" returns to their default screen.
  onBackToCanvassing?: () => void;
  onOpenCrewMap?: () => void;
  // Admin entry: "Canvass Mode" is the opt-in door-marking flip — mutually
  // exclusive with onBackToCanvassing by construction (AdminTerritory vs
  // CaptainTerritory), so each button keeps its own copy.
  onStartCanvassing?: () => void;
}) {
  const { user, role, teamId } = useAuth();
  const qc = useQueryClient();
  const { me, geoStatus } = useGeoWatch();
  const [drawing, setDrawing] = useState(false);
  const [pendingPolygon, setPendingPolygon] = useState<LatLng[] | null>(null);
  const [isModalOpen, setIsModalOpen] = useState(false);
  const [editingTurfId, setEditingTurfId] = useState<string | null>(null);
  const [listDeleteId, setListDeleteId] = useState<string | null>(null);
  const [query, setQuery] = useState("");
  const [searchBusy, setSearchBusy] = useState(false);
  // ZIP command: tap a ZIP's label pill to hand the zone to a captain (owner
  // ask 2026-09-19: pill only — zone interiors must never steal taps from
  // turfs). Assignment tools are manager-tier since 2026-09-28 (owner
  // decision, superseding the 2026-09-11 admin-only ZIP doctrine): captains
  // assign ZIPs and promote historical rings too. isAdmin remains for the
  // blast-radius holdout below (direct history-outline delete).
  const isAdmin = role === "owner" || role === "office_staff";
  const canAssign = isManagerRole(role);
  const [zipTarget, setZipTarget] = useState<string | null>(null);
  // Historical coverage (RepCard 2026) visibility — per device, default on.
  // Hiding it also skips the paged fetch below (cellular kindness); the
  // try/catch mirrors ti_zip_borders: private mode must not take the map down.
  const [showHistory, setShowHistory] = useState(() => {
    try {
      return (
        typeof window !== "undefined" && localStorage.getItem("ti_show_repcard_history") !== "0"
      );
    } catch {
      return true;
    }
  });
  function toggleHistory() {
    setShowHistory((on) => {
      try {
        localStorage.setItem("ti_show_repcard_history", on ? "0" : "1");
      } catch {
        /* preference just won't stick */
      }
      return !on;
    });
  }
  // Promote-in-flight: the history row to remove once its live turf saves.
  const [promoteHistoryId, setPromoteHistoryId] = useState<string | null>(null);
  // Historical ring pending the delete confirm dialog.
  const [historyDelete, setHistoryDelete] = useState<{ id: string; label: string } | null>(null);
  const [flyTo, setFlyTo] = useState<{
    bounds: [[number, number], [number, number]];
    key: number;
  } | null>(null);
  // Anchors the map frame so list taps below can bring it back on screen.
  const mapAnchorRef = useRef<HTMLDivElement | null>(null);

  /** Assigned Areas row tap: fly the live map to that turf and scroll it
   *  into view (owner ask 2026-09-16 — "take me to it on the map"). */
  function flyToTurf(polygon: LatLng[] | null | undefined) {
    if (!polygon || polygon.length === 0) return;
    let s = 90,
      n = -90,
      w = 180,
      e = -180;
    for (const p of polygon) {
      if (p.lat < s) s = p.lat;
      if (p.lat > n) n = p.lat;
      if (p.lng < w) w = p.lng;
      if (p.lng > e) e = p.lng;
    }
    setFlyTo((prev) => ({
      bounds: [
        [s, w],
        [n, e],
      ],
      key: (prev?.key ?? 0) + 1,
    }));
    mapAnchorRef.current?.scrollIntoView({ behavior: "smooth", block: "start" });
  }

  // Crash insurance for a drawn-but-unsaved area: the polygon is stashed in
  // localStorage the moment the finger lifts, restored on the next visit, and
  // cleared on save/discard. Before this, a mid-assign tab crash (WebKit
  // reclaiming a heavy map) silently ate the drawing — the manager thought it
  // saved, the teammate never saw it.
  const pendingKey = user?.id ? `ti_pending_turf:v1:${user.id}` : null;
  const restoredPendingRef = useRef(false);
  useEffect(() => {
    if (restoredPendingRef.current || !pendingKey) return;
    restoredPendingRef.current = true;
    try {
      const raw = localStorage.getItem(pendingKey);
      if (!raw) return;
      const saved = JSON.parse(raw) as {
        polygon?: LatLng[];
        at?: number;
        promoteHistoryId?: string;
      };
      const poly = Array.isArray(saved.polygon) ? saved.polygon : [];
      const fresh = typeof saved.at === "number" && Date.now() - saved.at < 12 * 60 * 60 * 1000;
      if (poly.length < 3 || !fresh) {
        localStorage.removeItem(pendingKey);
        return;
      }
      setPendingPolygon(poly);
      // A crashed promote keeps its source link, so saving still removes the
      // old dashed ring; a stale id just no-ops on the delete.
      setPromoteHistoryId(
        typeof saved.promoteHistoryId === "string" ? saved.promoteHistoryId : null,
      );
      let s = 90,
        n = -90,
        w = 180,
        e = -180;
      for (const p of poly) {
        if (p.lat < s) s = p.lat;
        if (p.lat > n) n = p.lat;
        if (p.lng < w) w = p.lng;
        if (p.lng > e) e = p.lng;
      }
      setFlyTo((prev) => ({
        bounds: [
          [s, w],
          [n, e],
        ],
        key: (prev?.key ?? 0) + 1,
      }));
      toast.info("Restored your unsaved drawn area — assign it or discard it.", {
        duration: 8000,
      });
    } catch {
      /* private mode / corrupt entry — nothing to restore */
    }
  }, [pendingKey]);
  useEffect(() => {
    if (!pendingKey || !restoredPendingRef.current) return;
    try {
      if (pendingPolygon && pendingPolygon.length >= 3) {
        localStorage.setItem(
          pendingKey,
          JSON.stringify({ polygon: pendingPolygon, at: Date.now(), promoteHistoryId }),
        );
      } else {
        localStorage.removeItem(pendingKey);
      }
    } catch {
      /* best effort */
    }
  }, [pendingPolygon, pendingKey, promoteHistoryId]);

  async function flyToQuery(q: string) {
    if (searchBusy) return;
    setSearchBusy(true);
    try {
      const hit = await lookupPlace(q);
      if (!hit) {
        toast.error(
          isZip(q)
            ? "Couldn't find that ZIP — double-check the number."
            : "No match — try adding a city (e.g. “Main St, Encinitas”).",
        );
        return;
      }
      setFlyTo((prev) => ({ bounds: hit.bounds, key: (prev?.key ?? 0) + 1 }));
      // Echo the match so a wrong guess on an ambiguous street is obvious.
      toast.success(`📍 ${hit.label}`);
    } catch {
      toast.error("Search failed. Check your signal and try again.");
    } finally {
      setSearchBusy(false);
    }
  }

  async function jumpToPlace(e: React.FormEvent) {
    e.preventDefault();
    const q = query.trim();
    if (q.length < 3) return;
    await flyToQuery(q);
  }

  // Managers see every turf (canvasser self-scoping lives in ActiveRun now).
  // "manager" in the key: a captain flips between this view and ActiveRun,
  // and the two queries select different shapes (only this one embeds
  // assigner) — sharing ["turfs", uid, role] served each the other's rows.
  const turfsQuery = useQuery({
    enabled: !!user?.id,
    queryKey: ["turfs", "manager", user?.id],
    queryFn: async () => {
      const { data, error } = await supabase
        .from("turfs")
        .select(
          `id, name, color, polygon_coordinates, assigned_user_id, assigned_by, assigned_at,
           assignee:profiles!turfs_assigned_user_id_fkey(display_name),
           assigner:profiles!turfs_assigned_by_fkey(display_name)`,
        )
        .order("created_at", { ascending: false });
      if (error) throw error;
      return (data ?? []) as unknown as TurfRow[];
    },
    // Realtime invalidation (below) pushes reassignments within ~1s, so a
    // remount on weak signal serves cached polygons instantly instead of
    // holding an empty map on the refetch.
    staleTime: 5 * 60_000,
    gcTime: 30 * 60_000,
  });

  // RepCard 2026 territory history — coverage drawn on the same map. Mostly
  // static (admin deletes/promotes are rare), so fetch every row once, paged
  // past PostgREST's 1000-row cap, and cache it for the session; the realtime
  // invalidation below handles the rare cross-device delete. Hidden via the
  // History chip = don't fetch at all.
  const repcardTerritoryQuery = useQuery({
    enabled: !!user?.id && showHistory,
    queryKey: ["repcard_territory"],
    staleTime: 60 * 60 * 1000,
    gcTime: 60 * 60 * 1000,
    queryFn: fetchAllRepcardTerritoryRows,
  });

  // Managers see reassignments live (requires turfs in the realtime publication)
  useRealtimeInvalidate({
    channel: "my-territory-turfs",
    tables: ["turfs", "zip_assignments", "repcard_territory_history"],
    invalidateKeys: [
      ["turfs"],
      ["turf_history"],
      ["zip_assignments"],
      ["repcard_territory"],
      // The open ZIP sheet's sweep count goes stale the moment another
      // device promotes or deletes a ring.
      ["zip_history_count"],
    ],
    enabled: !!user?.id,
  });

  // On-map status for the areas fetch — this screen used to fail SILENTLY
  // (empty Kansas-centered map, "0 area(s) drawn") when turfs couldn't load.
  const turfDataStatus: MapDataStatus = {
    state: turfsQuery.isPending ? "loading" : turfsQuery.isError ? "error" : "ok",
    what: "areas",
    onRetry: () => void turfsQuery.refetch(),
  };
  // Saved-view suppression of the fit-all-turfs frame, FROZEN at first
  // authed render — same rationale as ActiveRun's savedView: re-evaluating
  // per render would let the map's own first move suppress the fit forever.
  const savedViewRef = useRef<MapView | null | undefined>(undefined);
  if (savedViewRef.current === undefined && user?.id) {
    savedViewRef.current = getLastMapView(user.id);
  }
  const savedView = savedViewRef.current ?? null;

  // ZIP zones: tint map for the ZCTA layer + the assignment actions.
  const zipZones = useZipTints();
  const zipActions = useZipAssignmentActions();
  const zipByCaptain = useMemo(() => {
    const groups = new Map<string, { name: string; zips: string[] }>();
    for (const r of zipZones.data ?? []) {
      const g = groups.get(r.captain_id) ?? {
        name: r.captain?.display_name ?? "Captain",
        zips: [],
      };
      g.zips.push(r.zip);
      groups.set(r.captain_id, g);
    }
    return [...groups.entries()]
      .map(([id, g]) => ({ id, ...g }))
      .sort((a, b) => a.name.localeCompare(b.name));
  }, [zipZones.data]);
  const zipTargetRow = zipTarget
    ? ((zipZones.data ?? []).find((r) => r.zip === zipTarget) ?? null)
    : null;

  // Assignable users — canvassers, captains, and owners can all be assigned a turf
  const canvassersQuery = useQuery({
    queryKey: ["assignable_canvassers"],
    queryFn: async () => {
      const { data: roleRows, error: rErr } = await supabase
        .from("user_roles")
        .select("user_id, role")
        .in("role", ["canvasser", "captain", "owner"]);
      if (rErr) throw rErr;
      if ((roleRows ?? []).length === 0) return [] as AssignableUser[];
      const ids = (roleRows ?? []).map((r) => r.user_id as string);
      const { data: profs, error: pErr } = await supabase
        .from("profiles")
        // teams must be disambiguated: profiles↔teams also relate via
        // teams.captain_id, so a bare teams(name) is ambiguous (PGRST201).
        .select(
          "id, display_name, office_location, is_placeholder, team_id, teams!profiles_team_fk(name)",
        )
        .in("id", ids)
        .order("display_name", { ascending: true });
      if (pErr) throw pErr;
      const profById = new Map(
        (profs ?? []).map((p) => [
          p.id as string,
          {
            display_name: (p.display_name as string | null) ?? (p.id as string),
            office_location: (p.office_location as string | null) ?? null,
            team_name: ((p.teams as { name: string | null } | null)?.name as string | null) ?? null,
            team_id: (p.team_id as string | null) ?? null,
            is_placeholder: (p.is_placeholder as boolean | null) === true,
          },
        ]),
      );
      // Dedupe with ROLE PRECEDENCE: most captains also hold the canvasser
      // role, and first-row-wins made their listed role row-order roulette —
      // whenever the canvasser row arrived first, the ZIP assigner's
      // captain filter silently dropped them (owner report 2026-09-12:
      // "can't assign areas to captains" — it looked clock-related, but no
      // assignment surface ever gated on punches).
      const ROLE_RANK: Record<string, number> = { captain: 3, owner: 2, canvasser: 1 };
      const byId = new Map<string, AssignableUser>();
      for (const r of roleRows ?? []) {
        const id = r.user_id as string;
        const existing = byId.get(id);
        if (existing && (ROLE_RANK[existing.role] ?? 0) >= (ROLE_RANK[r.role as string] ?? 0)) {
          continue;
        }
        const p = profById.get(id);
        // Placeholder profiles (Monday-minted name variants — dispatch grants
        // them a canvasser role) are NOT assign targets: no login ever runs
        // as their id, so a turf assigned to one is invisible to the real
        // person forever (the canvasser SELECT policy matches auth.uid()).
        // They shadowed real teammates in this picker under the same display
        // name — the "I drew it but they can't see it" bug. Profile-less
        // role rows are skipped for the same reason.
        if (!p || p.is_placeholder) continue;
        byId.set(id, {
          id,
          display_name: p.display_name,
          role: r.role as string,
          office_location: p.office_location,
          team_name: p.team_name,
          team_id: p.team_id,
        } satisfies AssignableUser);
      }
      return [...byId.values()].sort((a, b) => a.display_name.localeCompare(b.display_name));
    },
  });

  // Full assignment history for the turf being edited — who has had this area
  // and who assigned them. Drives both the visible "Assignment history" list
  // and the most-recent-worker line + don't-assign-twice-in-a-row warning.
  const historyQuery = useQuery({
    enabled: !!editingTurfId,
    queryKey: ["turf_history", editingTurfId],
    queryFn: async () => {
      const { data, error } = await supabase
        .from("turf_assignment_history")
        .select(
          `assigned_user_id, assigned_at,
           worker:profiles!turf_assignment_history_assigned_user_id_fkey(display_name),
           assigner:profiles!turf_assignment_history_assigned_by_fkey(display_name)`,
        )
        .eq("turf_id", editingTurfId!)
        .order("assigned_at", { ascending: false })
        .limit(25);
      if (error) throw error;
      return (data ?? []) as unknown as Array<{
        assigned_user_id: string | null;
        assigned_at: string;
        worker: { display_name: string | null } | null;
        assigner: { display_name: string | null } | null;
      }>;
    },
  });

  // Recent history for EVERY turf, so the on-map popup can show each area's
  // past assignees without a per-turf round trip. Managers have a modest
  // number of turfs; one ordered read + client-side grouping is plenty.
  const allHistoryQuery = useQuery({
    enabled: !!user?.id,
    queryKey: ["turf_history_all", user?.id],
    queryFn: async () => {
      const { data, error } = await supabase
        .from("turf_assignment_history")
        .select(
          `turf_id, assigned_at,
           worker:profiles!turf_assignment_history_assigned_user_id_fkey(display_name)`,
        )
        .order("assigned_at", { ascending: false })
        .limit(500);
      if (error) throw error;
      return (data ?? []) as unknown as Array<{
        turf_id: string;
        assigned_at: string;
        worker: { display_name: string | null } | null;
      }>;
    },
  });

  useRealtimeInvalidate({
    channel: "my-territory-history",
    tables: ["turf_assignment_history"],
    invalidateKeys: [["turf_history_all"], ["turf_history"]],
    enabled: !!user?.id,
  });

  const historyByTurf = useMemo(() => {
    const short = (iso: string) =>
      new Intl.DateTimeFormat("en-US", {
        timeZone: "America/Los_Angeles",
        month: "short",
        day: "numeric",
        year: "numeric",
      }).format(new Date(iso));
    const map = new Map<string, Array<{ name: string; when: string }>>();
    for (const h of allHistoryQuery.data ?? []) {
      const list = map.get(h.turf_id) ?? [];
      list.push({ name: h.worker?.display_name ?? "Former member", when: short(h.assigned_at) });
      map.set(h.turf_id, list);
    }
    return map;
  }, [allHistoryQuery.data]);

  const territories: Territory[] = useMemo(
    () =>
      (turfsQuery.data ?? []).map((t) => ({
        id: t.id,
        name: t.name,
        color: assigneeColor(t.assigned_user_id),
        polygon: (t.polygon_coordinates ?? []) as LatLng[],
        dashed: !t.assigned_user_id,
        // Name pills only for today's moves (owner ask 2026-09-18: "keep
        // track of where my teams are at daily" — every past assignment ever
        // made rendering its name at once buried the map). Tapping the area
        // still shows the full assignment history regardless of the label.
        assignmentLabel: !t.assigned_user_id
          ? "Unassigned"
          : isLaToday(t.assigned_at)
            ? (t.assignee?.display_name ?? "Assigned")
            : undefined,
        currentAssignee: t.assigned_user_id ? (t.assignee?.display_name ?? "Assigned") : null,
        history: historyByTurf.get(t.id) ?? [],
      })),
    [turfsQuery.data, historyByTurf],
  );

  // RepCard historical areas as faint dashed coverage. Polygons are simplified
  // (RDP) so thousands render on the canvas; ids are prefixed `repcard:` so a
  // tap shows the read-only popup but never opens the turf editor.
  const repcardTerritories: Territory[] = useMemo(() => {
    const fmt = (iso: string | null) =>
      iso
        ? new Intl.DateTimeFormat("en-US", {
            month: "short",
            day: "numeric",
            year: "numeric",
          }).format(new Date(iso))
        : "";
    return (repcardTerritoryQuery.data ?? [])
      .map((r): Territory => {
        const label = r.rep_name
          ? r.team
            ? `${r.rep_name} · ${r.team}`
            : r.rep_name
          : "RepCard area";
        return {
          id: `repcard:${r.id}`,
          name: r.rep_name ?? "RepCard area",
          color: r.color || "#8b5cf6",
          polygon: simplifyRing((r.polygon_coordinates ?? []) as LatLng[]),
          dashed: true,
          // Same today-only label rule as live turfs — this is 2026-season
          // import history, so in practice these never carry a name pill
          // anymore (the coverage shape still renders for context).
          assignmentLabel: isLaToday(r.assigned_at) ? label : undefined,
          currentAssignee: r.rep_name ?? null,
          history: r.assigned_at ? [{ name: "RepCard 2026", when: fmt(r.assigned_at) }] : [],
        };
      })
      .filter((t) => t.polygon.length >= 3);
  }, [repcardTerritoryQuery.data]);

  // Combined layer: RepCard coverage underneath, live turfs drawn on top.
  // The History chip hides the coverage even when the query cache still holds
  // rows (a re-show shouldn't refetch 2,700 polygons).
  const mapTerritories: Territory[] = useMemo(
    () => (showHistory ? [...repcardTerritories, ...territories] : territories),
    [repcardTerritories, territories, showHistory],
  );

  // Auto-fit frames the LIVE turfs only — otherwise the 2,700 RepCard areas
  // would zoom the map out to the whole two-county extent on load and break the
  // assignment workflow. The RepCard coverage is still there when you zoom out.
  const fitPolygons: LatLng[][] = useMemo(
    () => territories.map((t) => t.polygon).filter((p) => p.length >= 3),
    [territories],
  );

  const saveTurf = useMutation({
    mutationFn: async (payload: {
      name: string;
      assigned_user_id: string | null;
      polygon: LatLng[];
      // Promote flow only: the repcard_territory_history row this polygon came
      // from. Never part of the turfs insert — consumed in onSuccess.
      promoteHistoryId?: string | null;
    }) => {
      const { data: authData } = await supabase.auth.getUser();
      const uid = authData.user?.id;
      if (!uid) throw new Error("Not signed in — please refresh and sign in again.");
      // assigned_by / assigned_at are stamped server-side by the
      // turfs_stamp_assignment trigger — never sent from the client.
      const insertRow = {
        name: payload.name,
        color: assigneeColor(payload.assigned_user_id),
        polygon_coordinates: payload.polygon.map((p) => ({ lat: p.lat, lng: p.lng })),
        assigned_user_id: payload.assigned_user_id,
        created_by: uid,
      };
      const { data, error } = await supabase.from("turfs").insert(insertRow).select().single();
      if (error) {
        console.error("[turf insert failed]", error, "row:", insertRow);
        const parts = [error.message];
        if (error.code) parts.push(`(code ${error.code})`);
        if (error.hint) parts.push(`— ${error.hint}`);
        throw new Error(parts.join(" "));
      }
      return data;
    },
    onSuccess: (_data, vars) => {
      toast.success(
        vars.assigned_user_id ? "Area assigned successfully!" : "Area saved — unassigned",
      );
      setPendingPolygon(null);
      setIsModalOpen(false);
      setDrawing(false);
      // Promoted from historical coverage: the live turf now owns this
      // ground, so retire the dashed source ring.
      if (vars.promoteHistoryId) {
        void removePromotedHistoryRow(vars.promoteHistoryId);
        setPromoteHistoryId(null);
      }
      qc.invalidateQueries({ queryKey: ["turfs"] });
      qc.invalidateQueries({ queryKey: ["turf_history"] });
    },
    onError: (e: Error) => {
      // Promote state intentionally survives an insert failure — the floating
      // Assign/Discard recovery path can retry with the source link intact.
      toast.error(`Failed to assign area: ${e.message}`, { duration: 8000 });
    },
  });

  const updateTurf = useMutation({
    mutationFn: async (payload: { id: string; name: string; assigned_user_id: string | null }) => {
      // Provenance is stamped by the turfs_stamp_assignment trigger, and only
      // when the assignee actually changes — a rename never rewrites it.
      const { error } = await supabase
        .from("turfs")
        .update({
          name: payload.name,
          assigned_user_id: payload.assigned_user_id,
          color: assigneeColor(payload.assigned_user_id),
        })
        .eq("id", payload.id);
      if (error) throw new Error(error.message);
    },
    onSuccess: (_data, vars) => {
      toast.success(
        vars.assigned_user_id ? "Area assigned successfully!" : "Area set to unassigned",
      );
      setEditingTurfId(null);
      setIsModalOpen(false);
      qc.invalidateQueries({ queryKey: ["turfs"] });
      qc.invalidateQueries({ queryKey: ["turf_history"] });
    },
    onError: (e: Error) => toast.error(`Failed to reassign: ${e.message}`, { duration: 8000 }),
  });

  const deleteTurf = useMutation({
    mutationFn: async (id: string) => {
      const { error } = await supabase.from("turfs").delete().eq("id", id);
      if (error) throw error;
    },
    onSuccess: () => {
      toast.success("Area deleted successfully!");
      setListDeleteId(null);
      setEditingTurfId(null);
      setIsModalOpen(false);
      qc.invalidateQueries({ queryKey: ["turfs"] });
      qc.invalidateQueries({ queryKey: ["turf_history"] });
    },
    onError: (e: Error) => toast.error(e.message),
  });

  /** Promote cleanup: retire the historical source ring once its live turf
   *  saved. Fire-and-forget from saveTurf.onSuccess — the assignment already
   *  succeeded, so a failure here only leaves a ghost dashed ring, which is
   *  now user-fixable via the ring's own Delete action. 0 deleted rows =
   *  another manager already removed it; equally fine. */
  async function removePromotedHistoryRow(id: string) {
    const { error } = await supabase
      .from("repcard_territory_history")
      .delete()
      .eq("id", id)
      .select("id");
    if (error) {
      toast.info(
        "Area is live, but the old historical outline couldn't be removed — delete it from its popup.",
        { duration: 8000 },
      );
    }
    qc.invalidateQueries({ queryKey: ["repcard_territory"] });
  }

  // Direct delete of a historical coverage ring (owner ask 2026-09-22).
  // `.select("id")`: a DELETE the RLS policy doesn't match "succeeds" with 0
  // rows — surface that as an error instead of a fake success (the
  // silent-no-op trap recorded in 20260916120000).
  const deleteHistoryArea = useMutation({
    mutationFn: async (id: string) => {
      const { data, error } = await supabase
        .from("repcard_territory_history")
        .delete()
        .eq("id", id)
        .select("id");
      if (error) throw new Error(error.message);
      return (data ?? []).length;
    },
    onSuccess: (deleted) => {
      if (deleted === 0) {
        toast.error("Couldn't delete — it may already be gone.");
      } else {
        toast.success("Historical area deleted.");
      }
      setHistoryDelete(null);
      qc.invalidateQueries({ queryKey: ["repcard_territory"] });
    },
    onError: (e: Error) => toast.error(`Failed to delete: ${e.message}`, { duration: 8000 }),
  });

  // ZIP hand-off cascade (owner ask 2026-09-28, part 2: "when I assign a zip
  // code, all of the pre-assigned areas/historic areas get assigned to the
  // person I assigned the zip code to"). Same promote-and-retire semantics as
  // the one-ring popup flow, batched per ZIP. Each chunk retires its source
  // rings right after its insert lands, so a mid-batch failure leaves a clean
  // prefix — a retry only re-sweeps what's still dashed, never duplicates.
  const SWEEP_TOAST = "zip-history-sweep";
  const sweepHistory = useMutation({
    mutationFn: async (vars: { zips: string[]; captain_id: string; captain_name: string }) => {
      const { data: authData } = await supabase.auth.getUser();
      const uid = authData.user?.id;
      if (!uid) throw new Error("Not signed in — please refresh and sign in again.");
      // Shares the map layer's cache key: with History On this is a no-op
      // read; with History Off it fetches once for the sweep.
      const rows = await qc.fetchQuery({
        queryKey: ["repcard_territory"],
        queryFn: fetchAllRepcardTerritoryRows,
        staleTime: 60 * 60 * 1000,
      });
      const boundaries = await fetchZctaBoundaries(vars.zips);
      const missing = vars.zips.filter((z) => !boundaries.has(z));
      const matches = matchHistoryRowsToZips(rows, boundaries);
      let promoted = 0;
      let removed = 0;
      const counters = new Map<string, number>();
      const CHUNK = 100;
      for (let i = 0; i < matches.length; i += CHUNK) {
        const slice = matches.slice(i, i + CHUNK);
        const inserts = slice.map(({ zip, row }) => {
          const n = (counters.get(zip) ?? 0) + 1;
          counters.set(zip, n);
          return {
            // Per-ZIP numbering: "92117 · history 3" is a stable handle in
            // the Assigned Areas list without leaking the old rep's name.
            name: `${zip} · history ${n}`,
            color: assigneeColor(vars.captain_id),
            polygon_coordinates: (row.polygon_coordinates ?? []).map((p) => ({
              lat: p.lat,
              lng: p.lng,
            })),
            assigned_user_id: vars.captain_id,
            created_by: uid,
          };
        });
        const { data: ins, error } = await supabase.from("turfs").insert(inserts).select("id");
        if (error) {
          throw new Error(
            promoted > 0
              ? `${error.message} — ${promoted} area(s) were assigned before the failure; assign the ZIP again to sweep the rest.`
              : error.message,
          );
        }
        promoted += (ins ?? []).length;
        // `.select("id")`: an RLS-blocked DELETE "succeeds" with 0 rows — the
        // shortfall is reported below instead of read as done.
        const { data: del, error: delErr } = await supabase
          .from("repcard_territory_history")
          .delete()
          .in(
            "id",
            slice.map((m) => m.row.id),
          )
          .select("id");
        if (!delErr) removed += (del ?? []).length;
      }
      return { promoted, removed, missing };
    },
    onMutate: () => {
      toast.loading("Sweeping historic areas in the ZIP…", { id: SWEEP_TOAST });
    },
    onSuccess: (res, vars) => {
      if (res.promoted === 0) {
        toast.info(
          res.missing.length > 0
            ? `Couldn't load the boundary for ZIP ${res.missing.join(", ")} — no historic areas were moved. Try again from the ZIP pill.`
            : "No historic areas inside — the ZIP is assigned, nothing else to move.",
          { id: SWEEP_TOAST, duration: 8000 },
        );
      } else {
        toast.success(
          `🗺️ ${res.promoted} historic area${res.promoted === 1 ? "" : "s"} assigned to ${vars.captain_name}`,
          { id: SWEEP_TOAST, duration: 8000 },
        );
        if (res.removed < res.promoted) {
          toast.info(
            `${res.promoted - res.removed} old dashed outline(s) couldn't be retired — delete them from their popups.`,
            { duration: 8000 },
          );
        }
        if (res.missing.length > 0) {
          toast.info(
            `ZIP ${res.missing.join(", ")}: boundary unavailable, historic areas there weren't swept.`,
            { duration: 8000 },
          );
        }
      }
      qc.invalidateQueries({ queryKey: ["turfs"] });
      qc.invalidateQueries({ queryKey: ["turf_history"] });
      qc.invalidateQueries({ queryKey: ["repcard_territory"] });
      qc.invalidateQueries({ queryKey: ["zip_history_count"] });
    },
    onError: (e: Error) => {
      toast.error(`History sweep failed: ${e.message}`, { id: SWEEP_TOAST, duration: 10000 });
      // A partial sweep still moved rows — keep the map honest.
      qc.invalidateQueries({ queryKey: ["turfs"] });
      qc.invalidateQueries({ queryKey: ["repcard_territory"] });
      qc.invalidateQueries({ queryKey: ["zip_history_count"] });
    },
  });

  // How many historic rings the open ZIP sheet would sweep — drives its
  // checkbox row. null = boundary unavailable (the sweep would no-op).
  const zipHistoryCountQuery = useQuery({
    enabled: !!zipTarget && canAssign,
    queryKey: ["zip_history_count", zipTarget],
    staleTime: 5 * 60_000,
    queryFn: async () => {
      const rows = await qc.fetchQuery({
        queryKey: ["repcard_territory"],
        queryFn: fetchAllRepcardTerritoryRows,
        staleTime: 60 * 60 * 1000,
      });
      const boundaries = await fetchZctaBoundaries([zipTarget!]);
      const polys = boundaries.get(zipTarget!);
      if (!polys) return null;
      return historyRowsInsideZip(rows, polys).length;
    },
  });

  /** Historical ring → live turf: re-enter the post-draw assign flow with the
   *  row's RAW ring — the rendered Territory polygon is RDP-simplified for
   *  canvas speed, and a permanent turf boundary shouldn't inherit that ~12m
   *  degradation. */
  function startHistoricalAssign(territoryId: string) {
    const row = (repcardTerritoryQuery.data ?? []).find((r) => `repcard:${r.id}` === territoryId);
    if (!row || (row.polygon_coordinates ?? []).length < 3) {
      toast.error("Couldn't load that historical area — try again.");
      return;
    }
    setEditingTurfId(null);
    setPromoteHistoryId(row.id);
    setPendingPolygon(row.polygon_coordinates);
    setIsModalOpen(true);
  }

  function startHistoricalDelete(territoryId: string) {
    const row = (repcardTerritoryQuery.data ?? []).find((r) => `repcard:${r.id}` === territoryId);
    if (!row) return;
    setHistoryDelete({
      id: row.id,
      label: row.rep_name ? `${row.rep_name} — RepCard 2026` : "this historical area",
    });
  }

  // Managers never drop field pins — a stray map tap would insert a field_pins
  // row for them and bump their daily_logs via bump_daily_log_from_pin.
  const mapMode = drawing
    ? {
        kind: "draw" as const,
        onComplete: (poly: LatLng[]) => {
          // A fresh drawing replaces any promote-in-flight polygon — saving
          // it must not retire an unrelated historical ring.
          setPromoteHistoryId(null);
          setPendingPolygon(poly);
          setIsModalOpen(true);
        },
      }
    : { kind: "view" as const };

  // Captain picker for the ZIP sheet — captains only, from the same roster
  // fetch the turf-assign sheet uses.
  const captains: AssignableCaptain[] = useMemo(
    () =>
      (canvassersQuery.data ?? [])
        .filter((u) => u.role === "captain")
        .map((u) => ({
          id: u.id,
          display_name: u.display_name,
          office_location: u.office_location,
        })),
    [canvassersQuery.data],
  );

  const editing = editingTurfId
    ? ((turfsQuery.data ?? []).find((t) => t.id === editingTurfId) ?? null)
    : null;
  const editingTurf: AreaDetailsTurf | null = editing
    ? {
        id: editing.id,
        name: editing.name,
        assigned_user_id: editing.assigned_user_id,
        assigned_at: editing.assigned_at,
        assignee_name: editing.assignee?.display_name ?? null,
        assigner_name: editing.assigner?.display_name ?? null,
      }
    : null;
  const lastWorked: LastWorked | null = useMemo(() => {
    const row = (historyQuery.data ?? []).find((h) => h.assigned_user_id != null);
    if (!row) return null;
    return {
      userId: row.assigned_user_id!,
      name: row.worker?.display_name ?? "Unknown",
      at: row.assigned_at,
    };
  }, [historyQuery.data]);

  const assignmentHistory: AssignmentHistoryEntry[] = useMemo(
    () =>
      (historyQuery.data ?? []).map((h) => ({
        userId: h.assigned_user_id,
        // A profile deleted after assignment nulls the FK (ON DELETE SET NULL).
        name: h.worker?.display_name ?? "Former member",
        at: h.assigned_at,
        assignerName: h.assigner?.display_name ?? null,
      })),
    [historyQuery.data],
  );

  const listDeleting = listDeleteId
    ? ((turfsQuery.data ?? []).find((t) => t.id === listDeleteId) ?? null)
    : null;

  // Another manager deleted the area this sheet is editing (realtime refetch
  // dropped it from the cache) — close gracefully instead of morphing UI.
  useEffect(() => {
    if (!editingTurfId || !isModalOpen) return;
    if (
      turfsQuery.isSuccess &&
      !turfsQuery.isFetching &&
      !(turfsQuery.data ?? []).some((t) => t.id === editingTurfId)
    ) {
      toast.info("This area was deleted by another manager.");
      setEditingTurfId(null);
      setIsModalOpen(false);
    }
  }, [editingTurfId, isModalOpen, turfsQuery.isSuccess, turfsQuery.isFetching, turfsQuery.data]);

  return (
    <>
      <div className="space-y-6">
        <div className="flex items-center justify-between flex-wrap gap-3">
          <h1 className="font-display text-2xl text-neon">MY TERRITORY</h1>
          <div className="text-[10px] font-display uppercase tracking-widest text-muted-foreground flex items-center gap-2">
            <Crosshair className="w-3 h-3 text-[#00e5ff]" />
            {geoStatus === "denied" ? (
              <span className="text-destructive">GPS OFF</span>
            ) : me ? (
              `LIVE · ${me.lat.toFixed(4)}, ${me.lng.toFixed(4)}`
            ) : (
              "Acquiring GPS…"
            )}
          </div>
        </div>

        {/* Manager toolbar */}
        <div className="flex flex-wrap items-center gap-3 rounded-lg border border-neon/40 bg-surface/60 p-3">
          <div className="font-display text-[10px] uppercase tracking-widest text-neon">
            Turf Tools
          </div>
          {!drawing ? (
            <Button
              // PR #247 removed Assign-ZIPs mode but left a setAssignZips(false)
              // call here — a ReferenceError that made this button a no-op.
              onClick={() => setDrawing(true)}
              className="gap-2"
            >
              <Pencil className="w-3.5 h-3.5" /> Draw New Area
            </Button>
          ) : (
            <Button
              variant="outline"
              onClick={() => {
                setDrawing(false);
                setPendingPolygon(null);
                setPromoteHistoryId(null);
              }}
            >
              Cancel Drawing
            </Button>
          )}
          {onOpenCrewMap && (
            <Button variant="outline" onClick={onOpenCrewMap} className="gap-2">
              <Users className="w-3.5 h-3.5" /> Crew Map
            </Button>
          )}
          {/* 2,700 dashed RepCard rings are context, not clutter — until they
              are. Per-device show/hide; off also skips their fetch. */}
          <Button
            variant="outline"
            onClick={toggleHistory}
            className="gap-2"
            title={showHistory ? "Hide 2026 RepCard coverage" : "Show 2026 RepCard coverage"}
          >
            <History className="w-3.5 h-3.5" /> History {showHistory ? "On" : "Off"}
          </Button>
          <span className="text-[10px] text-muted-foreground uppercase tracking-widest">
            {drawing
              ? "Drag on the map to draw an area"
              : // "0 area(s) drawn" while the fetch is pending/failed would be
                // a lie — the on-map pill narrates those states; this label
                // only counts once the rows actually landed.
                turfsQuery.isSuccess
                ? `${territories.length} area(s) drawn`
                : "…"}
          </span>
          {/* Jump the map to a ZIP or a street/place — dispatch mornings
              shouldn't start with a cross-county pan hunt. Street names are
              ambiguous, so the toast echoes the match and the placeholder
              nudges toward adding a city. */}
          <form onSubmit={jumpToPlace} className="flex items-center gap-2">
            <Input
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              placeholder="ZIP or street, city"
              aria-label="Search by ZIP, street, or place"
              className="w-44"
            />
            <Button
              type="submit"
              variant="outline"
              disabled={query.trim().length < 3 || searchBusy}
              className="gap-1.5"
            >
              <MapPin className="w-3.5 h-3.5" /> {searchBusy ? "…" : "Go"}
            </Button>
          </form>
          {onBackToCanvassing && (
            <Button variant="outline" onClick={onBackToCanvassing} className="ml-auto gap-2">
              <Zap className="w-3.5 h-3.5" /> Back to Canvassing
            </Button>
          )}
          {onStartCanvassing && (
            <Button variant="outline" onClick={onStartCanvassing} className="ml-auto gap-2">
              <Zap className="w-3.5 h-3.5" /> Canvass Mode
            </Button>
          )}
        </div>

        <div className="relative scroll-mt-20" ref={mapAnchorRef}>
          {/* No `follow`: managers open framing ALL turfs (FitBounds) instead
              of zoom-18 on their own position — with GPS granted, FollowMe's
              2 km self-cage made cross-county turf hunting impossible. The
              me-dot still renders; recenter still jumps to it. */}
          <NeonMap
            // Mid-draw the canvas repaints per stroke sample — 2,800 RepCard
            // history rings under the finger is what crashed iOS Safari.
            // Live turfs stay for context; the coverage returns on release.
            territories={drawing ? territories : mapTerritories}
            // Skip the initial fit-all-turfs once a view was already saved
            // AT MOUNT (canvassing round-trip, or yesterday's persisted
            // spot) — frozen so the map's own moves can't retroactively
            // suppress the fit once turfs land.
            fitPolygons={savedView ? [] : fitPolygons}
            center={savedView?.center}
            initialZoom={savedView?.zoom}
            initialBearing={savedView?.bearing}
            onViewChange={(v) => setLastMapView(v, user?.id)}
            dataStatus={turfDataStatus}
            pins={[]}
            houses={[]}
            me={me}
            height="clamp(480px, 70dvh, 1100px)"
            flyTo={flyTo}
            pendingPolygon={pendingPolygon}
            mode={mapMode}
            zipTints={zipZones.tints}
            onZipTap={canAssign ? (zip) => setZipTarget(zip) : undefined}
            onTerritoryClick={
              !drawing
                ? (id) => {
                    // RepCard historical areas have no editable turf row — the
                    // popup's own admin actions (below) handle them.
                    if (id.startsWith("repcard:")) return;
                    setEditingTurfId(id);
                    setIsModalOpen(true);
                  }
                : undefined
            }
            // Historical-coverage assign is manager tier (owner decision
            // 2026-09-28, superseding the 2026-09-22 admin-only ask): a
            // captain promoting a ring also needs the RLS DELETE widening in
            // 20260928120000 — the promote flow retires the dashed source
            // ring. The DIRECT delete button stays admin-only (blast radius).
            onHistoricalAssign={canAssign && !drawing ? startHistoricalAssign : undefined}
            onHistoricalDelete={isAdmin && !drawing ? startHistoricalDelete : undefined}
            // Tapping a turf opens an on-map card (current assignee + recent
            // history + an edit button) rather than jumping straight to the
            // sheet. Disabled mid-draw (a stray tap would fight drawing).
            territoryPopups={!drawing}
            // Inside the map frame so the fallback follows the map into
            // fullscreen (a sibling would be stranded behind the fixed map).
            overlay={
              pendingPolygon && pendingPolygon.length >= 3 && !isModalOpen ? (
                /* Floating fallback: always visible when a polygon is pending */
                <div className="absolute left-1/2 -translate-x-1/2 bottom-4 z-[1000] flex flex-col items-stretch gap-2 w-[calc(100%-1.5rem)] max-w-sm">
                  <Button
                    onClick={() => setIsModalOpen(true)}
                    className="font-display uppercase tracking-widest bg-victory text-black hover:bg-victory/90 shadow-[0_0_24px_rgba(57,255,20,0.6)] animate-pulse"
                  >
                    <MapPin className="w-4 h-4 mr-2" />
                    Assign Area ({pendingPolygon.length} pts)
                  </Button>
                  <Button
                    variant="outline"
                    onClick={() => {
                      setPendingPolygon(null);
                      setPromoteHistoryId(null);
                      setIsModalOpen(false);
                    }}
                  >
                    Discard
                  </Button>
                </div>
              ) : undefined
            }
          />
        </div>

        {/* Captain-first batch assignment: "Assigning to captain" + "ZIP codes
            you want assigned to that captain" (owner's sections, 2026-09-11).
            Manager tier since 2026-09-28 — captains batch-assign too. */}
        {canAssign && (
          <ZipCaptainAssigner
            captains={captains}
            assignments={zipZones.data ?? []}
            saving={zipActions.assignMany.isPending || sweepHistory.isPending}
            onAssign={async (zips, captain_id, includeHistory) => {
              await zipActions.assignMany.mutateAsync({ zips, captain_id });
              if (includeHistory) {
                sweepHistory.mutate({
                  zips,
                  captain_id,
                  captain_name:
                    captains.find((c) => c.id === captain_id)?.display_name ?? "the captain",
                });
              }
            }}
          />
        )}

        {/* ZIP zones: which captain owns which ZIP. Managers (admin tier +
            captains since 2026-09-28) manage — tap a chip to fly there, ✕ to
            unassign; captains chunk their zones into turfs with Draw New
            Area. */}
        <ArcadePanel title="ZIP Zones">
          {zipByCaptain.length === 0 ? (
            <div className="text-sm text-muted-foreground">
              {canAssign
                ? "No ZIPs assigned yet. Tap “Assign ZIPs”, then tap a ZIP boundary on the map to hand it to a captain."
                : "No ZIPs assigned yet — a manager hands ZIPs to captains here."}
            </div>
          ) : (
            <ul className="space-y-2">
              {zipByCaptain.map((g) => {
                const color = assigneeColor(g.id);
                const mine = g.id === user?.id;
                return (
                  <li
                    key={g.id}
                    className="flex flex-wrap items-center gap-2 rounded border border-border bg-surface/60 p-3"
                  >
                    <span className="flex items-center gap-2 min-w-0">
                      <span
                        className="inline-block h-3 w-3 shrink-0 rounded-full"
                        style={{ background: color, boxShadow: `0 0 8px ${color}` }}
                      />
                      <span className="font-display text-sm truncate">
                        {g.name}
                        {mine ? " · you" : ""}
                      </span>
                    </span>
                    <span className="flex flex-wrap items-center gap-1.5">
                      {g.zips.map((z) => (
                        <span
                          key={z}
                          className="inline-flex items-center overflow-hidden rounded-full border text-xs"
                          style={{ borderColor: color }}
                        >
                          <button
                            type="button"
                            title={`Fly to ${z}`}
                            onClick={() => void flyToQuery(z)}
                            className="px-2.5 py-1 font-mono tabular-nums hover:bg-surface-elevated"
                            style={{ color }}
                          >
                            {z}
                          </button>
                          {canAssign && (
                            <button
                              type="button"
                              aria-label={`Unassign ZIP ${z}`}
                              disabled={zipActions.unassign.isPending}
                              onClick={() => zipActions.unassign.mutate(z)}
                              className="px-1.5 py-1 text-muted-foreground hover:text-destructive"
                            >
                              <X className="h-3 w-3" />
                            </button>
                          )}
                        </span>
                      ))}
                    </span>
                  </li>
                );
              })}
            </ul>
          )}
        </ArcadePanel>

        {/* Manager turf list */}
        <ArcadePanel title="Assigned Areas">
          {territories.length === 0 ? (
            <div className="text-sm text-muted-foreground">
              No areas yet. Tap "Draw New Area" to define one.
            </div>
          ) : (
            <ul className="space-y-2">
              {(turfsQuery.data ?? []).map((t) => {
                const color = assigneeColor(t.assigned_user_id);
                return (
                  <li
                    key={t.id}
                    className="flex items-center justify-between gap-3 rounded border border-border bg-surface/60 p-3"
                  >
                    {/* Row tap = see it on the live map (fly + scroll up);
                        the pencil keeps the edit sheet one tap away, and the
                        turf's on-map popup has an edit button too. */}
                    <button
                      type="button"
                      title="Show this area on the map"
                      onClick={() => flyToTurf(t.polygon_coordinates)}
                      className="flex items-center gap-3 min-w-0 flex-1 text-left"
                    >
                      <span
                        className="inline-block w-3 h-3 rounded-full shrink-0"
                        style={{ background: color, boxShadow: `0 0 8px ${color}` }}
                      />
                      <div className="min-w-0">
                        <div className="font-display text-sm text-foreground truncate">
                          {t.name}
                        </div>
                        <div className="text-[10px] uppercase tracking-widest text-muted-foreground truncate">
                          <MapPin className="inline w-3 h-3 mr-1" />
                          {t.assigned_user_id
                            ? (t.assignee?.display_name ?? "Unknown assignee")
                            : "Unassigned"}
                          {" · "}
                          {(t.polygon_coordinates ?? []).length} vertices
                        </div>
                      </div>
                    </button>
                    <Button
                      size="icon"
                      variant="ghost"
                      title="Edit area (assignee, name)"
                      onClick={() => {
                        setEditingTurfId(t.id);
                        setIsModalOpen(true);
                      }}
                      className="text-muted-foreground hover:text-foreground"
                    >
                      <Pencil className="w-4 h-4" />
                    </Button>
                    <Button
                      size="icon"
                      variant="ghost"
                      onClick={() => setListDeleteId(t.id)}
                      className="text-destructive"
                    >
                      <Trash2 className="w-4 h-4" />
                    </Button>
                  </li>
                );
              })}
            </ul>
          )}
        </ArcadePanel>
      </div>

      {/* Area details sheet */}
      <AreaDetailsSheet
        open={isModalOpen}
        onOpenChange={(v) => {
          setIsModalOpen(v);
          if (!v) setEditingTurfId(null);
          // A dismissed create keeps pendingPolygon — the floating
          // "Assign Area / Discard" buttons are the recovery path.
        }}
        mode={editingTurf ? "edit" : "create"}
        turf={editingTurf}
        vertexCount={
          editingTurf ? (editing?.polygon_coordinates ?? []).length : (pendingPolygon?.length ?? 0)
        }
        users={canvassersQuery.data ?? []}
        myTeamId={teamId}
        lastWorked={editingTurf ? lastWorked : null}
        history={editingTurf ? assignmentHistory : []}
        saving={saveTurf.isPending || updateTurf.isPending}
        deleting={deleteTurf.isPending}
        onSave={(assigneeId, name) => {
          if (editingTurf) {
            updateTurf.mutate({ id: editingTurf.id, name, assigned_user_id: assigneeId });
          } else if (pendingPolygon) {
            saveTurf.mutate({
              name,
              assigned_user_id: assigneeId,
              polygon: pendingPolygon,
              promoteHistoryId,
            });
          } else {
            // Shouldn't happen — the "deleted elsewhere" effect above closes
            // the sheet first — but a silent no-op here reads as "the button
            // did nothing," so say so instead of just returning.
            toast.error("Couldn't save — this area is no longer available. Try again.");
            setIsModalOpen(false);
          }
        }}
        onDelete={() => {
          if (editingTurf) deleteTurf.mutate(editingTurf.id);
        }}
      />

      {/* ZIP → captain assignment (admin, from Assign-ZIPs map taps) */}
      <AssignZipSheet
        open={!!zipTarget}
        onOpenChange={(v) => {
          if (!v) setZipTarget(null);
        }}
        zip={zipTarget}
        currentCaptainId={zipTargetRow?.captain_id ?? null}
        currentCaptainName={zipTargetRow?.captain?.display_name ?? null}
        captains={captains}
        saving={zipActions.assign.isPending || zipActions.unassign.isPending}
        historyCount={
          zipHistoryCountQuery.isPending ? undefined : (zipHistoryCountQuery.data ?? null)
        }
        onAssign={(captainId, includeHistory) => {
          if (!zipTarget) return;
          const zip = zipTarget;
          const captain_name =
            captains.find((c) => c.id === captainId)?.display_name ?? "the captain";
          zipActions.assign.mutate(
            { zip, captain_id: captainId },
            {
              onSuccess: () => {
                if (includeHistory) {
                  sweepHistory.mutate({ zips: [zip], captain_id: captainId, captain_name });
                }
              },
            },
          );
          setZipTarget(null);
        }}
        // Pre-cascade ZIPs: hand the historic areas to the EXISTING zone
        // captain without an unassign/reassign dance.
        onSweepHistory={() => {
          if (!zipTarget || !zipTargetRow?.captain_id) return;
          sweepHistory.mutate({
            zips: [zipTarget],
            captain_id: zipTargetRow.captain_id,
            captain_name: zipTargetRow.captain?.display_name ?? "the captain",
          });
          setZipTarget(null);
        }}
        onUnassign={() => {
          if (!zipTarget) return;
          zipActions.unassign.mutate(zipTarget);
          setZipTarget(null);
        }}
      />

      {/* Delete confirm for the Assigned Areas list */}
      <DeleteAreaConfirmDialog
        open={!!listDeleteId}
        onOpenChange={(v) => {
          if (!v) setListDeleteId(null);
        }}
        areaName={listDeleting?.name ?? "this area"}
        deleting={deleteTurf.isPending}
        onConfirm={() => {
          if (listDeleteId) deleteTurf.mutate(listDeleteId);
        }}
      />

      {/* Delete confirm for a historical coverage ring (map popup action) */}
      <DeleteAreaConfirmDialog
        open={!!historyDelete}
        onOpenChange={(v) => {
          if (!v) setHistoryDelete(null);
        }}
        areaName={historyDelete?.label ?? "this historical area"}
        deleting={deleteHistoryArea.isPending}
        onConfirm={() => {
          if (historyDelete) deleteHistoryArea.mutate(historyDelete.id);
        }}
      />
    </>
  );
}
