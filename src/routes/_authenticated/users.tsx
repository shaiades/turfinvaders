import { createFileRoute, redirect } from "@tanstack/react-router";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { useServerFn } from "@tanstack/react-start";
import { useState } from "react";
import { supabase } from "@/integrations/supabase/client";
import { ArcadePanel } from "@/components/arcade";
import { createCanvasser } from "@/lib/users.functions";
import { toast } from "sonner";
import type { AppRole } from "@/hooks/useAuth";

export const Route = createFileRoute("/_authenticated/users")({
  head: () => ({ meta: [{ title: "Manage Users — Knockout" }] }),
  beforeLoad: async () => {
    const { data } = await supabase.auth.getUser();
    if (!data.user) throw redirect({ to: "/auth" });
    const { data: roles } = await supabase
      .from("user_roles")
      .select("role")
      .eq("user_id", data.user.id)
      .eq("role", "owner");
    if (!roles || roles.length === 0) throw redirect({ to: "/dashboard" });
  },
  component: UsersPage,
  errorComponent: ({ error }) => (
    <div className="text-sm text-destructive">Failed to load users: {error.message}</div>
  ),
  notFoundComponent: () => <div className="text-sm text-muted-foreground">Not found.</div>,
});

const ROLE_OPTIONS: AppRole[] = ["owner", "office_staff", "captain", "canvasser"];

function UsersPage() {
  const qc = useQueryClient();

  const { data, isLoading } = useQuery({
    queryKey: ["manage_users"],
    queryFn: async () => {
      const [profilesRes, rolesRes, teamsRes] = await Promise.all([
        supabase.from("profiles").select("id, display_name, team_id, level, xp").order("display_name"),
        supabase.from("user_roles").select("user_id, role"),
        supabase.from("teams").select("id, name").order("name"),
      ]);
      if (profilesRes.error) throw profilesRes.error;
      if (rolesRes.error) throw rolesRes.error;
      if (teamsRes.error) throw teamsRes.error;
      const rolesByUser = new Map<string, AppRole[]>();
      for (const r of rolesRes.data ?? []) {
        const arr = rolesByUser.get(r.user_id) ?? [];
        arr.push(r.role as AppRole);
        rolesByUser.set(r.user_id, arr);
      }
      return {
        profiles: profilesRes.data ?? [],
        rolesByUser,
        teams: teamsRes.data ?? [],
      };
    },
  });

  const setRole = useMutation({
    mutationFn: async ({ userId, role }: { userId: string; role: AppRole }) => {
      // Replace all roles with the single chosen role (equal-Owners model).
      const { error: delErr } = await supabase.from("user_roles").delete().eq("user_id", userId);
      if (delErr) throw delErr;
      const { error: insErr } = await supabase.from("user_roles").insert({ user_id: userId, role });
      if (insErr) throw insErr;
    },
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["manage_users"] });
      toast.success("Role updated");
    },
    onError: (e: Error) => toast.error(e.message),
  });

  const setTeam = useMutation({
    mutationFn: async ({ userId, teamId }: { userId: string; teamId: string | null }) => {
      const { error } = await supabase.from("profiles").update({ team_id: teamId }).eq("id", userId);
      if (error) throw error;
    },
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["manage_users"] });
      toast.success("Team updated");
    },
    onError: (e: Error) => toast.error(e.message),
  });

  if (isLoading || !data) return <div className="text-sm text-muted-foreground">Loading…</div>;

  const ownerCount = Array.from(data.rolesByUser.values()).filter((r) => r.includes("owner")).length;

  return (
    <div className="space-y-8">
      <div>
        <div className="text-[10px] font-display uppercase tracking-widest text-muted-foreground">Owner Only</div>
        <h1 className="font-display text-2xl text-neon mt-1">MANAGE PLAYERS</h1>
        <p className="text-sm text-muted-foreground mt-2">
          Assign roles and teams. Multiple Owners are allowed — all Owners have equal, full access.
        </p>
      </div>

      <ArcadePanel title={`Players (${data.profiles.length})`}>
        <div className="overflow-x-auto -mx-4 sm:mx-0">
          <table className="w-full text-sm">
            <thead>
              <tr className="text-left text-[10px] font-display uppercase tracking-widest text-muted-foreground">
                <th className="px-4 py-2">Name</th>
                <th className="px-4 py-2">LVL</th>
                <th className="px-4 py-2">Role</th>
                <th className="px-4 py-2">Team</th>
              </tr>
            </thead>
            <tbody>
              {data.profiles.map((p) => {
                const roles = data.rolesByUser.get(p.id) ?? [];
                const currentRole: AppRole = roles.includes("owner")
                  ? "owner"
                  : roles.includes("office_staff")
                  ? "office_staff"
                  : roles.includes("captain")
                  ? "captain"
                  : "canvasser";
                const lastOwner = currentRole === "owner" && ownerCount <= 1;
                return (
                  <tr key={p.id} className="border-t border-border">
                    <td className="px-4 py-3 font-medium">{p.display_name ?? "—"}</td>
                    <td className="px-4 py-3 text-muted-foreground">{p.level ?? 1}</td>
                    <td className="px-4 py-3">
                      <select
                        value={currentRole}
                        disabled={setRole.isPending || lastOwner}
                        onChange={(e) =>
                          setRole.mutate({ userId: p.id, role: e.target.value as AppRole })
                        }
                        className="bg-input border border-border rounded-md px-2 py-1.5 text-sm disabled:opacity-50"
                        title={lastOwner ? "Cannot demote the last Owner" : undefined}
                      >
                        {ROLE_OPTIONS.map((r) => (
                          <option key={r} value={r}>
                            {r}
                          </option>
                        ))}
                      </select>
                    </td>
                    <td className="px-4 py-3">
                      <select
                        value={p.team_id ?? ""}
                        disabled={setTeam.isPending}
                        onChange={(e) =>
                          setTeam.mutate({ userId: p.id, teamId: e.target.value || null })
                        }
                        className="bg-input border border-border rounded-md px-2 py-1.5 text-sm"
                      >
                        <option value="">— unassigned —</option>
                        {data.teams.map((t) => (
                          <option key={t.id} value={t.id}>
                            {t.name}
                          </option>
                        ))}
                      </select>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      </ArcadePanel>

      <p className="text-xs text-muted-foreground">
        To add a new player, share the sign-in page — new accounts default to Canvasser. Promote them
        here once they sign in.
      </p>
    </div>
  );
}
