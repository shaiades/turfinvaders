import { createFileRoute } from "@tanstack/react-router";
import { useMemo, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { useServerFn } from "@tanstack/react-start";
import { ArcadePanel } from "@/components/arcade";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { ChevronDown, ChevronRight, ChevronUp, Send, ArrowRightLeft, UserPlus } from "lucide-react";
import { DatabaseCleanup } from "@/components/DatabaseCleanup";
import { InviteDialog } from "@/components/InviteDialog";
import { InvitePlayerSheet } from "@/components/InvitePlayerSheet";
import { MovePlayersSheet } from "@/components/MovePlayersSheet";
import { AddPlayerDialog } from "@/components/AddPlayerDialog";
import { PlayerSheet, type PlayerGroup } from "@/components/PlayerSheet";
import { VansPanel } from "@/components/VansPanel";
import { RenameCanvasserDialog, type NameGroupRef } from "@/components/RenameCanvasserDialog";
import { MergeCanvasserDialog } from "@/components/MergeCanvasserDialog";
import { useDispatchRoster, useDispatchVans, type RosterProfile } from "@/hooks/useFleetRoster";
import { useMoveAgents } from "@/hooks/useRosterActions";
import { useSetUserRole } from "@/hooks/useSetUserRole";
import { useAuth } from "@/hooks/useAuth";
import { listSignupRequests } from "@/lib/users.functions";
import {
  ADMIN_ROLES,
  APP_ROLES,
  assignableRolesFor,
  canManageTarget,
  primaryRole,
  requireRoleBeforeLoad,
  ROLE_LABEL,
  ROLE_TONE,
  type AppRole,
} from "@/lib/roles";
import { isLeadSourceKey } from "@/lib/lead-sources";
import { DEFAULT_OFFICE, OFFICE_FILTER_OPTIONS, type OfficeFilter } from "@/lib/offices";
import { normalizeName } from "@/lib/utils";

export const Route = createFileRoute("/_authenticated/users")({
  head: () => ({ meta: [{ title: "Manage Players — Turf Invaders" }] }),
  // Owners + Managers (captains manage their rosters from the Fleet
  // Dispatch board instead — owner decision 2026-08-12, unchanged).
  beforeLoad: requireRoleBeforeLoad(ADMIN_ROLES),
  component: UsersPage,
  errorComponent: ({ error }) => (
    <div className="text-sm text-destructive">Failed to load players: {error.message}</div>
  ),
  notFoundComponent: () => <div className="text-sm text-muted-foreground">Not found.</div>,
});

const STATUS_CHIPS = ["Active", "Archived", "All"] as const;
type StatusChip = (typeof STATUS_CHIPS)[number];

const NEW_DAYS = 30;

/**
 * THE player admin page (2026-09-16 consolidation): one searchable roster —
 * every action on a player lives in their sheet — plus new-signup triage,
 * van management, and cleanup. Absorbed the old flat table + Add New Player
 * form, the dashboard Settings tab's New Signups and Company Roster panels,
 * and Manage Fleet's van CRUD.
 */
function UsersPage() {
  const { realRole } = useAuth();
  const roster = useDispatchRoster();
  const { data: vans = [] } = useDispatchVans();
  const moveAgents = useMoveAgents(vans);
  const setUserRole = useSetUserRole();

  const [search, setSearch] = useState("");
  const [officeChip, setOfficeChip] = useState<OfficeFilter>("All");
  const [statusChip, setStatusChip] = useState<StatusChip>("Active");
  const [roleFilter, setRoleFilter] = useState<"all" | AppRole>("all");
  const [selectedKey, setSelectedKey] = useState<string | null>(null);
  const [addOpen, setAddOpen] = useState(false);
  const [moveOpen, setMoveOpen] = useState(false);
  const [invitePickerOpen, setInvitePickerOpen] = useState(false);
  const [cleanupOpen, setCleanupOpen] = useState(false);
  const [inviteTarget, setInviteTarget] = useState<{
    id: string;
    name: string;
    role: AppRole;
  } | null>(null);
  const [renameTarget, setRenameTarget] = useState<NameGroupRef | null>(null);
  const [mergeSource, setMergeSource] = useState<NameGroupRef | null>(null);
  const [mergePreset, setMergePreset] = useState<string | null>(null);

  const profiles = useMemo(() => roster.data?.profiles ?? [], [roster.data]);
  const rolesByUser = useMemo(
    () => roster.data?.rolesByUser ?? new Map<string, string[]>(),
    [roster.data],
  );
  const vanById = useMemo(() => new Map(vans.map((v) => [v.id, v])), [vans]);

  // ---- Name groups: one row per person, all duplicates riding together ----
  const groups = useMemo<PlayerGroup[]>(() => {
    const byKey = new Map<string, RosterProfile[]>();
    for (const p of profiles) {
      const key = normalizeName(p.display_name) || `id:${p.id}`;
      // Pseudo lead-source channels (Self Gen, Upsell, …) aren't people —
      // they live on the dispatch board and must never be edited here.
      if (isLeadSourceKey(key)) continue;
      const arr = byKey.get(key);
      if (arr) arr.push(p);
      else byKey.set(key, [p]);
    }
    const out: PlayerGroup[] = [];
    for (const [key, members] of byKey) {
      const active = members.filter((m) => m.is_active !== false);
      const archivedOnly = active.length === 0;
      const roleSet = new Set<string>();
      for (const m of members) for (const r of rolesByUser.get(m.id) ?? []) roleSet.add(r);
      const roles = [...roleSet] as AppRole[];
      // Auth-backed profile is the representative (role/invite/history
      // target) — an existing login must never be shadowed by a duplicate
      // placeholder (InvitePlayerSheet precedent).
      const rep =
        active.find((m) => m.is_placeholder !== true) ??
        members.find((m) => m.is_placeholder !== true) ??
        active.find((m) => m.team_id) ??
        members[0];
      const vanRep =
        active.find((m) => m.is_active === true && m.team_id) ??
        active.find((m) => m.team_id) ??
        active[0];
      const vanId = archivedOnly ? null : (vanRep?.team_id ?? null);
      const van = vanId ? vanById.get(vanId) : null;
      out.push({
        key,
        display_name: rep.display_name,
        members,
        activeIds: active.map((m) => m.id),
        roles,
        primary: (primaryRole(roles) ?? "canvasser") as AppRole,
        repId: rep.id,
        vanId,
        office:
          van?.office_location ?? vanRep?.office_location ?? rep.office_location ?? DEFAULT_OFFICE,
        archivedOnly,
        noLogin: members.every((m) => m.is_placeholder === true),
        suspensionTracked: active.some((m) => m.suspension_tracked !== false),
        createdAt: rep.created_at ?? null,
        canModify: canManageTarget(realRole, roles),
      });
    }
    return out.sort((a, b) => (a.display_name ?? "").localeCompare(b.display_name ?? ""));
  }, [profiles, rolesByUser, vanById, realRole]);

  const ownerCount = useMemo(() => {
    let n = 0;
    for (const g of groups) if (g.roles.includes("owner")) n++;
    return n;
  }, [groups]);

  // ---- New signups needing activation (absorbed New Signups panel) ----
  const now = Date.now();
  const needsAttention = useMemo(
    () =>
      profiles
        .filter((p) => {
          if (p.is_placeholder !== false || p.is_active === false) return false;
          if (!p.created_at || now - new Date(p.created_at).getTime() > NEW_DAYS * 86400_000)
            return false;
          const roles = rolesByUser.get(p.id) ?? [];
          // Waiting on a role, or activated but still vanless (owners/reps
          // never need vans — Free Agents pen rule).
          if (roles.length === 0) return true;
          const r = primaryRole(roles as AppRole[]);
          return !p.team_id && r !== "owner" && r !== "sales_rep" && r !== "office_staff";
        })
        .sort((a, b) => (b.created_at ?? "").localeCompare(a.created_at ?? "")),
    [profiles, rolesByUser, now],
  );

  const listRequests = useServerFn(listSignupRequests);
  const signupIds = needsAttention.filter((p) => (rolesByUser.get(p.id) ?? []).length === 0);
  const { data: requestedByUser } = useQuery({
    enabled: signupIds.length > 0,
    queryKey: ["signup_requests", signupIds.map((p) => p.id).join("|")],
    queryFn: async () => listRequests({ data: { ids: signupIds.map((p) => p.id).slice(0, 20) } }),
  });

  // ---- Filters ----
  const q = normalizeName(search);
  const visible = groups.filter((g) => {
    if (q && !g.key.includes(q)) return false;
    if (officeChip !== "All" && g.office !== officeChip) return false;
    if (statusChip === "Active" && g.archivedOnly) return false;
    if (statusChip === "Archived" && !g.archivedOnly) return false;
    if (roleFilter !== "all" && g.primary !== roleFilter) return false;
    return true;
  });

  const selectedGroup = selectedKey ? (groups.find((g) => g.key === selectedKey) ?? null) : null;
  const assignable = assignableRolesFor(realRole);

  const openRename = (g: PlayerGroup) => {
    setSelectedKey(null);
    setRenameTarget({ key: g.key, display_name: g.display_name });
  };
  const openMerge = (g: PlayerGroup) => {
    setSelectedKey(null);
    setMergePreset(null);
    setMergeSource({ key: g.key, display_name: g.display_name });
  };

  if (roster.isLoading) return <div className="text-sm text-muted-foreground">Loading…</div>;

  return (
    <div className="space-y-6">
      <div className="flex flex-wrap items-end justify-between gap-3">
        <div>
          <div className="text-[10px] font-display uppercase tracking-widest text-muted-foreground">
            Everyone · one place
          </div>
          <h1 className="font-display text-2xl text-neon mt-1">MANAGE PLAYERS</h1>
        </div>
        <div className="flex flex-wrap gap-2">
          <Button
            size="sm"
            onClick={() => setAddOpen(true)}
            className="gap-1.5 font-display uppercase tracking-widest text-[10px] bg-neon text-background hover:bg-neon/90"
          >
            <UserPlus className="w-3.5 h-3.5" /> Add Player
          </Button>
          <Button
            size="sm"
            variant="outline"
            onClick={() => setInvitePickerOpen(true)}
            className="gap-1.5 font-display uppercase tracking-widest text-[10px] border-neon/60 text-neon hover:border-neon hover:text-neon"
          >
            <Send className="w-3.5 h-3.5" /> Invite
          </Button>
          <Button
            size="sm"
            variant="outline"
            onClick={() => setMoveOpen(true)}
            className="gap-1.5 font-display uppercase tracking-widest text-[10px] border-[color:var(--neon-blue)]/60 text-[color:var(--neon-blue)] hover:border-[color:var(--neon-blue)] hover:text-[color:var(--neon-blue)]"
          >
            <ArrowRightLeft className="w-3.5 h-3.5" /> Move Players
          </Button>
        </div>
      </div>
      <p className="text-sm text-muted-foreground -mt-2">
        Tap a player for everything about them — role, van, invite &amp; login, rename, combine,
        remove. Roles: Owners grant anything; Managers grant up to Captain.
      </p>

      {/* ---- Needs attention: new signups waiting on a role or a van ---- */}
      {needsAttention.length > 0 && (
        <ArcadePanel title={`⚠ Needs Attention (${needsAttention.length})`}>
          <div className="space-y-1.5">
            {needsAttention.map((p) => {
              const targetRoles = (rolesByUser.get(p.id) ?? []) as AppRole[];
              const canModify = canManageTarget(realRole, targetRoles);
              const current = primaryRole(targetRoles);
              const wants = requestedByUser?.[p.id];
              return (
                <div
                  key={p.id}
                  className="flex flex-wrap sm:flex-nowrap items-center gap-2 px-2 py-1.5 rounded border border-border bg-surface hover:border-neon/60 min-w-0"
                >
                  <span className="text-sm truncate flex-1 flex items-center gap-2 min-w-0 basis-full sm:basis-auto">
                    <UserPlus className="w-3.5 h-3.5 shrink-0 text-muted-foreground" />
                    <span className="truncate font-medium">{p.display_name ?? "Unknown"}</span>
                    <span className="shrink-0 text-[10px] text-muted-foreground">
                      joined{" "}
                      {p.created_at
                        ? new Date(p.created_at).toLocaleDateString("en-US", {
                            timeZone: "America/Los_Angeles",
                            month: "short",
                            day: "numeric",
                          })
                        : "—"}
                    </span>
                    {targetRoles.length === 0 && wants && (
                      <span className="shrink-0 text-[9px] font-display uppercase tracking-widest px-1.5 py-0.5 rounded border border-turf-cyan/50 text-turf-cyan bg-turf-cyan/10">
                        wants {ROLE_LABEL[wants as AppRole] ?? wants}
                      </span>
                    )}
                  </span>
                  {assignable.length === 0 ? (
                    <span
                      className="inline-flex items-center justify-center h-9 md:h-7 px-2.5 rounded border border-border bg-background text-[11px] font-display uppercase tracking-wider text-muted-foreground w-full sm:w-auto sm:min-w-[110px]"
                      title="You can't change this account's role"
                    >
                      {current ? ROLE_LABEL[current] : "No role yet"}
                    </span>
                  ) : (
                    <Select
                      value={current ?? "none"}
                      disabled={!canModify || setUserRole.isPending}
                      onValueChange={(val) => {
                        if (val !== "none" && val !== current) {
                          setUserRole.mutate({ userId: p.id, role: val as AppRole });
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
                    disabled={!canModify || moveAgents.isPending}
                    onValueChange={(val) => {
                      const vanId = val === "free" ? null : val;
                      if (vanId !== p.team_id)
                        moveAgents.mutate({
                          ids: [p.id],
                          vanId,
                          name: p.display_name ?? "Player",
                        });
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
          <p className="text-[10px] text-muted-foreground mt-3">
            Login-capable accounts from the last {NEW_DAYS} days still waiting on a role or a van.
            Give them both and they spawn straight into their screen — nothing to refresh.
          </p>
        </ArcadePanel>
      )}

      {/* ---- The roster ---- */}
      <ArcadePanel title={`Players (${visible.length})`}>
        <div className="space-y-2">
          <Input
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            placeholder="Search players…"
            aria-label="Search players"
          />
          <div className="flex items-center gap-1.5 overflow-x-auto scrollbar-hide">
            {OFFICE_FILTER_OPTIONS.map((o) => (
              <button
                key={o}
                type="button"
                onClick={() => setOfficeChip(o)}
                className={`min-h-9 px-3 rounded-full border text-[10px] font-display uppercase tracking-widest whitespace-nowrap ${
                  officeChip === o
                    ? "border-neon text-neon bg-neon/10"
                    : "border-border text-muted-foreground hover:text-foreground"
                }`}
              >
                {o}
              </button>
            ))}
            <span className="w-px h-5 bg-border shrink-0" aria-hidden />
            {STATUS_CHIPS.map((s) => (
              <button
                key={s}
                type="button"
                onClick={() => setStatusChip(s)}
                className={`min-h-9 px-3 rounded-full border text-[10px] font-display uppercase tracking-widest whitespace-nowrap ${
                  statusChip === s
                    ? "border-neon text-neon bg-neon/10"
                    : "border-border text-muted-foreground hover:text-foreground"
                }`}
              >
                {s}
              </button>
            ))}
            <Select value={roleFilter} onValueChange={(v) => setRoleFilter(v as "all" | AppRole)}>
              <SelectTrigger className="ml-auto h-9 w-auto min-w-[120px] shrink-0 text-[10px] font-display uppercase tracking-widest bg-background">
                <SelectValue />
              </SelectTrigger>
              <SelectContent className="bg-background">
                <SelectItem value="all">All roles</SelectItem>
                {APP_ROLES.map((r) => (
                  <SelectItem key={r} value={r}>
                    {ROLE_LABEL[r]}s
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>

          <div className="space-y-1.5 pt-1">
            {visible.length === 0 ? (
              <div className="text-sm text-muted-foreground italic py-8 text-center">
                No players match.
              </div>
            ) : (
              visible.map((g) => {
                const van = g.vanId ? vanById.get(g.vanId) : null;
                const isNew =
                  !g.noLogin &&
                  !!g.createdAt &&
                  now - new Date(g.createdAt).getTime() < NEW_DAYS * 86400_000;
                return (
                  <button
                    key={g.key}
                    type="button"
                    onClick={() => setSelectedKey(g.key)}
                    className="w-full min-h-12 flex items-center gap-2 px-3 py-2 rounded border border-border bg-surface text-left hover:border-neon/60 transition-colors min-w-0"
                  >
                    <span className="min-w-0 flex-1 flex items-center gap-2 flex-wrap">
                      <span className="text-sm font-medium truncate max-w-full">
                        {g.display_name ?? "Unknown"}
                      </span>
                      {isNew && (
                        <span className="shrink-0 text-[9px] font-display uppercase tracking-widest px-1.5 py-0.5 rounded border border-neon/60 text-neon bg-neon/10">
                          New
                        </span>
                      )}
                      {g.noLogin && !g.archivedOnly && (
                        <span className="shrink-0 text-[9px] font-display uppercase tracking-widest px-1.5 py-0.5 rounded border border-[color:var(--neon-blue)]/50 text-[color:var(--neon-blue)]">
                          No login
                        </span>
                      )}
                      {g.archivedOnly && (
                        <span className="shrink-0 text-[9px] font-display uppercase tracking-widest px-1.5 py-0.5 rounded border border-border text-muted-foreground">
                          Archived
                        </span>
                      )}
                      {g.members.length > 1 && (
                        <span
                          className="shrink-0 text-[9px] font-display uppercase tracking-widest px-1.5 py-0.5 rounded border border-warning/50 text-warning"
                          title={`${g.members.length} profiles share this name — Combine merges them`}
                        >
                          ×{g.members.length}
                        </span>
                      )}
                    </span>
                    <span
                      className={`shrink-0 text-[9px] font-display uppercase tracking-widest px-1.5 py-0.5 rounded border ${ROLE_TONE[g.primary]}`}
                    >
                      {ROLE_LABEL[g.primary]}
                    </span>
                    {!g.archivedOnly && (
                      <span className="shrink-0 hidden sm:flex items-center gap-1.5 text-[10px] font-display uppercase tracking-wider text-muted-foreground">
                        <span
                          className="w-2 h-2 rounded-full"
                          style={{ background: van?.color ?? "#555" }}
                        />
                        <span className="max-w-[90px] truncate">{van?.name ?? "Free Agent"}</span>
                      </span>
                    )}
                    <ChevronRight className="w-4 h-4 shrink-0 text-muted-foreground" />
                  </button>
                );
              })
            )}
          </div>
        </div>
        <p className="text-[10px] text-muted-foreground mt-3">
          Lead-source channels (Self Gen, Upsell, …) aren't people, so they don't appear here —
          their production stays on the dispatch board. Monday.com's Van column keeps final say on
          van rides.
        </p>
      </ArcadePanel>

      {/* ---- Vans ---- */}
      <VansPanel vans={vans} profiles={profiles} rolesByUser={rolesByUser} />

      {/* ---- Cleanup (collapsed; deletes are target-guarded server-side) ---- */}
      <div>
        <button
          type="button"
          onClick={() => setCleanupOpen((o) => !o)}
          className="w-full flex items-center justify-between px-4 py-3 rounded-lg border border-border bg-surface text-left hover:bg-surface-elevated"
        >
          <span className="text-[10px] font-display uppercase tracking-widest text-muted-foreground">
            Advanced · Database Cleanup
          </span>
          {cleanupOpen ? (
            <ChevronUp className="w-4 h-4 text-muted-foreground" />
          ) : (
            <ChevronDown className="w-4 h-4 text-muted-foreground" />
          )}
        </button>
        {cleanupOpen && (
          <div className="mt-3">
            <DatabaseCleanup />
          </div>
        )}
      </div>

      {/* ---- Sheets & dialogs ---- */}
      <PlayerSheet
        group={selectedGroup}
        onOpenChange={(o) => {
          if (!o) setSelectedKey(null);
        }}
        vans={vans}
        ownerCount={ownerCount}
        onInvite={(t) => {
          setSelectedKey(null);
          setInviteTarget(t);
        }}
        onRename={openRename}
        onMerge={openMerge}
      />

      <AddPlayerDialog
        open={addOpen}
        onOpenChange={setAddOpen}
        vans={vans}
        onInvite={(t) => setInviteTarget(t)}
      />

      <InviteDialog
        open={!!inviteTarget}
        onOpenChange={(o) => {
          if (!o) setInviteTarget(null);
        }}
        target={inviteTarget}
      />

      <MovePlayersSheet open={moveOpen} onOpenChange={setMoveOpen} />
      <InvitePlayerSheet open={invitePickerOpen} onOpenChange={setInvitePickerOpen} />

      <RenameCanvasserDialog
        open={!!renameTarget}
        onOpenChange={(o) => {
          if (!o) setRenameTarget(null);
        }}
        group={renameTarget}
        profiles={profiles}
        rolesByUser={rolesByUser}
        onSwitchToMerge={(targetKey) => {
          setMergeSource(renameTarget);
          setMergePreset(targetKey);
          setRenameTarget(null);
        }}
      />
      <MergeCanvasserDialog
        open={!!mergeSource}
        onOpenChange={(o) => {
          if (!o) setMergeSource(null);
        }}
        source={mergeSource}
        profiles={profiles}
        rolesByUser={rolesByUser}
        presetTargetKey={mergePreset}
      />
    </div>
  );
}
