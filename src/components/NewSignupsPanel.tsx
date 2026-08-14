import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { supabase } from "@/integrations/supabase/client";
import { ArcadePanel } from "@/components/arcade";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { toast } from "sonner";
import { UserPlus } from "lucide-react";
import { useAuth } from "@/hooks/useAuth";
import { useSetUserRole } from "@/hooks/useSetUserRole";
import { useServerFn } from "@tanstack/react-start";
import { listSignupRequests } from "@/lib/users.functions";
import { assignableRolesFor, canManageTarget, primaryRole, ROLE_LABEL } from "@/lib/role-policy";
import type { Van } from "@/components/FleetDispatch";

const WINDOW_DAYS = 30;
const NEW_CHIP_DAYS = 7;

type Signup = {
  id: string;
  display_name: string | null;
  office_location: string | null;
  team_id: string | null;
  is_active: boolean | null;
  created_at: string;
};

/**
 * Recently created, login-capable accounts (is_placeholder = false), newest
 * first — the people waiting on the "AWAITING ROSTER ASSIGNMENT" screen for a
 * role and a van. Placeholder profiles from Monday.com webhooks live in the
 * Fleet Dispatch Free Agents pen instead.
 */
export function NewSignupsPanel() {
  const qc = useQueryClient();
  const { realRole } = useAuth();
  const setUserRole = useSetUserRole();

  // Keyed under ["manage_users"] so useSetUserRole's invalidation refreshes
  // this panel too.
  const { data, isLoading, error } = useQuery({
    queryKey: ["manage_users", "new_signups"],
    queryFn: async () => {
      const cutoff = new Date(Date.now() - WINDOW_DAYS * 86400_000).toISOString();
      const [profsR, rolesR] = await Promise.all([
        supabase
          .from("profiles")
          .select("id, display_name, office_location, team_id, is_active, created_at")
          .eq("is_placeholder", false)
          .gte("created_at", cutoff)
          .order("created_at", { ascending: false })
          .limit(20),
        supabase.from("user_roles").select("user_id, role"),
      ]);
      if (profsR.error) throw profsR.error;
      if (rolesR.error) throw rolesR.error;
      const rolesByUser = new Map<string, string[]>();
      for (const r of rolesR.data ?? []) {
        const arr = rolesByUser.get(r.user_id) ?? [];
        arr.push(r.role);
        rolesByUser.set(r.user_id, arr);
      }
      return { signups: (profsR.data ?? []) as Signup[], rolesByUser };
    },
  });

  // What each signup ASKED to be on the auth form (metadata claim, not a
  // grant) — renders the "wants …" chip so activation needs no guessing.
  const listRequests = useServerFn(listSignupRequests);
  const signupIds = (data?.signups ?? []).map((s) => s.id);
  const { data: requestedByUser } = useQuery({
    enabled: signupIds.length > 0,
    queryKey: ["signup_requests", signupIds.join("|")],
    queryFn: async () => listRequests({ data: { ids: signupIds } }),
  });

  // Same key + queryFn as the Fleet Dispatch board — shared cache.
  const { data: vans = [] } = useQuery({
    queryKey: ["fleet_dispatch", "vans"],
    queryFn: async () => {
      const { data: rows, error: err } = await supabase
        .from("teams")
        .select("id, name, color, captain_id, office_location")
        .order("name");
      if (err) throw err;
      return (rows ?? []) as Van[];
    },
  });

  const assignVan = useMutation({
    mutationFn: async ({ userId, vanId }: { userId: string; vanId: string | null }) => {
      const patch: { team_id: string | null; office_location?: string } = { team_id: vanId };
      if (vanId) {
        const van = vans.find((v) => v.id === vanId);
        if (van?.office_location) patch.office_location = van.office_location;
      }
      const { data: rows, error: err } = await supabase
        .from("profiles")
        .update(patch)
        .eq("id", userId)
        .select("id");
      if (err) throw err;
      if (!rows?.length) throw new Error("Assign failed — you don't have permission for this user");
    },
    onSuccess: (_d, vars) => {
      const van = vars.vanId ? vans.find((v) => v.id === vars.vanId) : null;
      toast.success(van ? `Assigned to ${van.name}` : "Moved to Free Agents");
      qc.invalidateQueries({ queryKey: ["fleet_dispatch"] });
      qc.invalidateQueries({ queryKey: ["manage_users"] });
      qc.invalidateQueries({ queryKey: ["weekly_results"] });
      qc.invalidateQueries({ queryKey: ["payroll-ledger"] });
    },
    onError: (e: Error) => toast.error(e.message),
  });

  const assignable = assignableRolesFor(realRole);
  const now = Date.now();
  const fmtJoined = (iso: string) =>
    new Date(iso).toLocaleDateString("en-US", {
      timeZone: "America/Los_Angeles",
      month: "short",
      day: "numeric",
    });

  return (
    <ArcadePanel title={`New Signups · last ${WINDOW_DAYS} days`}>
      {isLoading ? (
        <div className="text-sm text-muted-foreground py-6">Loading signups…</div>
      ) : error ? (
        <div className="text-sm text-destructive py-6">{(error as Error).message}</div>
      ) : !data || data.signups.length === 0 ? (
        <div className="text-sm text-muted-foreground py-6">
          No new signups in the last {WINDOW_DAYS} days.
        </div>
      ) : (
        <div className="space-y-1.5">
          {data.signups.map((p) => {
            const targetRoles = data.rolesByUser.get(p.id) ?? [];
            const canModify = canManageTarget(realRole, targetRoles);
            const current = primaryRole(targetRoles);
            const isNew = now - new Date(p.created_at).getTime() < NEW_CHIP_DAYS * 86400_000;
            return (
              <div
                key={p.id}
                className="flex flex-wrap sm:flex-nowrap items-center gap-2 px-2 py-1.5 rounded border border-border bg-surface hover:border-neon/60"
              >
                <span className="text-sm truncate flex-1 flex items-center gap-2 min-w-0 basis-full sm:basis-auto">
                  <UserPlus className="w-3.5 h-3.5 shrink-0 text-muted-foreground" />
                  <span className="truncate font-medium">{p.display_name ?? "Unknown"}</span>
                  {isNew && (
                    <span className="shrink-0 text-[9px] font-display uppercase tracking-widest px-1.5 py-0.5 rounded border border-neon/60 text-neon bg-neon/10">
                      New
                    </span>
                  )}
                  <span className="shrink-0 text-[10px] text-muted-foreground">
                    joined {fmtJoined(p.created_at)}
                  </span>
                  {p.is_active === false && (
                    <span className="shrink-0 text-[10px] text-muted-foreground italic">
                      (archived)
                    </span>
                  )}
                  {targetRoles.length === 0 && requestedByUser?.[p.id] && (
                    <span className="shrink-0 text-[9px] font-display uppercase tracking-widest px-1.5 py-0.5 rounded border border-turf-cyan/50 text-turf-cyan bg-turf-cyan/10">
                      wants{" "}
                      {ROLE_LABEL[requestedByUser[p.id] as keyof typeof ROLE_LABEL] ??
                        requestedByUser[p.id]}
                    </span>
                  )}
                </span>
                {assignable.length === 0 ? (
                  // Role changes are owner-only — show the current role as a
                  // read-only chip, never an empty dropdown.
                  <span
                    className="inline-flex items-center justify-center h-9 md:h-7 px-2.5 rounded border border-border bg-background text-[11px] font-display uppercase tracking-wider text-muted-foreground w-full sm:w-auto sm:min-w-[110px]"
                    title="Role changes are owner-only"
                  >
                    {current ? ROLE_LABEL[current] : "No role yet"}
                  </span>
                ) : (
                  <Select
                    value={current ?? "none"}
                    disabled={!canModify || setUserRole.isPending}
                    onValueChange={(val) => {
                      if (val !== "none" && val !== current) {
                        setUserRole.mutate({
                          userId: p.id,
                          role: val as (typeof assignable)[number],
                        });
                      }
                    }}
                  >
                    <SelectTrigger className="h-9 md:h-7 w-full sm:w-auto sm:min-w-[110px] text-[11px] font-display uppercase tracking-wider bg-background">
                      <SelectValue placeholder="No role yet" />
                    </SelectTrigger>
                    <SelectContent className="bg-background">
                      <SelectItem value="none" disabled>
                        — Role —
                      </SelectItem>
                      {assignable.map((r) => (
                        <SelectItem key={r} value={r}>
                          {ROLE_LABEL[r]}
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                )}
                <Select
                  value={p.team_id ?? "free"}
                  disabled={!canModify || assignVan.isPending}
                  onValueChange={(val) => {
                    const vanId = val === "free" ? null : val;
                    if (vanId !== p.team_id) assignVan.mutate({ userId: p.id, vanId });
                  }}
                >
                  <SelectTrigger className="h-9 md:h-7 w-full sm:w-auto sm:min-w-[120px] text-[11px] font-display uppercase tracking-wider bg-background border-[color:var(--neon-blue)]/50 hover:border-[color:var(--neon-blue)]">
                    <SelectValue placeholder="Assign Van…" />
                  </SelectTrigger>
                  <SelectContent className="bg-background border-[color:var(--neon-blue)]/50">
                    <SelectItem value="free">Free Agents</SelectItem>
                    {vans.map((v) => (
                      <SelectItem key={v.id} value={v.id}>
                        <span className="inline-flex items-center gap-2">
                          <span
                            className="w-2 h-2 rounded-full"
                            style={{ background: v.color ?? "#888" }}
                          />
                          {v.name}
                        </span>
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
            );
          })}
        </div>
      )}
      <p className="text-[10px] text-muted-foreground mt-3">
        Login-capable accounts created in the last {WINDOW_DAYS} days, newest first. Assign a van
        (and a role — Owners only) to put them in play — Monday.com placeholder agents live in Fleet
        Dispatch's Free Agents instead.
      </p>
    </ArcadePanel>
  );
}
