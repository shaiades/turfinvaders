import { createFileRoute, Navigate } from "@tanstack/react-router";
import { useEffect, useMemo, useState } from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { supabase } from "@/integrations/supabase/client";
import { useAuth } from "@/hooks/useAuth";
import { useGeoWatch } from "@/hooks/useFieldPins";
import { useRealtimeInvalidate } from "@/hooks/useRealtimeInvalidate";
import { assigneeColor } from "@/lib/assignee-colors";
import { ArcadePanel } from "@/components/arcade";
import { ActiveRun } from "@/components/ActiveRun";
import { NeonMap, type Territory, type LatLng } from "@/components/NeonMap";
import {
  AreaDetailsSheet,
  DeleteAreaConfirmDialog,
  type AssignableUser,
  type AreaDetailsTurf,
  type LastWorked,
  type AssignmentHistoryEntry,
} from "@/components/AreaDetailsSheet";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { toast } from "sonner";
import { Crosshair, Pencil, MapPin, Trash2, Zap } from "lucide-react";

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
// get the canvass screen with a Turf Tools escape hatch, and only the Admin
// tier keeps the manager drawing/assignment view below.
function MyTerritoryPage() {
  const { role, loading } = useAuth();
  if (loading) return <div className="text-sm text-muted-foreground">Loading…</div>;
  if (role === "canvasser" || !role) return <Navigate to="/field" replace />;
  if (role === "captain") return <CaptainTerritory />;
  return <ManagerTerritoryView />;
}

// Captains canvass by default (owner decision 2026-09-08 — the merge also
// UPGRADED captains from view-only to dropping/correcting their own pins),
// with turf drawing one tap away. Plain state: drawing is a short task, and
// a reload landing back on the canvass screen is the right default.
function CaptainTerritory() {
  const [turfTools, setTurfTools] = useState(false);
  if (turfTools) return <ManagerTerritoryView onBackToCanvassing={() => setTurfTools(false)} />;
  return <ActiveRun variant="captain" onOpenTurfTools={() => setTurfTools(true)} />;
}

function ManagerTerritoryView({ onBackToCanvassing }: { onBackToCanvassing?: () => void }) {
  const { user, role } = useAuth();
  const qc = useQueryClient();
  const { me, geoStatus } = useGeoWatch();
  const [drawing, setDrawing] = useState(false);
  const [pendingPolygon, setPendingPolygon] = useState<LatLng[] | null>(null);
  const [isModalOpen, setIsModalOpen] = useState(false);
  const [editingTurfId, setEditingTurfId] = useState<string | null>(null);
  const [listDeleteId, setListDeleteId] = useState<string | null>(null);
  const [query, setQuery] = useState("");
  const [searchBusy, setSearchBusy] = useState(false);
  const [flyTo, setFlyTo] = useState<{
    bounds: [[number, number], [number, number]];
    key: number;
  } | null>(null);

  async function jumpToPlace(e: React.FormEvent) {
    e.preventDefault();
    const q = query.trim();
    if (q.length < 3 || searchBusy) return;
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

  // Managers see every turf (canvasser self-scoping lives in ActiveRun now)
  const turfsQuery = useQuery({
    enabled: !!user?.id,
    queryKey: ["turfs", user?.id, role],
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
  });

  // Managers see reassignments live (requires turfs in the realtime publication)
  useRealtimeInvalidate({
    channel: "my-territory-turfs",
    tables: ["turfs"],
    invalidateKeys: [["turfs"], ["turf_history"]],
    enabled: !!user?.id,
  });

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
        .select("id, display_name, office_location, teams!profiles_team_fk(name)")
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
          },
        ]),
      );
      // Dedupe: a user holding two roles (e.g. captain + canvasser) must not
      // appear twice in the assign list.
      const byId = new Map<string, AssignableUser>();
      for (const r of roleRows ?? []) {
        const id = r.user_id as string;
        if (byId.has(id)) continue;
        const p = profById.get(id);
        byId.set(id, {
          id,
          display_name: p?.display_name ?? id,
          role: r.role as string,
          office_location: p?.office_location ?? null,
          team_name: p?.team_name ?? null,
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
        assignmentLabel: t.assigned_user_id
          ? (t.assignee?.display_name ?? "Assigned")
          : "Unassigned",
        currentAssignee: t.assigned_user_id ? (t.assignee?.display_name ?? "Assigned") : null,
        history: historyByTurf.get(t.id) ?? [],
      })),
    [turfsQuery.data, historyByTurf],
  );

  const saveTurf = useMutation({
    mutationFn: async (payload: {
      name: string;
      assigned_user_id: string | null;
      polygon: LatLng[];
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
      qc.invalidateQueries({ queryKey: ["turfs"] });
      qc.invalidateQueries({ queryKey: ["turf_history"] });
    },
    onError: (e: Error) => {
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

  // Managers never drop field pins — a stray map tap would insert a field_pins
  // row for them and bump their daily_logs via bump_daily_log_from_pin.
  const mapMode = drawing
    ? {
        kind: "draw" as const,
        onComplete: (poly: LatLng[]) => {
          setPendingPolygon(poly);
          setIsModalOpen(true);
        },
      }
    : { kind: "view" as const };

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
            <Button onClick={() => setDrawing(true)} className="gap-2">
              <Pencil className="w-3.5 h-3.5" /> Draw New Area
            </Button>
          ) : (
            <Button
              variant="outline"
              onClick={() => {
                setDrawing(false);
                setPendingPolygon(null);
              }}
            >
              Cancel Drawing
            </Button>
          )}
          <span className="text-[10px] text-muted-foreground uppercase tracking-widest">
            {drawing ? "Drag on the map to draw an area" : `${territories.length} area(s) drawn`}
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
        </div>

        <div className="relative">
          {/* No `follow`: managers open framing ALL turfs (FitBounds) instead
              of zoom-18 on their own position — with GPS granted, FollowMe's
              2 km self-cage made cross-county turf hunting impossible. The
              me-dot still renders; recenter still jumps to it. */}
          <NeonMap
            territories={territories}
            pins={[]}
            houses={[]}
            me={me}
            height={560}
            flyTo={flyTo}
            pendingPolygon={pendingPolygon}
            mode={mapMode}
            onTerritoryClick={
              !drawing
                ? (id) => {
                    setEditingTurfId(id);
                    setIsModalOpen(true);
                  }
                : undefined
            }
            // Tapping a turf opens an on-map card (current assignee + recent
            // history + an edit button) rather than jumping straight to the
            // sheet. Disabled mid-draw so a stray tap doesn't fight drawing.
            territoryPopups={!drawing}
          />

          {/* Floating fallback: always visible when a polygon is pending */}
          {pendingPolygon && pendingPolygon.length >= 3 && !isModalOpen && (
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
                  setIsModalOpen(false);
                }}
              >
                Discard
              </Button>
            </div>
          )}
        </div>

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
                    <button
                      type="button"
                      onClick={() => {
                        setEditingTurfId(t.id);
                        setIsModalOpen(true);
                      }}
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
        lastWorked={editingTurf ? lastWorked : null}
        history={editingTurf ? assignmentHistory : []}
        saving={saveTurf.isPending || updateTurf.isPending}
        deleting={deleteTurf.isPending}
        onSave={(assigneeId, name) => {
          if (editingTurf) {
            updateTurf.mutate({ id: editingTurf.id, name, assigned_user_id: assigneeId });
          } else {
            if (!pendingPolygon) return;
            saveTurf.mutate({ name, assigned_user_id: assigneeId, polygon: pendingPolygon });
          }
        }}
        onDelete={() => {
          if (editingTurf) deleteTurf.mutate(editingTurf.id);
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
    </>
  );
}
