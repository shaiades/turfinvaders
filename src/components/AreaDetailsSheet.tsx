// Area Details bottom sheet — the SalesRabbit-style assign/reassign flow.
// Opens right after a polygon is drawn (create) or when a manager taps an
// existing turf (edit): provenance line, searchable user list with
// "{office} | {van}" subtitles, a pinned "Set as unassigned" row, a
// repeat-assignment warning, and Delete behind a confirm dialog.

import { useEffect, useMemo, useState } from "react";
import { Trash2, Check, TriangleAlert } from "lucide-react";
import {
  Sheet, SheetContent, SheetHeader, SheetTitle, SheetDescription, SheetFooter,
} from "@/components/ui/sheet";
import {
  Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription,
  DialogFooter, DialogOverlay, DialogPortal,
} from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { assigneeColor, initials, UNASSIGNED_COLOR } from "@/lib/assignee-colors";
import { laDateTimeLabel } from "@/lib/dates";

export type AssignableUser = {
  id: string;
  display_name: string;
  role: string;
  office_location: string | null;
  team_name: string | null;
};

export type AreaDetailsTurf = {
  id: string;
  name: string;
  assigned_user_id: string | null;
  assigned_at: string | null;
  assignee_name: string | null;
  assigner_name: string | null;
};

export type LastWorked = { userId: string; name: string; at: string };

function subtitle(u: AssignableUser): string {
  return `${u.office_location ?? "No Office"} | ${u.team_name ?? "No Van"}`;
}

/** "Delete area?" confirm — also reused by the Assigned Turfs list. */
export function DeleteAreaConfirmDialog({
  open, onOpenChange, areaName, deleting, onConfirm,
}: {
  open: boolean;
  onOpenChange: (v: boolean) => void;
  areaName: string;
  deleting: boolean;
  onConfirm: () => void;
}) {
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogPortal>
        <DialogOverlay className="fixed inset-0 z-[10000] bg-black/50" />
        <DialogContent className="z-[10001] max-w-sm">
          <DialogHeader>
            <DialogTitle className="font-display text-destructive">Delete area?</DialogTitle>
            <DialogDescription>
              This will permanently remove “{areaName}”. Once done, this action cannot be undone.
            </DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button variant="outline" onClick={() => onOpenChange(false)}>Cancel</Button>
            <Button variant="destructive" disabled={deleting} onClick={onConfirm}>
              <Trash2 className="w-4 h-4 mr-1" />
              {deleting ? "Deleting…" : "Delete"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </DialogPortal>
    </Dialog>
  );
}

export function AreaDetailsSheet({
  open, onOpenChange, mode, turf, vertexCount, users, lastWorked,
  saving, deleting, onSave, onDelete,
}: {
  open: boolean;
  onOpenChange: (v: boolean) => void;
  mode: "create" | "edit";
  turf: AreaDetailsTurf | null;
  vertexCount: number;
  users: AssignableUser[];
  lastWorked: LastWorked | null;
  saving: boolean;
  deleting: boolean;
  onSave: (assigneeId: string | null, name: string) => void;
  onDelete: () => void;
}) {
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [touched, setTouched] = useState(false);
  const [query, setQuery] = useState("");
  const [name, setName] = useState("");
  const [confirmingDelete, setConfirmingDelete] = useState(false);
  // Latched copy of what the sheet displays: while the close animation plays,
  // the parent clears editingTurfId and the live props flip edit→create —
  // rendering from `view` keeps the closing sheet from visibly morphing.
  const [view, setView] = useState<{
    mode: "create" | "edit";
    turf: AreaDetailsTurf | null;
    vertexCount: number;
  }>({ mode, turf, vertexCount });

  useEffect(() => {
    if (open) {
      setView({ mode, turf, vertexCount });
      setSelectedId(turf?.assigned_user_id ?? null);
      setName(turf?.name ?? "");
      setTouched(false);
      setQuery("");
      setConfirmingDelete(false);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, mode, vertexCount, turf?.id, turf?.assigned_user_id, turf?.assigned_at, turf?.name]);

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) return users;
    return users.filter(
      (u) =>
        u.display_name.toLowerCase().includes(q) ||
        (u.office_location ?? "").toLowerCase().includes(q) ||
        (u.team_name ?? "").toLowerCase().includes(q),
    );
  }, [users, query]);

  const isEdit = view.mode === "edit";
  const shownTurf = view.turf;
  const dirty = isEdit
    ? selectedId !== (shownTurf?.assigned_user_id ?? null) || name.trim() !== (shownTurf?.name ?? "")
    : touched || name.trim() !== "";
  const repeatWarning =
    selectedId != null &&
    lastWorked != null &&
    selectedId === lastWorked.userId &&
    selectedId !== (shownTurf?.assigned_user_id ?? null);

  const pick = (id: string | null) => {
    setSelectedId(id);
    setTouched(true);
  };

  const handleSave = () => {
    const finalName = name.trim() || `Area ${laDateTimeLabel(new Date())}`;
    onSave(selectedId, finalName);
  };

  return (
    <>
      <Sheet open={open} onOpenChange={onOpenChange}>
        <SheetContent aria-describedby={undefined}>
          <SheetHeader>
            <div className="flex items-start justify-between gap-3 pr-8">
              <SheetTitle className="font-display text-neon text-base">AREA DETAILS</SheetTitle>
              {isEdit && (
                <button
                  type="button"
                  onClick={() => setConfirmingDelete(true)}
                  className="flex items-center gap-1 text-destructive text-sm font-medium shrink-0"
                >
                  <Trash2 className="w-4 h-4" /> Delete
                </button>
              )}
            </div>
            {isEdit && shownTurf?.assigned_user_id ? (
              <SheetDescription>
                {shownTurf.assigner_name ?? "A manager"} assigned this area to{" "}
                {shownTurf.assignee_name ?? "a rep"}
                {shownTurf.assigned_at ? ` ${laDateTimeLabel(shownTurf.assigned_at)}` : ""}
              </SheetDescription>
            ) : (
              <SheetDescription>
                {isEdit
                  ? "This area is unassigned."
                  : `${view.vertexCount} points drawn — assign this area.`}
              </SheetDescription>
            )}
            {lastWorked && (!isEdit || !shownTurf?.assigned_user_id) && (
              <div className="text-[10px] uppercase tracking-widest text-muted-foreground">
                Last worked by {lastWorked.name} · {laDateTimeLabel(lastWorked.at)}
              </div>
            )}
          </SheetHeader>

          <div className="space-y-3 overflow-y-auto px-4 pt-3">
            <Input
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder="Area name (optional)"
              aria-label="Area name"
            />

            <div className="space-y-2">
              <div className="text-sm font-medium">Assign area to?</div>
              <Input
                value={query}
                onChange={(e) => setQuery(e.target.value)}
                placeholder="Search users"
                aria-label="Search users"
              />
            </div>

            {repeatWarning && (
              <div className="flex items-center gap-2 rounded border border-yellow-500/50 bg-yellow-500/10 px-3 py-2 text-xs text-yellow-500">
                <TriangleAlert className="w-4 h-4 shrink-0" />
                {lastWorked!.name} worked this area last time
              </div>
            )}

            <ul className="rounded-lg border border-border divide-y divide-border">
              <li>
                <button
                  type="button"
                  onClick={() => pick(null)}
                  className="flex w-full items-center gap-3 p-3 text-left min-w-0"
                >
                  <span
                    className="flex h-10 w-10 shrink-0 items-center justify-center rounded-full border-2 border-dashed text-sm font-bold"
                    style={{ borderColor: UNASSIGNED_COLOR, color: UNASSIGNED_COLOR }}
                  >
                    ?
                  </span>
                  <span className="flex-1 text-sm font-medium">Set as unassigned</span>
                  {selectedId === null && touched && <Check className="w-4 h-4 text-neon shrink-0" />}
                </button>
              </li>
              {filtered.map((u) => {
                const selected = selectedId === u.id;
                const color = assigneeColor(u.id);
                return (
                  <li key={u.id}>
                    <button
                      type="button"
                      onClick={() => pick(u.id)}
                      className="flex w-full items-center gap-3 p-3 text-left min-w-0"
                    >
                      <span
                        className="flex h-10 w-10 shrink-0 items-center justify-center rounded-full text-sm font-bold text-black"
                        style={{
                          background: color,
                          boxShadow: selected ? `0 0 10px ${color}` : "none",
                        }}
                      >
                        {initials(u.display_name)}
                      </span>
                      <span className="min-w-0 flex-1">
                        <span className={`block truncate text-sm font-medium ${selected ? "text-neon" : ""}`}>
                          {u.display_name}
                        </span>
                        <span className="block truncate text-[10px] uppercase tracking-widest text-muted-foreground">
                          {subtitle(u)}
                        </span>
                      </span>
                      {selected && <Check className="w-4 h-4 text-neon shrink-0" />}
                    </button>
                  </li>
                );
              })}
              {filtered.length === 0 && query.trim() !== "" && (
                <li className="p-3 text-xs text-muted-foreground">No users match “{query}”.</li>
              )}
            </ul>
          </div>

          <SheetFooter>
            <Button
              onClick={handleSave}
              disabled={saving || !dirty}
              className="w-full font-display uppercase tracking-widest"
            >
              {saving ? "Saving…" : "Save"}
            </Button>
          </SheetFooter>
        </SheetContent>
      </Sheet>

      <DeleteAreaConfirmDialog
        open={open && confirmingDelete}
        onOpenChange={setConfirmingDelete}
        areaName={shownTurf?.name ?? "this area"}
        deleting={deleting}
        onConfirm={onDelete}
      />
    </>
  );
}
