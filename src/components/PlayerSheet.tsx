import { useMutation, useQueryClient } from "@tanstack/react-query";
import { useServerFn } from "@tanstack/react-start";
import { Link } from "@tanstack/react-router";
import {
  Sheet,
  SheetContent,
  SheetDescription,
  SheetHeader,
  SheetTitle,
} from "@/components/ui/sheet";
import { Button } from "@/components/ui/button";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { toast } from "sonner";
import { Archive, ArchiveRestore, History, Merge, Pencil, Send, Trash2 } from "lucide-react";
import { supabase } from "@/integrations/supabase/client";
import { deleteProfile } from "@/lib/fleet.functions";
import { useSetUserRole } from "@/hooks/useSetUserRole";
import { ROSTER_KEYS, useArchiveAgents, useMoveAgents } from "@/hooks/useRosterActions";
import { useAuth } from "@/hooks/useAuth";
import {
  assignableRolesFor,
  isAdminRole,
  ROLE_LABEL,
  ROLE_TONE,
  type AppRole,
} from "@/lib/role-policy";
import type { RosterProfile, Van } from "@/hooks/useFleetRoster";
import { DEFAULT_OFFICE } from "@/lib/offices";

/** One person as Manage Players sees them: every same-name profile rides
 *  together (Move Players semantics), the auth-backed profile is the
 *  representative for role/invite/history. */
export type PlayerGroup = {
  key: string;
  display_name: string | null;
  members: RosterProfile[];
  /** Non-archived member ids — what moves/suspension/archive act on. */
  activeIds: string[];
  roles: AppRole[];
  primary: AppRole;
  /** Auth-backed member preferred; the target for role/invite/history. */
  repId: string;
  vanId: string | null;
  office: string;
  archivedOnly: boolean;
  noLogin: boolean;
  suspensionTracked: boolean;
  createdAt: string | null;
  canModify: boolean;
};

/**
 * Everything about one player in one bottom sheet — role, van, suspension,
 * invite, rename, combine, archive/reactivate, history, delete. The heavy
 * dialogs (Invite / Rename / Combine) live on the page so they can replace
 * the sheet cleanly; this component just asks for them.
 */
export function PlayerSheet({
  group,
  onOpenChange,
  vans,
  ownerCount,
  onInvite,
  onRename,
  onMerge,
}: {
  group: PlayerGroup | null;
  onOpenChange: (o: boolean) => void;
  vans: Van[];
  ownerCount: number;
  onInvite: (t: { id: string; name: string; role: AppRole }) => void;
  onRename: (g: PlayerGroup) => void;
  onMerge: (g: PlayerGroup) => void;
}) {
  const qc = useQueryClient();
  const { realRole } = useAuth();
  const setRole = useSetUserRole();
  const moveAgents = useMoveAgents(vans);
  const archiveAgents = useArchiveAgents();
  const deleteProfileFn = useServerFn(deleteProfile);
  const assignable = group?.canModify ? assignableRolesFor(realRole) : [];

  const setSuspension = useMutation({
    mutationFn: async ({ ids, tracked }: { ids: string[]; tracked: boolean }) => {
      const { data, error } = await supabase
        .from("profiles")
        .update({ suspension_tracked: tracked })
        .in("id", ids)
        .select("id");
      if (error) throw error;
      if (!data?.length) throw new Error("No permission for this player");
    },
    onSuccess: (_d, vars) => {
      toast.success(vars.tracked ? "Back on the suspension tracker" : "Off the suspension tracker");
      for (const key of ROSTER_KEYS) qc.invalidateQueries({ queryKey: key });
    },
    onError: (e: Error) => toast.error(e.message),
  });

  const reactivate = useMutation({
    mutationFn: async (ids: string[]) => {
      for (const id of ids) {
        const { error } = await supabase.rpc("reactivate_agent", { _user_id: id });
        if (error) throw error;
      }
    },
    onSuccess: () => {
      toast.success("Player reactivated — assign a van to put them back in play");
      for (const key of ROSTER_KEYS) qc.invalidateQueries({ queryKey: key });
    },
    onError: (e: Error) => toast.error(e.message ?? "Failed to reactivate"),
  });

  const removeAccount = useMutation({
    mutationFn: async (id: string) =>
      (await deleteProfileFn({ data: { id } })) as { ok: boolean; archived?: boolean },
    onSuccess: (res) => {
      toast.success(
        res?.archived
          ? "Profile archived — they have production history, so records are kept"
          : "Ghost profile deleted",
      );
      for (const key of ROSTER_KEYS) qc.invalidateQueries({ queryKey: key });
    },
    onError: (e: Error) => toast.error(e.message ?? "Failed to delete"),
  });

  if (!group) return null;
  const g = group;
  const name = g.display_name ?? "Player";
  const lastOwner = g.primary === "owner" && ownerCount <= 1;
  const isAdminActor = isAdminRole(realRole);
  const joined = g.createdAt
    ? new Date(g.createdAt).toLocaleDateString("en-US", {
        timeZone: "America/Los_Angeles",
        month: "short",
        day: "numeric",
        year: "numeric",
      })
    : null;

  const btn =
    "flex items-center gap-2 rounded-md border border-border bg-surface px-3 py-2.5 min-h-11 text-left text-[11px] font-display uppercase tracking-widest text-foreground hover:border-neon/60 hover:text-neon transition-colors disabled:opacity-40 disabled:cursor-not-allowed disabled:hover:border-border disabled:hover:text-foreground";

  return (
    <Sheet open={!!group} onOpenChange={onOpenChange}>
      <SheetContent className="h-[85dvh]">
        <SheetHeader className="pr-10">
          <SheetTitle className="font-display uppercase tracking-widest text-neon text-base flex items-center gap-2 flex-wrap">
            <span className="min-w-0 truncate">{name}</span>
            <span
              className={`shrink-0 text-[9px] px-1.5 py-0.5 rounded border ${ROLE_TONE[g.primary]}`}
            >
              {ROLE_LABEL[g.primary]}
            </span>
          </SheetTitle>
          <SheetDescription className="text-xs flex items-center gap-2 flex-wrap">
            {joined && <span>Joined {joined}</span>}
            <span>· {g.office}</span>
            {g.noLogin && (
              <span className="text-[color:var(--neon-blue)] font-display uppercase tracking-widest text-[9px] border border-[color:var(--neon-blue)]/50 rounded px-1.5 py-0.5">
                No login yet
              </span>
            )}
            {g.archivedOnly && (
              <span className="text-muted-foreground font-display uppercase tracking-widest text-[9px] border border-border rounded px-1.5 py-0.5">
                Archived
              </span>
            )}
          </SheetDescription>
        </SheetHeader>

        <div className="flex-1 min-h-0 overflow-y-auto px-4 py-3 space-y-4">
          {!g.canModify && (
            <p className="text-xs text-muted-foreground border border-border rounded-md px-3 py-2">
              Owner and Manager accounts can only be changed by an Owner.
            </p>
          )}

          {/* Role + Van */}
          <div className="grid grid-cols-2 gap-3">
            <label className="flex flex-col gap-1 text-xs">
              <span className="font-display uppercase tracking-widest text-[10px] text-muted-foreground">
                Role
              </span>
              {assignable.length > 0 ? (
                <Select
                  value={g.primary}
                  disabled={setRole.isPending || lastOwner}
                  onValueChange={(val) => {
                    if (val !== g.primary)
                      setRole.mutate({ userId: g.repId, role: val as AppRole });
                  }}
                >
                  <SelectTrigger
                    className="min-h-11"
                    title={lastOwner ? "Cannot demote the last Owner" : undefined}
                  >
                    <SelectValue />
                  </SelectTrigger>
                  {/* Sheet is z-[9999]; a stock z-50 menu would hide behind it. */}
                  <SelectContent className="z-[10000]">
                    {/* Current role always listed so the trigger renders it,
                        even when the actor couldn't grant it fresh. */}
                    {(assignable.includes(g.primary) ? assignable : [g.primary, ...assignable]).map(
                      (r) => (
                        <SelectItem key={r} value={r} disabled={!assignable.includes(r)}>
                          {ROLE_LABEL[r]}
                        </SelectItem>
                      ),
                    )}
                  </SelectContent>
                </Select>
              ) : (
                <span
                  className={`inline-flex items-center min-h-11 px-2.5 rounded border text-[10px] font-display uppercase tracking-widest ${ROLE_TONE[g.primary]}`}
                  title="You can't change this account's role"
                >
                  {ROLE_LABEL[g.primary]}
                </span>
              )}
            </label>

            <label className="flex flex-col gap-1 text-xs">
              <span className="font-display uppercase tracking-widest text-[10px] text-muted-foreground">
                Van
              </span>
              <Select
                value={g.vanId ?? "free"}
                disabled={moveAgents.isPending || !g.canModify || g.archivedOnly}
                onValueChange={(val) => {
                  const next = val === "free" ? null : val;
                  if (next !== g.vanId) moveAgents.mutate({ ids: g.activeIds, vanId: next, name });
                }}
              >
                <SelectTrigger className="min-h-11">
                  <SelectValue placeholder="Assign Van…" />
                </SelectTrigger>
                <SelectContent className="z-[10000]">
                  <SelectItem value="free">Free Agents</SelectItem>
                  {vans.map((v) => (
                    <SelectItem key={v.id} value={v.id}>
                      <span className="inline-flex items-center gap-2">
                        <span
                          className="w-2 h-2 rounded-full"
                          style={{ background: v.color ?? "#888" }}
                        />
                        {v.name}
                        <span className="text-[10px] text-muted-foreground">
                          {v.office_location ?? DEFAULT_OFFICE}
                        </span>
                      </span>
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </label>
          </div>

          {/* Suspension tracking */}
          <label className="flex items-center justify-between gap-3 rounded-md border border-border bg-surface px-3 py-2.5 cursor-pointer select-none">
            <span className="text-xs">
              <span className="font-display uppercase tracking-widest text-[10px] text-muted-foreground block">
                Suspension tracking
              </span>
              Counted on the Live Dispatch suspension (donut) list
            </span>
            <input
              type="checkbox"
              checked={g.suspensionTracked}
              disabled={setSuspension.isPending || !g.canModify || g.archivedOnly}
              onChange={(e) =>
                setSuspension.mutate({ ids: g.activeIds, tracked: e.target.checked })
              }
              className="h-5 w-5 accent-[var(--neon)]"
            />
          </label>

          {/* Actions */}
          <div className="grid grid-cols-2 gap-2">
            <button
              type="button"
              className={`${btn} border-neon/50 text-neon`}
              disabled={!g.canModify}
              title={
                g.noLogin
                  ? "Creates their login and hands you a one-time sign-in link — history attached"
                  : "One-time sign-in link to text or email them"
              }
              onClick={() => onInvite({ id: g.repId, name, role: g.primary })}
            >
              <Send className="w-4 h-4 shrink-0" /> Invite / Login
            </button>
            <Link
              to="/canvassers/$canvasserId"
              params={{ canvasserId: g.repId }}
              className={btn}
              onClick={() => onOpenChange(false)}
            >
              <History className="w-4 h-4 shrink-0" /> Full history
            </Link>
            <button
              type="button"
              className={btn}
              disabled={!g.canModify}
              onClick={() => onRename(g)}
            >
              <Pencil className="w-4 h-4 shrink-0" /> Rename
            </button>
            <button
              type="button"
              className={btn}
              disabled={!g.canModify}
              onClick={() => onMerge(g)}
            >
              <Merge className="w-4 h-4 shrink-0" /> Combine
            </button>
            {g.archivedOnly ? (
              <button
                type="button"
                className={btn}
                disabled={!g.canModify || reactivate.isPending}
                onClick={() => reactivate.mutate(g.members.map((m) => m.id))}
              >
                <ArchiveRestore className="w-4 h-4 shrink-0" /> Reactivate
              </button>
            ) : (
              <button
                type="button"
                className={btn}
                disabled={!g.canModify || g.roles.includes("owner") || archiveAgents.isPending}
                title="Removes them from every roster and revokes their login — history stays, reactivate anytime"
                onClick={() => {
                  if (
                    confirm(
                      `Remove "${name}" from the roster? Their login stops working and they drop off every list — history and stats stay, and you can reactivate them anytime.`,
                    )
                  ) {
                    archiveAgents.mutate({ ids: g.activeIds, name });
                    onOpenChange(false);
                  }
                }}
              >
                <Archive className="w-4 h-4 shrink-0" /> Remove
              </button>
            )}
            {isAdminActor && g.members.length === 1 && (
              <button
                type="button"
                className={`${btn} border-destructive/50 text-destructive hover:border-destructive hover:text-destructive`}
                disabled={!g.canModify || removeAccount.isPending}
                title="Ghosts (no production) are deleted permanently; anyone with history is archived instead"
                onClick={() => {
                  if (
                    confirm(
                      `Delete "${name}"? Profiles with no production are removed permanently; anyone with history is archived instead.`,
                    )
                  ) {
                    removeAccount.mutate(g.members[0].id);
                    onOpenChange(false);
                  }
                }}
              >
                <Trash2 className="w-4 h-4 shrink-0" /> Delete
              </button>
            )}
          </div>

          {/* Duplicate accounts detail — the split/cleanup path. */}
          {g.members.length > 1 && (
            <div className="space-y-1.5">
              <div className="text-[10px] font-display uppercase tracking-widest text-muted-foreground">
                {g.members.length} profiles share this name
                <span className="opacity-60">
                  {" "}
                  · normal for Monday imports — Combine merges them
                </span>
              </div>
              {g.members.map((m) => {
                const mVan = m.team_id ? vans.find((v) => v.id === m.team_id) : null;
                return (
                  <div
                    key={m.id}
                    className="flex items-center gap-2 rounded border border-border bg-surface px-2.5 py-1.5 text-xs min-w-0"
                  >
                    <span className="min-w-0 flex-1 flex items-center gap-1.5 flex-wrap">
                      <span className="text-muted-foreground">
                        {m.is_placeholder ? "Roster entry (no login)" : "Login account"}
                      </span>
                      {m.is_active === false && (
                        <span className="text-[9px] font-display uppercase tracking-widest border border-border rounded px-1 py-0.5 text-muted-foreground">
                          archived
                        </span>
                      )}
                    </span>
                    <span className="shrink-0 flex items-center gap-1.5 text-[10px] font-display uppercase tracking-wider text-muted-foreground">
                      <span
                        className="w-2 h-2 rounded-full"
                        style={{ background: mVan?.color ?? "#555" }}
                      />
                      {mVan?.name ?? "Free Agent"}
                    </span>
                    {isAdminActor && g.canModify && (
                      <button
                        type="button"
                        onClick={() => {
                          if (
                            confirm(
                              `Delete this ${m.is_placeholder ? "roster entry" : "login account"} for "${name}"? No production → deleted; has production → archived.`,
                            )
                          ) {
                            removeAccount.mutate(m.id);
                          }
                        }}
                        disabled={removeAccount.isPending}
                        className="shrink-0 p-1.5 rounded hover:bg-destructive/20 text-destructive"
                        title="Delete just this profile"
                      >
                        <Trash2 className="w-3.5 h-3.5" />
                      </button>
                    )}
                  </div>
                );
              })}
            </div>
          )}
        </div>
      </SheetContent>
    </Sheet>
  );
}
