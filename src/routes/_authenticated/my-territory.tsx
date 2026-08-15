import { createFileRoute } from "@tanstack/react-router";
import { useEffect, useMemo, useState } from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { supabase } from "@/integrations/supabase/client";
import { getPositionOrNull } from "@/lib/utils";
import { laTodayISO } from "@/lib/dates";
import { useAuth } from "@/hooks/useAuth";
import { dailyLogKeys } from "@/hooks/useDailyLogs";
import { useRealtimeInvalidate } from "@/hooks/useRealtimeInvalidate";
import { isManagerRole } from "@/lib/roles";
import { assigneeColor } from "@/lib/assignee-colors";
import { ArcadePanel } from "@/components/arcade";
import { NeonMap, type Territory, type FieldPin, type LatLng } from "@/components/NeonMap";
import {
  AreaDetailsSheet, DeleteAreaConfirmDialog,
  type AssignableUser, type AreaDetailsTurf, type LastWorked,
} from "@/components/AreaDetailsSheet";
import { Button } from "@/components/ui/button";
import { toast } from "sonner";
import {
  Home, Sparkles, Crosshair, Pencil, MapPin, Trash2,
  ThumbsDown, KeyRound, Undo2, CalendarCheck,
} from "lucide-react";
import { GratitudeGate } from "@/components/GratitudeGate";

export const Route = createFileRoute("/_authenticated/my-territory")({
  head: () => ({ meta: [{ title: "My Territory — Knockout" }] }),
  component: MyTerritoryPage,
});


function haversineMeters(a: LatLng, b: LatLng) {
  const R = 6371000;
  const toRad = (d: number) => (d * Math.PI) / 180;
  const dLat = toRad(b.lat - a.lat);
  const dLng = toRad(b.lng - a.lng);
  const s1 = Math.sin(dLat / 2);
  const s2 = Math.sin(dLng / 2);
  const h = s1 * s1 + Math.cos(toRad(a.lat)) * Math.cos(toRad(b.lat)) * s2 * s2;
  return 2 * R * Math.asin(Math.min(1, Math.sqrt(h)));
}

type ActivePin = FieldPin["pin_type"];

// The six knock results (owner directive 2026-08-15). Appt is map-only:
// appointments and sales are counted from Monday.com, never from pins.
const KNOCK_RESULTS: Array<{ type: ActivePin; label: string; color: string; icon: React.ReactNode }> = [
  { type: "lead", label: "Lead", color: "#39ff14", icon: <Sparkles className="w-4 h-4" /> },
  { type: "not_home", label: "NH", color: "#ff2d55", icon: <Home className="w-4 h-4" /> },
  { type: "go_back", label: "GB", color: "#00e5ff", icon: <Undo2 className="w-4 h-4" /> },
  { type: "renter", label: "Renter", color: "#c77dff", icon: <KeyRound className="w-4 h-4" /> },
  { type: "not_interested", label: "NI", color: "#ff6b00", icon: <ThumbsDown className="w-4 h-4" /> },
  { type: "appt", label: "Appt", color: "#ffd60a", icon: <CalendarCheck className="w-4 h-4" /> },
];

const RESULT_TOASTS: Partial<Record<ActivePin, string>> = {
  lead: "🟢 Lead pin dropped",
  not_home: "🔴 Not home",
  go_back: "🔵 Go back — hit it again later",
  renter: "🟣 Renter logged",
  not_interested: "🟠 Not interested",
  appt: "🟡 Appt marked — counts come from Monday",
};

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

function MyTerritoryPage() {
  const { user, role } = useAuth();
  const qc = useQueryClient();
  const isManager = isManagerRole(role);
  const [me, setMe] = useState<LatLng | null>(null);
  const [active, setActive] = useState<ActivePin>("lead");
  const [drawing, setDrawing] = useState(false);
  const [pendingPolygon, setPendingPolygon] = useState<LatLng[] | null>(null);
  const [isModalOpen, setIsModalOpen] = useState(false);
  const [editingTurfId, setEditingTurfId] = useState<string | null>(null);
  const [listDeleteId, setListDeleteId] = useState<string | null>(null);

  useEffect(() => {
    if (!navigator.geolocation) return;
    const id = navigator.geolocation.watchPosition(
      (pos) => setMe({ lat: pos.coords.latitude, lng: pos.coords.longitude }),
      (err) => console.warn("geo err", err.message),
      { enableHighAccuracy: true, maximumAge: 15000 },
    );
    return () => navigator.geolocation.clearWatch(id);
  }, []);

  // Turfs: managers see all, canvassers see only their assigned (enforced by RLS too)
  const turfsQuery = useQuery({
    enabled: !!user?.id,
    queryKey: ["turfs", user?.id, role],
    queryFn: async () => {
      let q = supabase
        .from("turfs")
        .select(
          `id, name, color, polygon_coordinates, assigned_user_id, assigned_by, assigned_at,
           assignee:profiles!turfs_assigned_user_id_fkey(display_name),
           assigner:profiles!turfs_assigned_by_fkey(display_name)`,
        );
      if (!isManager) q = q.eq("assigned_user_id", user!.id);
      const { data, error } = await q.order("created_at", { ascending: false });
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
    enabled: isManager,
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

  // "Who worked this area last" — most recent history entry for the turf
  // being edited (drives the don't-assign-twice-in-a-row warning).
  const historyQuery = useQuery({
    enabled: isManager && !!editingTurfId,
    queryKey: ["turf_history", editingTurfId],
    queryFn: async () => {
      const { data, error } = await supabase
        .from("turf_assignment_history")
        .select(
          `assigned_user_id, assigned_at,
           worker:profiles!turf_assignment_history_assigned_user_id_fkey(display_name)`,
        )
        .eq("turf_id", editingTurfId!)
        .order("assigned_at", { ascending: false })
        .limit(5);
      if (error) throw error;
      return (data ?? []) as unknown as Array<{
        assigned_user_id: string | null;
        assigned_at: string;
        worker: { display_name: string | null } | null;
      }>;
    },
  });

  const pinsQuery = useQuery({
    enabled: !!user?.id,
    queryKey: ["my_pins_today", user?.id],
    queryFn: async () => {
      const { data, error } = await supabase
        .from("field_pins")
        .select("id, pin_type, lat, lng, is_remote_drop, distance_m")
        .eq("canvasser_id", user!.id)
        .eq("log_date", laTodayISO());
      if (error) throw error;
      return (data ?? []) as FieldPin[];
    },
  });

  const territories: Territory[] = useMemo(
    () => (turfsQuery.data ?? []).map((t) => ({
      id: t.id,
      name: t.name,
      color: assigneeColor(t.assigned_user_id),
      polygon: (t.polygon_coordinates ?? []) as LatLng[],
      dashed: !t.assigned_user_id,
      assignmentLabel: t.assigned_user_id
        ? (t.assignee?.display_name ?? "Assigned")
        : "Unassigned",
    })),
    [turfsQuery.data],
  );

  const saveTurf = useMutation({
    mutationFn: async (payload: { name: string; assigned_user_id: string | null; polygon: LatLng[] }) => {
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
      toast.success(vars.assigned_user_id ? "Area assigned successfully!" : "Area saved — unassigned");
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
      toast.success(vars.assigned_user_id ? "Area assigned successfully!" : "Area set to unassigned");
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

  const dropPin = useMutation({
    mutationFn: async (ll: LatLng) => {
      const fix = await getPositionOrNull({ enableHighAccuracy: true, maximumAge: 10000, timeout: 8000 });
      const device = fix ? { lat: fix.coords.latitude, lng: fix.coords.longitude } : me;
      const distance_m = device ? haversineMeters(device, ll) : null;
      const is_remote_drop = distance_m == null ? true : distance_m > 18;
      const { error } = await supabase.from("field_pins").insert({
        canvasser_id: user!.id,
        pin_type: active,
        lat: ll.lat,
        lng: ll.lng,
        log_date: laTodayISO(),
        device_lat: device?.lat ?? null,
        device_lng: device?.lng ?? null,
        distance_m,
        is_remote_drop,
      });
      if (error) throw error;
      return { is_remote_drop, distance_m };
    },
    onSuccess: ({ is_remote_drop, distance_m }) => {
      if (is_remote_drop) {
        const yds = distance_m != null ? Math.round(distance_m * 1.0936) : null;
        toast.warning(`⚠ Remote Drop flagged${yds != null ? ` · ${yds} yds from pin` : ""}`, {
          description: "Pin won't count toward your stats. Walk to the door and try again.",
        });
      } else {
        toast.success(RESULT_TOASTS[active] ?? "Pin dropped");
      }
      qc.invalidateQueries({ queryKey: ["my_pins_today", user?.id] });
      // bump_daily_log_from_pin has committed by now — refresh every
      // self-scoped daily_logs read (Log form, Stats, HUD, Active Run tally).
      if (user?.id) qc.invalidateQueries({ queryKey: dailyLogKeys.all(user.id) });
    },
    onError: (e: Error) => toast.error(e.message),
  });

  const counts = useMemo(() => {
    const pins = pinsQuery.data ?? [];
    const byType: Partial<Record<ActivePin, number>> = {};
    for (const p of pins) byType[p.pin_type] = (byType[p.pin_type] ?? 0) + 1;
    return byType;
  }, [pinsQuery.data]);

  // Managers never drop field pins — a stray map tap would insert a field_pins
  // row for them and bump their daily_logs via bump_daily_log_from_pin.
  const mapMode = drawing
    ? { kind: "draw" as const, onComplete: (poly: LatLng[]) => { setPendingPolygon(poly); setIsModalOpen(true); } }
    : isManager
      ? { kind: "view" as const }
      : { kind: "pin" as const, onDrop: (ll: LatLng) => dropPin.mutate(ll) };

  const editing = editingTurfId
    ? (turfsQuery.data ?? []).find((t) => t.id === editingTurfId) ?? null
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

  const listDeleting = listDeleteId
    ? (turfsQuery.data ?? []).find((t) => t.id === listDeleteId) ?? null
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
    <GratitudeGate userId={user?.id}>
      <div className="space-y-6">
        <div className="flex items-center justify-between flex-wrap gap-3">
          <h1 className="font-display text-2xl text-neon">MY TERRITORY</h1>
          <div className="text-[10px] font-display uppercase tracking-widest text-muted-foreground flex items-center gap-2">
            <Crosshair className="w-3 h-3 text-[#00e5ff]" />
            {me ? `LIVE · ${me.lat.toFixed(4)}, ${me.lng.toFixed(4)}` : "Acquiring GPS…"}
          </div>
        </div>

        {/* Manager toolbar */}
        {isManager && (
          <div className="flex flex-wrap items-center gap-3 rounded-lg border border-neon/40 bg-surface/60 p-3">
            <div className="font-display text-[10px] uppercase tracking-widest text-neon">Turf Tools</div>
            {!drawing ? (
              <Button onClick={() => setDrawing(true)} className="gap-2">
                <Pencil className="w-3.5 h-3.5" /> Draw New Area
              </Button>
            ) : (
              <Button variant="outline" onClick={() => { setDrawing(false); setPendingPolygon(null); }}>
                Cancel Drawing
              </Button>
            )}
            <span className="text-[10px] text-muted-foreground uppercase tracking-widest">
              {drawing ? "Drag on the map to draw an area" : `${territories.length} area(s) drawn`}
            </span>
          </div>
        )}

        {/* Canvasser knock-result picker */}
        {!isManager && (
          <div className="grid grid-cols-3 gap-2 sm:gap-3">
            {KNOCK_RESULTS.map((r) => (
              <PinPicker
                key={r.type}
                label={r.label}
                count={counts[r.type] ?? 0}
                color={r.color}
                icon={r.icon}
                active={active === r.type}
                onClick={() => setActive(r.type)}
              />
            ))}
          </div>
        )}

        <div className="relative">
          <NeonMap
            territories={territories}
            pins={isManager ? [] : (pinsQuery.data ?? [])}
            houses={[]}
            me={me}
            height={560}
            follow
            lockPolygon={!isManager ? ((turfsQuery.data ?? [])[0]?.polygon_coordinates as LatLng[] | undefined) : undefined}
            pendingPolygon={isManager ? pendingPolygon : undefined}
            mode={mapMode}
            onTerritoryClick={isManager && !drawing ? (id) => { setEditingTurfId(id); setIsModalOpen(true); } : undefined}
          />

          {/* Floating fallback: always visible when a polygon is pending */}
          {isManager && pendingPolygon && pendingPolygon.length >= 3 && !isModalOpen && (
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
                onClick={() => { setPendingPolygon(null); setIsModalOpen(false); }}
              >
                Discard
              </Button>
            </div>
          )}
        </div>

        {/* Manager turf list */}
        {isManager && (
          <ArcadePanel title="Assigned Areas">
            {territories.length === 0 ? (
              <div className="text-sm text-muted-foreground">No areas yet. Tap "Draw New Area" to define one.</div>
            ) : (
              <ul className="space-y-2">
                {(turfsQuery.data ?? []).map((t) => {
                  const color = assigneeColor(t.assigned_user_id);
                  return (
                    <li key={t.id} className="flex items-center justify-between gap-3 rounded border border-border bg-surface/60 p-3">
                      <button
                        type="button"
                        onClick={() => { setEditingTurfId(t.id); setIsModalOpen(true); }}
                        className="flex items-center gap-3 min-w-0 flex-1 text-left"
                      >
                        <span className="inline-block w-3 h-3 rounded-full shrink-0" style={{ background: color, boxShadow: `0 0 8px ${color}` }} />
                        <div className="min-w-0">
                          <div className="font-display text-sm text-foreground truncate">{t.name}</div>
                          <div className="text-[10px] uppercase tracking-widest text-muted-foreground truncate">
                            <MapPin className="inline w-3 h-3 mr-1" />
                            {t.assigned_user_id
                              ? (t.assignee?.display_name ?? "Unknown assignee")
                              : "Unassigned"}
                            {" · "}{(t.polygon_coordinates ?? []).length} vertices
                          </div>
                        </div>
                      </button>
                      <Button
                        size="icon" variant="ghost"
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
        )}

        {/* Canvasser help */}
        {!isManager && (
          <ArcadePanel title="How it works">
            <ul className="text-sm text-muted-foreground space-y-1.5">
              <li>• Your assigned area appears as a colored boundary on the map.</li>
              <li>• Pick the result of the conversation above, then tap the house you knocked.</li>
              <li>• <span className="text-[#39ff14]">Lead</span> · <span className="text-[#ff2d55]">NH = Not Home</span> · <span className="text-[#00e5ff]">GB = Go Back</span> · <span className="text-[#c77dff]">Renter</span> · <span className="text-[#ff6b00]">NI = Not Interested</span> · <span className="text-[#ffd60a]">Appt</span>.</li>
              <li>• Appt pins mark the house only — appointments and sales are counted from Monday.</li>
              <li>• Pins &gt; 20 yards from your GPS location are flagged as Remote Drops.</li>
            </ul>
          </ArcadePanel>
        )}
      </div>

      {/* Area details sheet (manager-only) */}
      <AreaDetailsSheet
        open={isModalOpen && isManager}
        onOpenChange={(v) => {
          setIsModalOpen(v);
          if (!v) setEditingTurfId(null);
          // A dismissed create keeps pendingPolygon — the floating
          // "Assign Area / Discard" buttons are the recovery path.
        }}
        mode={editingTurf ? "edit" : "create"}
        turf={editingTurf}
        vertexCount={editingTurf ? (editing?.polygon_coordinates ?? []).length : (pendingPolygon?.length ?? 0)}
        users={canvassersQuery.data ?? []}
        lastWorked={editingTurf ? lastWorked : null}
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
        onOpenChange={(v) => { if (!v) setListDeleteId(null); }}
        areaName={listDeleting?.name ?? "this area"}
        deleting={deleteTurf.isPending}
        onConfirm={() => { if (listDeleteId) deleteTurf.mutate(listDeleteId); }}
      />
    </GratitudeGate>
  );
}

function PinPicker({
  label, count, color, icon, active, onClick,
}: { label: string; count: number; color: string; icon: React.ReactNode; active: boolean; onClick: () => void }) {
  return (
    <button
      onClick={onClick}
      className="relative overflow-hidden rounded-lg border p-3 sm:p-4 text-left transition-all min-w-0"
      style={{
        borderColor: active ? color : "var(--border)",
        background: active ? `color-mix(in oklab, ${color} 14%, var(--surface))` : "var(--surface)",
        boxShadow: active ? `0 0 18px -4px ${color}` : "none",
      }}
    >
      <div className="flex items-center justify-between gap-1 min-w-0">
        <div className="flex items-center gap-1.5 font-display text-[9px] uppercase tracking-widest min-w-0 truncate" style={{ color }}>
          {icon} <span className="truncate">{label}</span>
        </div>
        <div className="font-display text-xl sm:text-2xl shrink-0" style={{ color, textShadow: `0 0 10px ${color}88` }}>
          {count}
        </div>
      </div>
      <div className="mt-2 text-[9px] uppercase tracking-widest text-muted-foreground truncate">
        {active ? "ACTIVE · tap map" : "Tap to select"}
      </div>
    </button>
  );
}
