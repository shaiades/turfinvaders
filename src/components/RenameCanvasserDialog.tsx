import { useEffect, useMemo, useState } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Pencil, TriangleAlert } from "lucide-react";
import { normalizeName } from "@/lib/utils";
import { isLeadSourceKey } from "@/lib/lead-sources";
import { canManageTarget } from "@/lib/role-policy";
import { useAuth } from "@/hooks/useAuth";
import { useRenameCanvasser } from "@/hooks/useRosterActions";
import type { RosterProfile } from "@/components/FleetDispatch";

/** A board row's identity: the normalized-name group key + the shown name.
 *  Dialogs hold only this and re-derive the member ids from live profiles on
 *  every render, so a realtime refetch mid-dialog can't act on stale ids. */
export type NameGroupRef = { key: string; display_name: string | null };

/** Rename every profile sharing this row's name. Ids are re-resolved from
 *  the FULL roster by normalized name — not the office-filtered board group —
 *  so a cross-office twin can't be left behind under the old name. */
export function RenameCanvasserDialog({
  open,
  onOpenChange,
  group,
  profiles,
  rolesByUser,
  onSwitchToMerge,
}: {
  open: boolean;
  onOpenChange: (o: boolean) => void;
  group: NameGroupRef | null;
  profiles: RosterProfile[];
  rolesByUser: Map<string, string[]>;
  onSwitchToMerge: (targetKey: string) => void;
}) {
  const { realRole } = useAuth();
  const rename = useRenameCanvasser();
  const [name, setName] = useState("");

  // Re-seed each time the dialog opens.
  useEffect(() => {
    if (open) setName(group?.display_name ?? "");
  }, [open, group]);

  const ids = useMemo(
    () =>
      group
        ? profiles
            .filter((p) => p.is_active !== false && normalizeName(p.display_name) === group.key)
            .map((p) => p.id)
        : [],
    [profiles, group],
  );

  // The row's gate checked the board group, but the rename targets EVERY
  // active same-named profile — a same-named Admin twin widens the set past
  // what a captain may touch (the RPC would refuse; block up front instead).
  const adminLocked =
    !canManageTarget(
      realRole,
      ids.flatMap((id) => rolesByUser.get(id) ?? []),
    ) && ids.length > 0;

  const trimmed = name.trim();
  const norm = normalizeName(name);
  const reserved = norm !== "" && isLeadSourceKey(norm);
  const unchanged = trimmed === (group?.display_name ?? "");
  // A pure case/spacing fix keeps the same normalized key and never collides.
  // Reserved lead-source names get their own banner — never a Combine offer.
  const collision = useMemo(() => {
    if (!group || norm === "" || norm === group.key || isLeadSourceKey(norm)) return null;
    return (
      profiles.find((p) => p.is_active !== false && normalizeName(p.display_name) === norm) ?? null
    );
  }, [profiles, group, norm]);

  const canSubmit =
    !!group &&
    ids.length > 0 &&
    norm !== "" &&
    !reserved &&
    !unchanged &&
    !collision &&
    !adminLocked &&
    !rename.isPending;

  const submit = () => {
    if (!canSubmit || !group) return;
    rename.mutate(
      { ids, newName: trimmed, oldName: group.display_name },
      { onSuccess: () => onOpenChange(false) },
    );
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle className="font-display uppercase tracking-widest">
            Rename Player
          </DialogTitle>
          <DialogDescription>
            Renames {ids.length > 1 ? `all ${ids.length} profiles named` : "the profile named"} “
            {group?.display_name ?? "—"}”. History follows the player, and Monday cards still using
            the old name keep crediting them.
          </DialogDescription>
        </DialogHeader>
        <div className="space-y-3 py-2">
          <div>
            <Label
              htmlFor="rename-canvasser-name"
              className="text-[10px] font-display uppercase tracking-widest text-muted-foreground"
            >
              New Name
            </Label>
            <Input
              id="rename-canvasser-name"
              autoFocus
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder="e.g. Jonathan Hanna"
              onKeyDown={(e) => {
                if (e.key === "Enter") submit();
              }}
            />
          </div>
          {reserved && (
            <div className="flex items-center gap-2 rounded border border-destructive/50 bg-destructive/10 px-3 py-2 text-xs text-destructive">
              <TriangleAlert className="w-4 h-4 shrink-0" />
              That name is reserved for a lead-source channel.
            </div>
          )}
          {adminLocked && (
            <div className="flex items-center gap-2 rounded border border-yellow-500/50 bg-yellow-500/10 px-3 py-2 text-xs text-yellow-500">
              <TriangleAlert className="w-4 h-4 shrink-0" />
              An Admin account also carries this name — only an Owner can rename it.
            </div>
          )}
          {collision && (
            <div className="rounded border border-yellow-500/50 bg-yellow-500/10 px-3 py-2 text-xs text-yellow-500">
              <div className="flex items-center gap-2">
                <TriangleAlert className="w-4 h-4 shrink-0" />
                <span>
                  A player named “{collision.display_name}” already exists. Renaming won’t combine
                  their histories — use Combine instead.
                </span>
              </div>
              <Button
                size="sm"
                variant="outline"
                className="mt-2 border-yellow-500/50 text-yellow-500 hover:bg-yellow-500/10"
                onClick={() => onSwitchToMerge(norm)}
              >
                Combine instead
              </Button>
            </div>
          )}
        </div>
        <DialogFooter>
          <Button variant="ghost" onClick={() => onOpenChange(false)}>
            Cancel
          </Button>
          <Button
            onClick={submit}
            disabled={!canSubmit}
            className="bg-neon text-background hover:bg-neon/90"
          >
            <Pencil className="w-4 h-4 mr-1" /> Rename
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
