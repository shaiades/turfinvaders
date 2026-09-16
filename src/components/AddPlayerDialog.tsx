import { useEffect, useState } from "react";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { useServerFn } from "@tanstack/react-start";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { toast } from "sonner";
import { KeyRound, UserPlus } from "lucide-react";
import { addTeamMember, createCanvasser } from "@/lib/users.functions";
import { ROSTER_KEYS } from "@/hooks/useRosterActions";
import { DEFAULT_OFFICE, OFFICE_LOCATIONS, type OfficeLocation } from "@/lib/offices";
import { creatableRolesFor, ROLE_LABEL, type AppRole } from "@/lib/role-policy";
import { useAuth } from "@/hooks/useAuth";

type VanLite = { id: string; name: string; color?: string | null; office_location?: string | null };

/**
 * THE add-a-player dialog — the one path onto the roster (replaced the three
 * former forms: Fleet's Add Agent, the captain dashboard's Add Team Member,
 * and Manage Players' inline Add New Player, 2026-09-16).
 *
 * Two modes: "Roster only" inserts a placeholder profile (no login — the
 * Invite button mints one later, history attached), "Create login" makes a
 * real auth account with email + temp password on the spot. Role choices
 * follow creatableRolesFor (Owners: all; Managers: up to Captain; Captains:
 * canvasser tier). Picking a van syncs the office to that van's office.
 */
export function AddPlayerDialog({
  open,
  onOpenChange,
  vans,
  initialVanId = null,
  onInvite,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  vans: VanLite[];
  initialVanId?: string | null;
  /** When provided, a roster-only add offers "Invite now" on the success
   *  toast, handing back the new profile for an InviteDialog. */
  onInvite?: (target: { id: string; name: string; role: AppRole }) => void;
}) {
  const qc = useQueryClient();
  const { realRole } = useAuth();
  const addTeamMemberFn = useServerFn(addTeamMember);
  const createCanvasserFn = useServerFn(createCanvasser);
  const creatable = creatableRolesFor(realRole);

  const [name, setName] = useState("");
  const [role, setRole] = useState<AppRole>("canvasser");
  const [vanId, setVanId] = useState<string | null>(initialVanId);
  const [office, setOffice] = useState<OfficeLocation>(DEFAULT_OFFICE);
  const [withLogin, setWithLogin] = useState(false);
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");

  // Re-seed each open: destination + its office, everything else blank.
  useEffect(() => {
    if (open) {
      setName("");
      setRole("canvasser");
      setVanId(initialVanId);
      const van = initialVanId ? vans.find((v) => v.id === initialVanId) : null;
      setOffice((van?.office_location as OfficeLocation) ?? DEFAULT_OFFICE);
      setWithLogin(false);
      setEmail("");
      setPassword("");
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, initialVanId]);

  const destinationName = vanId ? (vans.find((v) => v.id === vanId)?.name ?? "Van") : "Free Agents";
  const safeRole: AppRole = creatable.includes(role) ? role : "canvasser";

  const create = useMutation({
    mutationFn: async () => {
      const trimmed = name.trim();
      if (!trimmed) throw new Error("Full name required");
      if (withLogin) {
        return createCanvasserFn({
          data: {
            email: email.trim().toLowerCase(),
            password,
            display_name: trimmed,
            role: safeRole,
            office_location: office,
            team_id: vanId,
          },
        });
      }
      return addTeamMemberFn({
        data: {
          full_name: trimmed,
          office_location: office,
          role: safeRole,
          team_id: vanId,
        },
      });
    },
    onSuccess: (res) => {
      const trimmed = name.trim();
      for (const key of ROSTER_KEYS) qc.invalidateQueries({ queryKey: key });
      qc.invalidateQueries({ queryKey: ["all_canvassers_simple"] });
      if (withLogin) {
        toast.success(`${trimmed} added to ${destinationName} — they can sign in right now`);
      } else if (onInvite) {
        const target = { id: (res as { id: string }).id, name: trimmed, role: safeRole };
        toast.success(`${trimmed} added to ${destinationName}`, {
          action: { label: "Invite now", onClick: () => onInvite(target) },
          description: "No login yet — Invite creates one whenever you're ready.",
        });
      } else {
        toast.success(`${trimmed} added to ${destinationName}`);
      }
      onOpenChange(false);
    },
    onError: (e: Error) => toast.error(e.message ?? "Failed to add player"),
  });

  const submitDisabled =
    create.isPending || !name.trim() || (withLogin && (!email.trim() || password.length < 8));

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-h-[90dvh] overflow-y-auto">
        <DialogHeader>
          <DialogTitle className="font-display uppercase tracking-widest">Add Player</DialogTitle>
          <DialogDescription>
            They land in {destinationName} and show up in every dropdown instantly.
          </DialogDescription>
        </DialogHeader>

        <form
          className="space-y-4"
          onSubmit={(e) => {
            e.preventDefault();
            if (!submitDisabled) create.mutate();
          }}
        >
          <div className="space-y-2">
            <Label htmlFor="ap-name">Full Name</Label>
            <Input
              id="ap-name"
              autoFocus
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder="e.g. Alex Morgan"
            />
          </div>

          <div className="grid grid-cols-2 gap-3">
            {creatable.length > 0 && (
              <div className="space-y-2">
                <Label>Role</Label>
                <Select value={safeRole} onValueChange={(v) => setRole(v as AppRole)}>
                  <SelectTrigger>
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    {creatable.map((r) => (
                      <SelectItem key={r} value={r}>
                        {ROLE_LABEL[r]}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
            )}
            <div className="space-y-2">
              <Label>Office</Label>
              <Select value={office} onValueChange={(v) => setOffice(v as OfficeLocation)}>
                <SelectTrigger>
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {OFFICE_LOCATIONS.map((o) => (
                    <SelectItem key={o} value={o}>
                      {o}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
          </div>

          <div className="space-y-2">
            <Label>Van</Label>
            <Select
              value={vanId ?? "free"}
              onValueChange={(val) => {
                const next = val === "free" ? null : val;
                setVanId(next);
                if (next) {
                  const van = vans.find((v) => v.id === next);
                  if (van?.office_location) setOffice(van.office_location as OfficeLocation);
                }
              }}
            >
              <SelectTrigger>
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="free">Free Agents (assign later)</SelectItem>
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

          {/* Login mode toggle */}
          <div className="grid grid-cols-2 gap-2">
            <button
              type="button"
              onClick={() => setWithLogin(false)}
              className={`rounded-md border px-3 py-2 text-left text-xs transition-colors min-h-14 ${
                !withLogin
                  ? "border-neon text-neon bg-neon/10"
                  : "border-border text-muted-foreground hover:text-foreground"
              }`}
            >
              <span className="font-display uppercase tracking-widest text-[10px] flex items-center gap-1.5">
                <UserPlus className="w-3.5 h-3.5" /> Roster only
              </span>
              <span className="block mt-0.5 text-[11px] opacity-80">
                No login yet — send an invite later
              </span>
            </button>
            <button
              type="button"
              onClick={() => setWithLogin(true)}
              className={`rounded-md border px-3 py-2 text-left text-xs transition-colors min-h-14 ${
                withLogin
                  ? "border-neon text-neon bg-neon/10"
                  : "border-border text-muted-foreground hover:text-foreground"
              }`}
            >
              <span className="font-display uppercase tracking-widest text-[10px] flex items-center gap-1.5">
                <KeyRound className="w-3.5 h-3.5" /> Create login
              </span>
              <span className="block mt-0.5 text-[11px] opacity-80">
                Email + temp password, works now
              </span>
            </button>
          </div>

          {withLogin && (
            <div className="grid gap-3 sm:grid-cols-2">
              <div className="space-y-2">
                <Label htmlFor="ap-email">Email</Label>
                <Input
                  id="ap-email"
                  type="email"
                  value={email}
                  onChange={(e) => setEmail(e.target.value)}
                  placeholder="their@email.com"
                />
              </div>
              <div className="space-y-2">
                <Label htmlFor="ap-pass">Temp Password</Label>
                <Input
                  id="ap-pass"
                  type="text"
                  minLength={8}
                  value={password}
                  onChange={(e) => setPassword(e.target.value)}
                  placeholder="min 8 characters"
                />
              </div>
              <p className="sm:col-span-2 text-[11px] text-muted-foreground -mt-1">
                They sign in immediately with these — ask them to change the password after first
                login. Prefer no shared passwords? Use Roster only, then Invite: they set their own.
              </p>
            </div>
          )}

          <DialogFooter>
            <Button type="button" variant="ghost" onClick={() => onOpenChange(false)}>
              Cancel
            </Button>
            <Button
              type="submit"
              disabled={submitDisabled}
              className="bg-neon text-background hover:bg-neon/90"
            >
              <UserPlus className="w-4 h-4 mr-1" />
              {create.isPending ? "Adding…" : `Add to ${destinationName}`}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
