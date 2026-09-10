import { useEffect, useMemo, useState } from "react";
import {
  Sheet,
  SheetContent,
  SheetDescription,
  SheetHeader,
  SheetTitle,
} from "@/components/ui/sheet";
import { Input } from "@/components/ui/input";
import { useAuth } from "@/hooks/useAuth";
import { useDispatchRoster, useDispatchVans } from "@/hooks/useFleetRoster";
import { InviteDialog } from "@/components/InviteDialog";
import { LIMITED_CREATABLE_ROLES, ROLE_LABEL, ROLE_TONE } from "@/lib/role-policy";
import { primaryRole } from "@/lib/roles";
import type { AppRole } from "@/hooks/useAuth";
import { normalizeName } from "@/lib/utils";
import { isLeadSourceKey } from "@/lib/lead-sources";
import { Send } from "lucide-react";

type PickRow = {
  id: string;
  name: string;
  role: AppRole;
  /** Every active same-name profile is a placeholder — Invite mints the login. */
  noLogin: boolean;
  where: string | null;
};

/** Roster picker behind the menu's "Invite a Player": search the roster, tap
 *  a person, and the InviteDialog opens on them (the sheet steps aside — the
 *  dialog sits at a lower z than the sheet, and sequencing also drops you
 *  back on the list afterwards for the next invite). One row per NAME GROUP
 *  (Move Players semantics, `is_active !== false`); within a group the
 *  auth-backed profile is preferred as the invite target so an existing
 *  login is never shadowed by a duplicate placeholder. The list mirrors the
 *  server's permission ladder: Admins don't see Owner/Admin accounts,
 *  Captains only canvasser-tier players. */
export function InvitePlayerSheet({
  open,
  onOpenChange,
}: {
  open: boolean;
  onOpenChange: (o: boolean) => void;
}) {
  const { role } = useAuth();
  const roster = useDispatchRoster({ enabled: open });
  const { data: vans = [] } = useDispatchVans({ enabled: open });
  const [search, setSearch] = useState("");
  const [target, setTarget] = useState<{ id: string; name: string; role: AppRole } | null>(null);

  useEffect(() => {
    if (!open) {
      setSearch("");
      setTarget(null);
    }
  }, [open]);

  const vanNameById = useMemo(() => new Map(vans.map((v) => [v.id, v.name])), [vans]);

  const rows = useMemo<PickRow[]>(() => {
    const profiles = roster.data?.profiles ?? [];
    const rolesByUser = roster.data?.rolesByUser ?? new Map<string, string[]>();
    const byKey = new Map<string, typeof profiles>();
    for (const p of profiles) {
      if (p.is_active === false) continue; // archived — reactivate in Manage Fleet first
      const key = normalizeName(p.display_name) || `id:${p.id}`;
      if (isLeadSourceKey(key)) continue; // channels aren't people
      const arr = byKey.get(key);
      if (arr) arr.push(p);
      else byKey.set(key, [p]);
    }
    const out: PickRow[] = [];
    for (const members of byKey.values()) {
      const roles = new Set<string>();
      for (const m of members) for (const r of rolesByUser.get(m.id) ?? []) roles.add(r);
      // Mirror assertInviteAllowed so nothing tappable can only error.
      if (role !== "owner" && (roles.has("owner") || roles.has("office_staff"))) continue;
      if (
        role === "captain" &&
        [...roles].some((r) => !LIMITED_CREATABLE_ROLES.includes(r as AppRole))
      ) {
        continue;
      }
      const rep =
        members.find((m) => m.is_placeholder !== true) ??
        members.find((m) => m.team_id) ??
        members[0];
      const where = rep.team_id
        ? (vanNameById.get(rep.team_id) ?? null)
        : (rep.team_office ?? rep.office_location);
      out.push({
        id: rep.id,
        name: rep.display_name ?? "Player",
        role: (primaryRole([...roles] as AppRole[]) ?? "canvasser") as AppRole,
        noLogin: members.every((m) => m.is_placeholder === true),
        where,
      });
    }
    return out.sort((a, b) => a.name.localeCompare(b.name));
  }, [roster.data, role, vanNameById]);

  const q = normalizeName(search);
  const filtered = q ? rows.filter((r) => normalizeName(r.name).includes(q)) : rows;

  return (
    <>
      <Sheet
        open={open && !target}
        onOpenChange={(o) => {
          if (!o && !target) onOpenChange(false);
        }}
      >
        <SheetContent>
          <SheetHeader>
            <SheetTitle className="font-display uppercase tracking-widest text-neon">
              Invite a Player
            </SheetTitle>
            <SheetDescription>
              Tap a player to generate their one-time sign-in link. Players without a login yet get
              one created on the spot — history attached.
            </SheetDescription>
          </SheetHeader>
          <div className="px-4 pt-3">
            <Input
              placeholder="Search the roster…"
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              autoFocus
            />
          </div>
          <div className="flex-1 overflow-y-auto px-4 py-3 space-y-1.5">
            {roster.isLoading ? (
              <div className="text-sm text-muted-foreground py-6">Loading roster…</div>
            ) : filtered.length === 0 ? (
              <div className="text-sm text-muted-foreground py-6">
                {q ? "No player matches that search." : "Nobody here you can invite."}
              </div>
            ) : (
              filtered.map((r) => (
                <button
                  key={r.id}
                  type="button"
                  onClick={() => setTarget({ id: r.id, name: r.name, role: r.role })}
                  className="w-full flex items-center gap-3 rounded-md border border-border bg-surface px-3 py-2.5 min-h-12 text-left hover:border-neon/60 transition-colors"
                >
                  <span className="flex-1 min-w-0">
                    <span className="block truncate text-sm font-medium">{r.name}</span>
                    {r.where && (
                      <span className="block truncate text-[11px] text-muted-foreground">
                        {r.where}
                      </span>
                    )}
                  </span>
                  {r.noLogin && (
                    <span className="shrink-0 text-[9px] font-display uppercase tracking-widest px-1.5 py-0.5 rounded border border-[color:var(--neon-blue)]/50 text-[color:var(--neon-blue)]">
                      No login yet
                    </span>
                  )}
                  <span
                    className={`shrink-0 text-[9px] font-display uppercase tracking-widest px-1.5 py-0.5 rounded border ${ROLE_TONE[r.role] ?? ""}`}
                  >
                    {ROLE_LABEL[r.role] ?? r.role}
                  </span>
                  <Send className="w-4 h-4 shrink-0 text-neon" />
                </button>
              ))
            )}
          </div>
        </SheetContent>
      </Sheet>

      <InviteDialog
        open={open && !!target}
        onOpenChange={(o) => {
          // Closing the dialog drops back onto the roster list for the next
          // invite — the batch-invite loop.
          if (!o) setTarget(null);
        }}
        target={target}
      />
    </>
  );
}
