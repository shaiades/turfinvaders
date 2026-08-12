import { createFileRoute } from "@tanstack/react-router";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { useServerFn } from "@tanstack/react-start";
import { useState } from "react";
import { supabase } from "@/integrations/supabase/client";
import { OFFICE_LOCATIONS, type OfficeLocation } from "@/lib/offices";
import { ArcadePanel } from "@/components/arcade";
import { DatabaseCleanup } from "@/components/DatabaseCleanup";
import { createCanvasser } from "@/lib/users.functions";
import { toast } from "sonner";
import { ADMIN_ROLES, primaryRole, requireRoleBeforeLoad, type AppRole } from "@/lib/roles";
import {
  assignableRolesFor,
  canManageTarget,
  creatableRolesFor,
  ROLE_LABEL,
  ROLE_TONE,
} from "@/lib/role-policy";
import { useSetUserRole } from "@/hooks/useSetUserRole";
import { useAuth } from "@/hooks/useAuth";

export const Route = createFileRoute("/_authenticated/users")({
  head: () => ({ meta: [{ title: "Manage Users — Knockout" }] }),
  // Owners + Admins only (owner decision 2026-08-12) — captains manage their
  // rosters from the Fleet Dispatch board instead.
  beforeLoad: requireRoleBeforeLoad(ADMIN_ROLES),
  component: UsersPage,
  errorComponent: ({ error }) => (
    <div className="text-sm text-destructive">Failed to load users: {error.message}</div>
  ),
  notFoundComponent: () => <div className="text-sm text-muted-foreground">Not found.</div>,
});

function UsersPage() {
  const qc = useQueryClient();
  const { realRole } = useAuth();
  const isOwner = realRole === "owner";

  const { data, isLoading } = useQuery({
    queryKey: ["manage_users"],
    queryFn: async () => {
      const [profilesRes, rolesRes, teamsRes] = await Promise.all([
        supabase
          .from("profiles")
          .select(
            "id, display_name, team_id, level, xp, suspension_tracked, created_at, is_placeholder",
          )
          .order("created_at", { ascending: false }),
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

  // Atomic role swap via the set_user_role RPC — the old client-side
  // delete-then-insert only worked for Owners under RLS and could strand a
  // user role-less on partial failure.
  const setRole = useSetUserRole();

  const setSuspensionTracked = useMutation({
    mutationFn: async ({ userId, tracked }: { userId: string; tracked: boolean }) => {
      // .select() so an RLS-blocked update (0 rows) errors instead of
      // silently toasting success.
      const { data: rows, error } = await supabase
        .from("profiles")
        .update({ suspension_tracked: tracked })
        .eq("id", userId)
        .select("id");
      if (error) throw error;
      if (!rows?.length) throw new Error("Update failed — you don't have permission for this user");
    },
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["manage_users"] });
      toast.success("Suspension tracking updated");
    },
    onError: (e: Error) => toast.error(e.message),
  });

  const setTeam = useMutation({
    mutationFn: async ({ userId, teamId }: { userId: string; teamId: string | null }) => {
      const { data: rows, error } = await supabase
        .from("profiles")
        .update({ team_id: teamId })
        .eq("id", userId)
        .select("id");
      if (error) throw error;
      if (!rows?.length) throw new Error("Update failed — you don't have permission for this user");
    },
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["manage_users"] });
      qc.invalidateQueries({ queryKey: ["fleet_dispatch"] });
      toast.success("Team updated");
    },
    onError: (e: Error) => toast.error(e.message),
  });

  const createFn = useServerFn(createCanvasser);
  const [form, setForm] = useState({
    email: "",
    password: "",
    display_name: "",
    role: "canvasser" as AppRole,
    office_location: "" as "" | OfficeLocation,
    team_id: "",
  });

  const createUser = useMutation({
    mutationFn: async () => {
      return createFn({
        data: {
          email: form.email,
          password: form.password,
          display_name: form.display_name,
          role: form.role,
          office_location: form.office_location || undefined,
          team_id: form.team_id || undefined,
        },
      });
    },
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["manage_users"] });
      toast.success(`Added ${form.display_name}`);
      setForm({ email: "", password: "", display_name: "", role: "canvasser", office_location: "", team_id: "" });
    },
    onError: (e: Error) => toast.error(e.message),
  });

  if (isLoading || !data) return <div className="text-sm text-muted-foreground">Loading…</div>;

  const ownerCount = Array.from(data.rolesByUser.values()).filter((r) => r.includes("owner")).length;

  return (
    <div className="space-y-8">
      <div>
        <div className="text-[10px] font-display uppercase tracking-widest text-muted-foreground">
          Managers
        </div>
        <h1 className="font-display text-2xl text-neon mt-1">MANAGE PLAYERS</h1>
        <p className="text-sm text-muted-foreground mt-2">
          Newest accounts first. Multiple Owners are allowed — all Owners have equal, full access.
          Role changes are owner-only; Admins manage teams and suspension tracking, and can add new
          players as Canvasser or Sales Rep.
        </p>
      </div>

      <ArcadePanel title={`Players (${data.profiles.length})`}>
        <div className="overflow-x-auto -mx-4 sm:mx-0">
          <table className="w-full text-sm">
            <thead>
              <tr className="text-left text-[10px] font-display uppercase tracking-widest text-muted-foreground">
                <th className="px-4 py-2">Name</th>
                <th className="px-4 py-2">Joined</th>
                <th className="px-4 py-2">LVL</th>
                <th className="px-4 py-2">Role</th>
                <th className="px-4 py-2">Team</th>
                <th className="px-4 py-2" title="Counted on the Live Dispatch suspension (donut) list">Suspension</th>
              </tr>
            </thead>
            <tbody>
              {data.profiles.map((p) => {
                const roles = data.rolesByUser.get(p.id) ?? [];
                const currentRole: AppRole = primaryRole(roles) ?? "canvasser";
                const lastOwner = currentRole === "owner" && ownerCount <= 1;
                const canModify = canManageTarget(realRole, roles);
                const createdAt = (p as { created_at?: string }).created_at;
                const isNew =
                  !(p as { is_placeholder?: boolean }).is_placeholder &&
                  !!createdAt &&
                  Date.now() - new Date(createdAt).getTime() < 30 * 86400_000;
                return (
                  <tr key={p.id} className="border-t border-border">
                    <td className="px-4 py-3 font-medium">
                      <span className="inline-flex items-center gap-2">
                        {p.display_name ?? "—"}
                        {isNew && (
                          <span className="text-[9px] font-display uppercase tracking-widest px-1.5 py-0.5 rounded border border-neon/60 text-neon bg-neon/10">
                            New
                          </span>
                        )}
                      </span>
                    </td>
                    <td className="px-4 py-3 text-muted-foreground text-xs whitespace-nowrap">
                      {createdAt
                        ? new Date(createdAt).toLocaleDateString("en-US", {
                            timeZone: "America/Los_Angeles",
                            month: "short",
                            day: "numeric",
                          })
                        : "—"}
                    </td>
                    <td className="px-4 py-3 text-muted-foreground">{p.level ?? 1}</td>
                    <td className="px-4 py-3">
                      {isOwner ? (
                        <select
                          value={currentRole}
                          disabled={setRole.isPending || lastOwner}
                          onChange={(e) =>
                            setRole.mutate({ userId: p.id, role: e.target.value as AppRole })
                          }
                          className="bg-input border border-border rounded-md px-2 py-2 text-base md:text-sm disabled:opacity-50"
                          title={lastOwner ? "Cannot demote the last Owner" : undefined}
                        >
                          {assignableRolesFor(realRole).map((r) => (
                            <option key={r} value={r}>
                              {ROLE_LABEL[r] ?? r}
                            </option>
                          ))}
                        </select>
                      ) : (
                        <span
                          className={`inline-flex items-center px-2 py-1 rounded border text-[10px] font-display uppercase tracking-widest ${ROLE_TONE[currentRole]}`}
                          title="Role changes are owner-only"
                        >
                          {ROLE_LABEL[currentRole]}
                        </span>
                      )}
                    </td>
                    <td className="px-4 py-3">
                      <select
                        value={p.team_id ?? ""}
                        disabled={setTeam.isPending || !canModify}
                        onChange={(e) =>
                          setTeam.mutate({ userId: p.id, teamId: e.target.value || null })
                        }
                        className="bg-input border border-border rounded-md px-2 py-2 text-base md:text-sm disabled:opacity-50"
                      >
                        <option value="">— unassigned —</option>
                        {data.teams.map((t) => (
                          <option key={t.id} value={t.id}>
                            {t.name}
                          </option>
                        ))}
                      </select>
                    </td>
                    <td className="px-4 py-3">
                      <label className="inline-flex items-center gap-2 cursor-pointer select-none">
                        <input
                          type="checkbox"
                          checked={
                            (p as { suspension_tracked?: boolean }).suspension_tracked ?? true
                          }
                          disabled={setSuspensionTracked.isPending || !canModify}
                          onChange={(e) =>
                            setSuspensionTracked.mutate({ userId: p.id, tracked: e.target.checked })
                          }
                          className="h-4 w-4 accent-[var(--neon)]"
                        />
                        <span className="text-xs text-muted-foreground">
                          {((p as { suspension_tracked?: boolean }).suspension_tracked ?? true)
                            ? "tracked"
                            : "off"}
                        </span>
                      </label>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      </ArcadePanel>

      <ArcadePanel title="Add New Player">
        <form
          className="grid gap-3 sm:grid-cols-2"
          onSubmit={(e) => {
            e.preventDefault();
            createUser.mutate();
          }}
        >
          <label className="flex flex-col gap-1 text-xs">
            <span className="font-display uppercase tracking-widest text-muted-foreground">Display Name</span>
            <input
              required
              value={form.display_name}
              onChange={(e) => setForm({ ...form, display_name: e.target.value })}
              className="bg-input border border-border rounded-md px-2 py-2 text-base md:text-sm"
            />
          </label>
          <label className="flex flex-col gap-1 text-xs">
            <span className="font-display uppercase tracking-widest text-muted-foreground">Email</span>
            <input
              required
              type="email"
              value={form.email}
              onChange={(e) => setForm({ ...form, email: e.target.value })}
              className="bg-input border border-border rounded-md px-2 py-2 text-base md:text-sm"
            />
          </label>
          <label className="flex flex-col gap-1 text-xs">
            <span className="font-display uppercase tracking-widest text-muted-foreground">Temp Password</span>
            <input
              required
              type="text"
              minLength={8}
              value={form.password}
              onChange={(e) => setForm({ ...form, password: e.target.value })}
              className="bg-input border border-border rounded-md px-2 py-2 text-base md:text-sm"
              placeholder="min 8 characters"
            />
          </label>
          <label className="flex flex-col gap-1 text-xs">
            <span className="font-display uppercase tracking-widest text-muted-foreground">Role</span>
            <select
              value={form.role}
              onChange={(e) => setForm({ ...form, role: e.target.value as AppRole })}
              className="bg-input border border-border rounded-md px-2 py-2 text-base md:text-sm"
            >
              {creatableRolesFor(realRole).map((r) => (
                <option key={r} value={r}>
                  {ROLE_LABEL[r] ?? r}
                </option>
              ))}
            </select>
          </label>
          <label className="flex flex-col gap-1 text-xs">
            <span className="font-display uppercase tracking-widest text-muted-foreground">Office</span>
            <select
              value={form.office_location}
              onChange={(e) => setForm({ ...form, office_location: e.target.value as typeof form.office_location })}
              className="bg-input border border-border rounded-md px-2 py-2 text-base md:text-sm"
            >
              <option value="">— none —</option>
              {OFFICE_LOCATIONS.map((o) => (
                <option key={o} value={o}>{o}</option>
              ))}
            </select>
          </label>
          <label className="flex flex-col gap-1 text-xs">
            <span className="font-display uppercase tracking-widest text-muted-foreground">Team / Van</span>
            <select
              value={form.team_id}
              onChange={(e) => setForm({ ...form, team_id: e.target.value })}
              className="bg-input border border-border rounded-md px-2 py-2 text-base md:text-sm"
            >
              <option value="">— unassigned —</option>
              {data.teams.map((t) => (
                <option key={t.id} value={t.id}>{t.name}</option>
              ))}
            </select>
          </label>
          <div className="sm:col-span-2 flex justify-end">
            <button
              type="submit"
              disabled={createUser.isPending}
              className="bg-primary text-primary-foreground font-display uppercase tracking-widest text-xs px-4 py-2 rounded-md disabled:opacity-50"
            >
              {createUser.isPending ? "Adding…" : "Add Player"}
            </button>
          </div>
        </form>
        <p className="text-xs text-muted-foreground mt-3">
          The player can sign in immediately with the email + temp password. Ask them to change it after first login.
        </p>
      </ArcadePanel>

      {/* Bulk deletion tools — owner-only (server-side deleteProfile is
          owner-gated anyway; don't render controls that can only error). */}
      {isOwner && <DatabaseCleanup />}
    </div>
  );
}
