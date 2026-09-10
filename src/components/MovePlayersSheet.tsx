import { useEffect, useMemo, useState } from "react";
import { Check } from "lucide-react";
import {
  Sheet,
  SheetContent,
  SheetDescription,
  SheetFooter,
  SheetHeader,
  SheetTitle,
} from "@/components/ui/sheet";
import { Input } from "@/components/ui/input";
import { Button } from "@/components/ui/button";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { useAuth } from "@/hooks/useAuth";
import { useDispatchRoster, useDispatchVans, type Van } from "@/hooks/useFleetRoster";
import { useMoveAgents } from "@/hooks/useRosterActions";
import { canManageTarget } from "@/lib/role-policy";
import { normalizeName } from "@/lib/utils";
import { isLeadSourceKey } from "@/lib/lead-sources";
import { DEFAULT_OFFICE, OFFICE_LOCATIONS } from "@/lib/offices";

/**
 * The one go-to mover: search the whole roster, tap to select several
 * players, pick a destination once — one bulk update, one toast. Reached
 * from the dispatch board header, Manage Fleet, and Manage Players; the
 * per-row Move menus stay as the single-player power path.
 *
 * Selection unit is the NAME GROUP: all of a person's non-archived
 * duplicate profiles move together (`is_active !== false` — the union of
 * the board's `activeIds` and Manage Fleet's legacy null-is-active
 * semantics), so a move can never strand a same-name duplicate on the old
 * van. Archived profiles are untouchable here — reactivation lives in
 * Manage Fleet → Archived Agents.
 */

type OfficeChip = "All" | (typeof OFFICE_LOCATIONS)[number];

type MoveGroup = {
  key: string;
  display_name: string | null;
  /** Every non-archived same-name profile id — moved as one unit. */
  movableIds: string[];
  vanId: string | null;
  office: string;
  isCaptain: boolean;
  canMove: boolean;
};

export function MovePlayersSheet({
  open,
  onOpenChange,
}: {
  open: boolean;
  onOpenChange: (o: boolean) => void;
}) {
  const { realRole } = useAuth();
  const roster = useDispatchRoster({ enabled: open });
  const { data: vans = [] } = useDispatchVans({ enabled: open });
  const moveAgents = useMoveAgents(vans);

  const [search, setSearch] = useState("");
  const [officeChip, setOfficeChip] = useState<OfficeChip>("All");
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [destId, setDestId] = useState<string | null>(null);

  useEffect(() => {
    if (!open) {
      setSearch("");
      setOfficeChip("All");
      setSelected(new Set());
      setDestId(null);
    }
  }, [open]);

  const vanById = useMemo(() => new Map(vans.map((v) => [v.id, v])), [vans]);

  // Vans in office order (SD, then OC), name-ordered within (query sorts by
  // name already).
  const orderedVans = useMemo(() => {
    const buckets = new Map<string, Van[]>();
    for (const loc of OFFICE_LOCATIONS) buckets.set(loc, []);
    for (const v of vans) {
      const loc = v.office_location || DEFAULT_OFFICE;
      if (!buckets.has(loc)) buckets.set(loc, []);
      buckets.get(loc)!.push(v);
    }
    return Array.from(buckets.values()).flat();
  }, [vans]);

  const groups = useMemo<MoveGroup[]>(() => {
    const profiles = roster.data?.profiles ?? [];
    const rolesByUser = roster.data?.rolesByUser ?? new Map<string, string[]>();
    const byKey = new Map<string, typeof profiles>();
    for (const p of profiles) {
      const key = normalizeName(p.display_name) || `id:${p.id}`;
      const arr = byKey.get(key);
      if (arr) arr.push(p);
      else byKey.set(key, [p]);
    }
    const out: MoveGroup[] = [];
    for (const [key, members] of byKey) {
      // Pseudo lead-source channels never ride vans.
      if (isLeadSourceKey(key)) continue;
      const movable = members.filter((m) => m.is_active !== false);
      // Archived-only names live in Manage Fleet → Archived Agents.
      if (movable.length === 0) continue;
      const roles = new Set<string>();
      for (const m of movable) for (const r of rolesByUser.get(m.id) ?? []) roles.add(r);
      // Van inherited from active members preferentially, like the board.
      const vanRep =
        movable.find((m) => m.is_active === true && m.team_id) ??
        movable.find((m) => m.team_id) ??
        movable[0];
      const vanId = vanRep.team_id;
      // Free Agents pen rule: unassigned owners/sales reps never need a van;
      // anyone already ON a van stays listed so they can be moved off.
      if (!vanId && (roles.has("owner") || roles.has("sales_rep"))) continue;
      const van = vanId ? vanById.get(vanId) : null;
      out.push({
        key,
        display_name: vanRep.display_name,
        movableIds: movable.map((m) => m.id),
        vanId,
        office: van?.office_location ?? vanRep.office_location ?? DEFAULT_OFFICE,
        isCaptain: roles.has("captain"),
        canMove: canManageTarget(realRole, Array.from(roles)),
      });
    }
    return out;
  }, [roster.data, vanById, realRole]);

  // Data refetches can dissolve a selected group (merge, archive elsewhere) —
  // keep the count honest.
  useEffect(() => {
    setSelected((prev) => {
      const valid = new Set(groups.filter((g) => g.canMove).map((g) => g.key));
      const next = new Set(Array.from(prev).filter((k) => valid.has(k)));
      return next.size === prev.size ? prev : next;
    });
  }, [groups]);

  const q = normalizeName(search);
  const visible = groups.filter((g) => !q || g.key.includes(q));
  const byName = (a: MoveGroup, b: MoveGroup) =>
    (a.display_name ?? "").localeCompare(b.display_name ?? "");
  const freeAgents = visible
    .filter((g) => !g.vanId && (officeChip === "All" || g.office === officeChip))
    .sort(byName);
  const vanSections = orderedVans
    .filter((v) => {
      if (officeChip === "All") return true;
      // The Confirmation van confirms for both offices — show it on either.
      const crossOffice = v.name.trim().toLowerCase() === "confirmation";
      return crossOffice || (v.office_location ?? DEFAULT_OFFICE) === officeChip;
    })
    .map((v) => ({ van: v, members: visible.filter((g) => g.vanId === v.id).sort(byName) }));
  const nothingVisible =
    freeAgents.length === 0 && vanSections.every((s) => s.members.length === 0);

  const toggle = (key: string) =>
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });

  const doMove = () => {
    if (!destId) return;
    // Resolve ids from the LIVE groups at click time, never from stored state.
    const chosen = groups.filter((g) => selected.has(g.key) && g.canMove);
    if (chosen.length === 0) return;
    moveAgents.mutate(
      {
        ids: chosen.flatMap((g) => g.movableIds),
        vanId: destId === "free" ? null : destId,
        name: chosen.length === 1 ? (chosen[0].display_name ?? "Agent") : undefined,
        count: chosen.length,
      },
      {
        // Sheet stays open for the next batch.
        onSuccess: () => {
          setSelected(new Set());
          setDestId(null);
        },
      },
    );
  };

  return (
    <Sheet open={open} onOpenChange={onOpenChange}>
      <SheetContent className="h-[85dvh]">
        <SheetHeader className="pr-10">
          <SheetTitle className="font-display uppercase tracking-widest text-neon text-base">
            Move Players
          </SheetTitle>
          <SheetDescription className="text-xs">
            Tap players to select, then pick a destination. Players on Monday cards follow the
            card&apos;s Van column — a move here can be overridden by the next card that names a
            different van.
          </SheetDescription>
        </SheetHeader>

        <div className="px-4 pt-2 pb-1 space-y-2 shrink-0">
          <Input
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            placeholder="Search players…"
            aria-label="Search players"
          />
          <div className="flex items-center gap-1.5 overflow-x-auto scrollbar-hide">
            {(["All", ...OFFICE_LOCATIONS] as OfficeChip[]).map((o) => (
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
          </div>
        </div>

        <div
          data-tour="move-players-sheet"
          className="flex-1 min-h-0 overflow-y-auto px-4 py-2 space-y-4"
        >
          {roster.isLoading ? (
            <div className="text-sm text-muted-foreground italic py-8 text-center">
              Loading roster…
            </div>
          ) : nothingVisible ? (
            <div className="text-sm text-muted-foreground italic py-8 text-center">
              No players match.
            </div>
          ) : (
            <>
              {freeAgents.length > 0 && (
                <section className="space-y-1.5">
                  <h3
                    className="text-[10px] font-display uppercase tracking-widest flex items-center gap-2"
                    style={{ color: "var(--neon-orange)" }}
                  >
                    ⚠ Free Agents · Needs Van
                    <span className="text-muted-foreground">{freeAgents.length}</span>
                  </h3>
                  {freeAgents.map((g) => (
                    <GroupRow
                      key={g.key}
                      g={g}
                      van={null}
                      isSelected={selected.has(g.key)}
                      onToggle={toggle}
                    />
                  ))}
                </section>
              )}
              {vanSections.map(
                ({ van, members }) =>
                  members.length > 0 && (
                    <section key={van.id} className="space-y-1.5">
                      <h3 className="text-[10px] font-display uppercase tracking-widest text-muted-foreground flex items-center gap-2 min-w-0">
                        <span
                          className="w-2 h-2 rounded-full shrink-0"
                          style={{ background: van.color ?? "#888" }}
                        />
                        <span className="truncate text-foreground">{van.name}</span>
                        <span>{members.length}</span>
                        <span className="ml-auto shrink-0">
                          {van.office_location ?? DEFAULT_OFFICE}
                        </span>
                      </h3>
                      {members.map((g) => (
                        <GroupRow
                          key={g.key}
                          g={g}
                          van={van}
                          isSelected={selected.has(g.key)}
                          onToggle={toggle}
                        />
                      ))}
                    </section>
                  ),
              )}
            </>
          )}
        </div>

        {selected.size > 0 && (
          <SheetFooter data-tour="move-players-action" className="border-t border-border">
            <div className="flex items-center gap-2">
              <span className="text-[11px] font-display uppercase tracking-widest text-neon shrink-0">
                {selected.size} selected
              </span>
              <Button
                variant="ghost"
                size="sm"
                className="shrink-0 h-11 md:h-9 text-xs"
                onClick={() => setSelected(new Set())}
              >
                Clear
              </Button>
              <Select value={destId ?? undefined} onValueChange={(v) => setDestId(v)}>
                <SelectTrigger className="flex-1 min-w-0 h-11 text-xs font-display uppercase tracking-wider bg-background border-[color:var(--neon-blue)]/50 hover:border-[color:var(--neon-blue)]">
                  <SelectValue placeholder="Move to…" />
                </SelectTrigger>
                {/* z-[10000]: the sheet is z-[9999]; a stock z-50 menu would
                    render invisibly behind it. */}
                <SelectContent className="z-[10000] bg-background border-[color:var(--neon-blue)]/50">
                  <SelectItem value="free">Free Agents</SelectItem>
                  {orderedVans.map((v) => (
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
              <Button
                disabled={!destId || moveAgents.isPending}
                onClick={doMove}
                className="shrink-0 h-11 md:h-10 bg-neon text-background hover:bg-neon/90 font-display uppercase tracking-widest text-xs"
              >
                {moveAgents.isPending ? "Moving…" : "Move"}
              </Button>
            </div>
          </SheetFooter>
        )}
      </SheetContent>
    </Sheet>
  );
}

function GroupRow({
  g,
  van,
  isSelected,
  onToggle,
}: {
  g: MoveGroup;
  van: Van | null;
  isSelected: boolean;
  onToggle: (key: string) => void;
}) {
  return (
    <button
      type="button"
      role="checkbox"
      aria-checked={isSelected}
      disabled={!g.canMove}
      onClick={() => onToggle(g.key)}
      title={g.canMove ? undefined : "Only Owners can move Owner or Admin accounts"}
      className={`w-full min-h-11 flex items-center gap-3 px-3 py-1.5 rounded border text-left transition-colors ${
        isSelected ? "border-neon bg-neon/10" : "border-border bg-surface hover:border-neon/60"
      } disabled:opacity-50 disabled:cursor-not-allowed`}
    >
      <span
        aria-hidden
        className={`shrink-0 w-5 h-5 rounded border flex items-center justify-center ${
          isSelected ? "border-neon bg-neon text-background" : "border-muted-foreground/50"
        }`}
      >
        {isSelected && <Check className="w-3.5 h-3.5" />}
      </span>
      <span className="text-sm truncate min-w-0 flex-1 flex items-center gap-2">
        <span className="truncate">{g.display_name ?? "Unknown"}</span>
        {g.isCaptain && (
          <span className="shrink-0 text-[9px] font-display uppercase tracking-widest px-1.5 py-0.5 rounded border border-accent/60 text-accent bg-accent/10">
            Captain
          </span>
        )}
      </span>
      <span className="shrink-0 flex items-center gap-1.5 text-[10px] font-display uppercase tracking-wider text-muted-foreground">
        <span className="w-2 h-2 rounded-full" style={{ background: van?.color ?? "#888" }} />
        {van?.name ?? "Free Agent"}
      </span>
    </button>
  );
}
