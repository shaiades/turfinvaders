import { useEffect, useMemo, useState } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Check, Merge, TriangleAlert } from "lucide-react";
import { normalizeName } from "@/lib/utils";
import { isLeadSourceKey } from "@/lib/lead-sources";
import { canManageTarget } from "@/lib/role-policy";
import { useAuth } from "@/hooks/useAuth";
import { useMergeCanvassers } from "@/hooks/useRosterActions";
import type { RosterProfile } from "@/components/FleetDispatch";
import type { NameGroupRef } from "@/components/RenameCanvasserDialog";

type CandidateGroup = {
  key: string;
  display_name: string | null;
  profiles: RosterProfile[];
  roles: string[];
};

/** The keeper is the profile most likely to be auth-backed across BOTH
 *  same-name groups — real (non-placeholder) rows first, preferring the
 *  surviving-name side. Which name survives is independent (_keep_name in
 *  the RPC), so a captain combining their own row with a webhook placeholder
 *  keeps their login, roles, and hours no matter which name they keep; the
 *  RPC refuses outright if a login account would be absorbed into a
 *  placeholder. */
const pickKeeperId = (surviving: CandidateGroup, other: CandidateGroup) => {
  const ordered = [...surviving.profiles, ...other.profiles];
  return (ordered.find((p) => p.is_placeholder === false) ?? ordered[0]).id;
};

/** Combine this row with another player: pick who, pick which name survives,
 *  confirm. The chosen loser group's profiles (plus any extra duplicates of
 *  the surviving name) are absorbed into one keeper profile via the
 *  merge_canvassers RPC — history moves, counters sum, the old name becomes
 *  an alias so Monday keeps crediting the keeper. Irreversible. */
export function MergeCanvasserDialog({
  open,
  onOpenChange,
  source,
  profiles,
  rolesByUser,
  presetTargetKey,
}: {
  open: boolean;
  onOpenChange: (o: boolean) => void;
  source: NameGroupRef | null;
  profiles: RosterProfile[];
  rolesByUser: Map<string, string[]>;
  presetTargetKey?: string | null;
}) {
  const { realRole } = useAuth();
  const merge = useMergeCanvassers();
  const [query, setQuery] = useState("");
  const [targetKey, setTargetKey] = useState<string | null>(null);
  const [keepName, setKeepName] = useState<"source" | "target">("target");

  // Re-seed each time the dialog opens (presetTargetKey arrives from the
  // rename dialog's "Combine instead" handoff).
  useEffect(() => {
    if (open) {
      setQuery("");
      setTargetKey(presetTargetKey ?? null);
      setKeepName("target");
    }
  }, [open, presetTargetKey]);

  // Groups are rebuilt from the FULL roster (not the office-filtered board
  // rows) so cross-office twins are always offered and absorbed. No role
  // filter: a duplicate can be a sales rep, an Admin, or a role-less webhook
  // placeholder, and the rename-collision handoff must always find its
  // target here — per-target permission is the manageable flag below, and
  // the RPC re-checks server-side.
  const groups = useMemo(() => {
    const m = new Map<string, CandidateGroup>();
    for (const p of profiles) {
      if (p.is_active === false) continue;
      const key = normalizeName(p.display_name) || `id:${p.id}`;
      const g = m.get(key) ?? {
        key,
        display_name: p.display_name,
        profiles: [],
        roles: [],
      };
      g.profiles.push(p);
      g.roles.push(...(rolesByUser.get(p.id) ?? []));
      m.set(key, g);
    }
    return m;
  }, [profiles, rolesByUser]);

  const sourceGroup = source ? (groups.get(source.key) ?? null) : null;
  const target = targetKey ? (groups.get(targetKey) ?? null) : null;

  const candidates = useMemo(() => {
    if (!source) return [];
    const firstToken = source.key.split(" ")[0] ?? "";
    const q = query.trim().toLowerCase();
    return [...groups.values()]
      .filter((g) => g.key !== source.key && !isLeadSourceKey(g.key))
      .filter((g) => !q || (g.display_name ?? "").toLowerCase().includes(q))
      .map((g) => ({
        ...g,
        manageable: canManageTarget(realRole, g.roles),
        sameFirst: firstToken !== "" && g.key.split(" ")[0] === firstToken,
      }))
      .sort(
        (a, b) =>
          Number(b.sameFirst) - Number(a.sameFirst) ||
          (a.display_name ?? "").localeCompare(b.display_name ?? ""),
      );
  }, [groups, source, query, realRole]);

  // "Which name stays" is presentation only — the data keeper is picked by
  // pickKeeperId across both groups.
  const survivingGroup = keepName === "target" ? target : sourceGroup;
  const retiredGroup = keepName === "target" ? sourceGroup : target;
  // Both sides get modified, so both must pass the per-target gate (the
  // candidate list disables unmanageable rows, but the preset handoff from
  // the rename dialog can select one — re-check here; the RPC enforces
  // server-side regardless).
  const bothManageable =
    !!sourceGroup &&
    !!target &&
    canManageTarget(realRole, sourceGroup.roles) &&
    canManageTarget(realRole, target.roles);
  const canSubmit =
    !!sourceGroup &&
    !!target &&
    !!survivingGroup &&
    !!retiredGroup &&
    bothManageable &&
    !merge.isPending;

  const submit = () => {
    if (!canSubmit || !survivingGroup || !retiredGroup) return;
    const keeperId = pickKeeperId(survivingGroup, retiredGroup);
    const loserIds = [
      ...survivingGroup.profiles.map((p) => p.id),
      ...retiredGroup.profiles.map((p) => p.id),
    ].filter((id) => id !== keeperId);
    merge.mutate(
      {
        keeperId,
        loserIds,
        keepName: survivingGroup.display_name,
        keeperName: survivingGroup.display_name ?? "player",
        loserName: retiredGroup.display_name ?? "player",
      },
      { onSuccess: () => onOpenChange(false) },
    );
  };

  const initial = (s: string | null) => (s ?? "?").trim().charAt(0).toUpperCase() || "?";

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-h-[90dvh] overflow-y-auto">
        <DialogHeader>
          <DialogTitle className="font-display uppercase tracking-widest">
            Combine Players
          </DialogTitle>
          <DialogDescription>
            “{source?.display_name ?? "—"}” is the same person as… pick their other row. Everything
            both rows earned ends up on one player.
          </DialogDescription>
        </DialogHeader>
        <div className="space-y-3 py-2">
          <Input
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="Search players"
            aria-label="Search players"
          />
          {candidates.length === 0 ? (
            <p className="text-sm italic text-muted-foreground px-1">
              No one else to combine with.
            </p>
          ) : (
            <ul className="rounded-lg border border-border divide-y divide-border max-h-56 overflow-y-auto">
              {candidates.map((g) => (
                <li key={g.key}>
                  <button
                    type="button"
                    disabled={!g.manageable}
                    title={g.manageable ? undefined : "Only Owners can combine Admin accounts"}
                    onClick={() => setTargetKey(g.key)}
                    className="flex w-full items-center gap-3 p-3 text-left min-w-0 disabled:opacity-50 disabled:cursor-not-allowed hover:bg-muted/40"
                  >
                    <span className="flex h-9 w-9 shrink-0 items-center justify-center rounded-full border border-border text-sm font-bold text-muted-foreground">
                      {initial(g.display_name)}
                    </span>
                    <span className="flex-1 min-w-0">
                      <span className="block text-sm font-medium truncate">
                        {g.display_name ?? "—"}
                      </span>
                      <span className="block text-[10px] uppercase tracking-widest text-muted-foreground truncate">
                        {g.profiles[0]?.office_location ?? "No office"}
                        {g.profiles.length > 1 ? ` · ${g.profiles.length} profiles` : ""}
                        {g.profiles.every((p) => p.is_placeholder !== false) ? " · no login" : ""}
                      </span>
                    </span>
                    {targetKey === g.key && <Check className="w-4 h-4 text-neon shrink-0" />}
                  </button>
                </li>
              ))}
            </ul>
          )}

          {target && sourceGroup && (
            <>
              <div className="space-y-1.5">
                <div className="text-[10px] font-display uppercase tracking-widest text-muted-foreground">
                  Which name stays?
                </div>
                <div className="flex flex-wrap gap-2">
                  <Button
                    size="sm"
                    variant={keepName === "target" ? "default" : "outline"}
                    className={
                      keepName === "target" ? "bg-neon text-background hover:bg-neon/90" : ""
                    }
                    onClick={() => setKeepName("target")}
                  >
                    Keep “{target.display_name}”
                  </Button>
                  <Button
                    size="sm"
                    variant={keepName === "source" ? "default" : "outline"}
                    className={
                      keepName === "source" ? "bg-neon text-background hover:bg-neon/90" : ""
                    }
                    onClick={() => setKeepName("source")}
                  >
                    Keep “{sourceGroup.display_name}”
                  </Button>
                </div>
              </div>
              {!bothManageable && (
                <div className="flex items-center gap-2 rounded border border-yellow-500/50 bg-yellow-500/10 px-3 py-2 text-xs text-yellow-500">
                  <TriangleAlert className="w-4 h-4 shrink-0" />
                  Only Owners can combine Admin accounts.
                </div>
              )}
              <div className="flex items-start gap-2 rounded border border-destructive/50 bg-destructive/10 px-3 py-2 text-xs text-destructive">
                <TriangleAlert className="w-4 h-4 shrink-0 mt-0.5" />
                <span>
                  This permanently combines all leads, results, points, and volume of “
                  {retiredGroup?.display_name}” into “{survivingGroup?.display_name}” and removes
                  the extra row. Future Monday cards under either name will credit “
                  {survivingGroup?.display_name}”. This cannot be undone.
                </span>
              </div>
            </>
          )}
        </div>
        <DialogFooter>
          <Button variant="ghost" onClick={() => onOpenChange(false)}>
            Cancel
          </Button>
          <Button variant="destructive" onClick={submit} disabled={!canSubmit}>
            <Merge className="w-4 h-4 mr-1" />
            {merge.isPending
              ? "Combining…"
              : survivingGroup
                ? `Combine into “${survivingGroup.display_name}”`
                : "Combine"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
