import { useQuery } from "@tanstack/react-query";
import { supabase } from "@/integrations/supabase/client";
import { useAuth } from "@/hooks/useAuth";
import { useSetUserRole } from "@/hooks/useSetUserRole";
import {
  ACCESS_MATRIX,
  APP_ROLES,
  ROLE_LABEL,
  ROLE_TONE,
  assignableRolesFor,
  canManageTarget,
  primaryRole,
  type AccessLevel,
  type AppRole,
} from "@/lib/roles";
import { ArcadePanel, MobileCardList, MobileCard, MobileCardHeader } from "@/components/arcade";

/** Permissions tab: the static role → access matrix plus per-user role
 *  assignment. All affordances key off realRole (View As must never render
 *  false powers); the set_user_role RPC is the actual enforcement. */
export function PermissionsPanel() {
  return (
    <div className="space-y-6">
      <AccessMatrix />
      <RoleAssignmentPanel />
    </div>
  );
}

const LEVEL_LABEL: Record<AccessLevel, string> = {
  yes: "✓",
  team: "TEAM",
  self: "SELF",
  no: "—",
};

const LEVEL_TONE: Record<AccessLevel, string> = {
  yes: "text-victory",
  team: "text-warning",
  self: "text-neon",
  no: "text-muted-foreground/50",
};

export function AccessMatrix() {
  return (
    <ArcadePanel title="Access Matrix">
      {/* Mobile: one card per role listing what it can reach. */}
      <MobileCardList>
        {APP_ROLES.map((role) => (
          <MobileCard key={role}>
            <MobileCardHeader
              left={
                <span
                  className={`text-[10px] font-display uppercase tracking-widest px-2 py-1 rounded border ${ROLE_TONE[role]}`}
                >
                  {ROLE_LABEL[role]}
                </span>
              }
            />
            <ul className="space-y-1 text-xs">
              {ACCESS_MATRIX.map((area) => (
                <li key={area.key} className="flex items-baseline justify-between gap-3">
                  <span className="text-muted-foreground">{area.label}</span>
                  <span
                    className={`shrink-0 font-display text-[10px] ${LEVEL_TONE[area.access[role]]}`}
                  >
                    {LEVEL_LABEL[area.access[role]]}
                  </span>
                </li>
              ))}
            </ul>
          </MobileCard>
        ))}
      </MobileCardList>

      {/* Desktop: full matrix table. */}
      <div className="hidden md:block overflow-x-auto">
        <table className="w-full text-sm">
          <thead>
            <tr className="text-[10px] font-display uppercase tracking-widest text-muted-foreground border-b border-border">
              <th className="text-left py-2 pr-4">Area</th>
              {APP_ROLES.map((role) => (
                <th key={role} className="text-center py-2 px-2">
                  <span
                    className={`inline-block text-[10px] font-display uppercase tracking-widest px-2 py-1 rounded border ${ROLE_TONE[role]}`}
                  >
                    {ROLE_LABEL[role]}
                  </span>
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {ACCESS_MATRIX.map((area) => (
              <tr key={area.key} className="border-b border-border/40 hover:bg-surface-elevated">
                <td className="py-2.5 pr-4">
                  <div className="font-medium">{area.label}</div>
                  {area.note && (
                    <div className="text-xs text-muted-foreground mt-0.5">{area.note}</div>
                  )}
                </td>
                {APP_ROLES.map((role) => (
                  <td
                    key={role}
                    className={`py-2.5 px-2 text-center font-display text-xs ${LEVEL_TONE[area.access[role]]}`}
                  >
                    {LEVEL_LABEL[area.access[role]]}
                  </td>
                ))}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <p className="text-[10px] text-muted-foreground mt-3">
        ✓ full access · TEAM own team only · SELF own data only. Enforced by database policies —
        hiding a button is never the only lock.
      </p>
    </ArcadePanel>
  );
}

function RoleAssignmentPanel() {
  const { realRole } = useAuth();
  const setRole = useSetUserRole();

  const { data, isLoading, error } = useQuery({
    // Shares the ["manage_users"] invalidation prefix with Manage Players.
    queryKey: ["manage_users", "permissions"],
    queryFn: async () => {
      const [profilesRes, rolesRes] = await Promise.all([
        supabase.from("profiles").select("id, display_name").order("display_name"),
        supabase.from("user_roles").select("user_id, role"),
      ]);
      if (profilesRes.error) throw profilesRes.error;
      if (rolesRes.error) throw rolesRes.error;
      const rolesByUser = new Map<string, AppRole[]>();
      for (const r of rolesRes.data ?? []) {
        const arr = rolesByUser.get(r.user_id) ?? [];
        arr.push(r.role as AppRole);
        rolesByUser.set(r.user_id, arr);
      }
      return { profiles: profilesRes.data ?? [], rolesByUser };
    },
  });

  const options = assignableRolesFor(realRole);

  if (isLoading || !data) {
    return (
      <ArcadePanel title="Role Assignment">
        <div className="text-sm text-muted-foreground">Loading players…</div>
      </ArcadePanel>
    );
  }
  if (error) {
    return (
      <ArcadePanel title="Role Assignment">
        <div className="text-sm text-destructive">{(error as Error).message}</div>
      </ArcadePanel>
    );
  }

  const ownerCount = Array.from(data.rolesByUser.values()).filter((r) =>
    r.includes("owner"),
  ).length;

  return (
    <ArcadePanel title={`Role Assignment (${data.profiles.length})`}>
      <p className="text-xs text-muted-foreground mb-3">
        Multiple Owners are allowed — all Owners have equal, full access. Only Owners can grant
        Owner or Admin, or change an Owner/Admin account.
      </p>
      <div className="overflow-x-auto -mx-4 sm:mx-0">
        <table className="w-full text-sm">
          <thead>
            <tr className="text-left text-[10px] font-display uppercase tracking-widest text-muted-foreground">
              <th className="px-4 py-2">Name</th>
              <th className="px-4 py-2">Role</th>
            </tr>
          </thead>
          <tbody>
            {data.profiles.map((p) => {
              const roles = data.rolesByUser.get(p.id) ?? [];
              const currentRole: AppRole = primaryRole(roles) ?? "canvasser";
              const lastOwner = currentRole === "owner" && ownerCount <= 1;
              const locked = lastOwner || !canManageTarget(realRole, roles);
              const title = lastOwner
                ? "Cannot demote the last Owner"
                : !canManageTarget(realRole, roles)
                  ? "Only Owners can change Owner or Admin accounts"
                  : undefined;
              return (
                <tr key={p.id} className="border-t border-border">
                  <td className="px-4 py-3 font-medium">{p.display_name ?? "—"}</td>
                  <td className="px-4 py-3">
                    <select
                      value={currentRole}
                      disabled={setRole.isPending || locked}
                      onChange={(e) =>
                        setRole.mutate({ userId: p.id, role: e.target.value as AppRole })
                      }
                      className="bg-input border border-border rounded-md px-2 py-2 text-base md:text-sm disabled:opacity-50"
                      title={title}
                    >
                      {/* Keep the select truthful when the current role is
                          outside the actor's assignable set. */}
                      {!options.includes(currentRole) && (
                        <option value={currentRole} disabled>
                          {ROLE_LABEL[currentRole]}
                        </option>
                      )}
                      {options.map((r) => (
                        <option key={r} value={r}>
                          {ROLE_LABEL[r]}
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
  );
}
