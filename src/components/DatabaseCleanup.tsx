import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { useServerFn } from "@tanstack/react-start";
import { supabase } from "@/integrations/supabase/client";
import { ArcadePanel, TeamBadge } from "@/components/arcade";
import { Button } from "@/components/ui/button";
import { deleteProfile, deleteVan } from "@/lib/fleet.functions";
import { toast } from "sonner";
import { Trash2, Truck, User } from "lucide-react";

/** Destructive van/user purge tools — lives on the Manage Players screen
 *  (was embedded in the Executive Dashboard). Owner only by placement. */
export function DatabaseCleanup() {
  const qc = useQueryClient();
  const deleteProfileFn = useServerFn(deleteProfile);
  const deleteVanFn = useServerFn(deleteVan);

  const q = useQuery({
    queryKey: ["cleanup_inventory"],
    queryFn: async () => {
      const [vansR, profilesR, rolesR] = await Promise.all([
        supabase.from("teams").select("id, name, color").order("name"),
        supabase.from("profiles").select("id, display_name, team_id").order("display_name"),
        supabase.from("user_roles").select("user_id, role"),
      ]);
      if (vansR.error) throw vansR.error;
      if (profilesR.error) throw profilesR.error;
      if (rolesR.error) throw rolesR.error;
      const rolesByUser = new Map<string, string[]>();
      for (const r of rolesR.data ?? []) {
        const arr = rolesByUser.get(r.user_id) ?? [];
        arr.push(r.role);
        rolesByUser.set(r.user_id, arr);
      }
      return { vans: vansR.data ?? [], profiles: profilesR.data ?? [], rolesByUser };
    },
  });

  const delVan = useMutation({
    mutationFn: async (id: string) => { await deleteVanFn({ data: { id } }); },
    onSuccess: () => {
      toast.success("Van deleted");
      qc.invalidateQueries({ queryKey: ["cleanup_inventory"] });
      qc.invalidateQueries({ queryKey: ["fleet_manager"] });
      qc.invalidateQueries({ queryKey: ["fleet_status"] });
      qc.invalidateQueries({ queryKey: ["offices"] });
    },
    onError: (e: Error) => toast.error(e.message ?? "Failed to delete"),
  });

  const delUser = useMutation({
    mutationFn: async (id: string) => { await deleteProfileFn({ data: { id } }); },
    onSuccess: () => {
      toast.success("User deleted");
      qc.invalidateQueries({ queryKey: ["cleanup_inventory"] });
      qc.invalidateQueries({ queryKey: ["fleet_manager"] });
      qc.invalidateQueries({ queryKey: ["weekly_results"] });
    },
    onError: (e: Error) => toast.error(e.message ?? "Failed to delete"),
  });

  return (
    <ArcadePanel
      title="Database Cleanup · Purge Mode"
      action={<span className="text-[10px] font-display uppercase tracking-widest text-destructive">Destructive · Owner Only</span>}
    >
      {q.isLoading || !q.data ? (
        <div className="text-sm text-muted-foreground">Loading…</div>
      ) : (
        <div className="grid gap-6 lg:grid-cols-2">
          {/* Vans */}
          <div>
            <h3 className="text-[10px] font-display uppercase tracking-widest text-muted-foreground mb-2">
              All Vans ({q.data.vans.length})
            </h3>
            <div className="space-y-1.5">
              {q.data.vans.length === 0 ? (
                <div className="text-xs text-muted-foreground italic">No vans.</div>
              ) : q.data.vans.map((v) => (
                <div key={v.id} className="flex items-center justify-between gap-3 px-3 py-2 rounded border border-border bg-surface">
                  <div className="flex items-center gap-2 min-w-0">
                    <Truck className="w-4 h-4 shrink-0" style={{ color: v.color }} />
                    <TeamBadge name={v.name} color={v.color} />
                  </div>
                  <Button
                    variant="destructive"
                    disabled={delVan.isPending}
                    onClick={() => {
                      if (confirm(`Permanently delete Van "${v.name}"? Members will become Unassigned.`)) {
                        delVan.mutate(v.id);
                      }
                    }}
                  >
                    <Trash2 className="w-3.5 h-3.5 mr-1" /> Delete
                  </Button>
                </div>
              ))}
            </div>
          </div>

          {/* Users */}
          <div>
            <h3 className="text-[10px] font-display uppercase tracking-widest text-muted-foreground mb-2">
              All Users ({q.data.profiles.length})
            </h3>
            <div className="space-y-1.5 max-h-[480px] overflow-y-auto pr-1">
              {q.data.profiles.length === 0 ? (
                <div className="text-xs text-muted-foreground italic">No users.</div>
              ) : q.data.profiles.map((p) => {
                const roles = q.data.rolesByUser.get(p.id) ?? [];
                const isOwner = roles.includes("owner");
                return (
                  <div key={p.id} className="flex items-center justify-between gap-3 px-3 py-2 rounded border border-border bg-surface">
                    <div className="flex items-center gap-2 min-w-0">
                      <User className="w-4 h-4 shrink-0 text-muted-foreground" />
                      <span className="text-sm truncate">{p.display_name ?? "Unknown"}</span>
                      {roles.length > 0 && (
                        <span className="text-[9px] font-display uppercase tracking-widest text-muted-foreground">
                          · {roles.join(", ")}
                        </span>
                      )}
                    </div>
                    <Button
                      variant="destructive"
                      disabled={delUser.isPending || isOwner}
                      title={isOwner ? "Cannot delete an Owner here" : "Permanently delete user"}
                      onClick={() => {
                        if (confirm(`Permanently delete user "${p.display_name}"? This removes their account and data.`)) {
                          delUser.mutate(p.id);
                        }
                      }}
                    >
                      <Trash2 className="w-3.5 h-3.5 mr-1" /> Delete
                    </Button>
                  </div>
                );
              })}
            </div>
          </div>
        </div>
      )}
    </ArcadePanel>
  );
}
