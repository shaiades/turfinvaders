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
import { Check, Copy, MessageSquare, Share2, UserPlus } from "lucide-react";
import { addTeamMember } from "@/lib/users.functions";
import { createPersonWithInvite } from "@/lib/invites.functions";
import { ROSTER_KEYS } from "@/hooks/useRosterActions";
import { DEFAULT_OFFICE, OFFICE_LOCATIONS, type OfficeLocation } from "@/lib/offices";
import { creatableRolesFor, isVanExemptRole, ROLE_LABEL, type AppRole } from "@/lib/role-policy";
import { useAuth } from "@/hooks/useAuth";

type VanLite = { id: string; name: string; color?: string | null; office_location?: string | null };

/**
 * THE add-a-player dialog — the one path onto the roster (replaced the three
 * former forms 2026-09-16; collapsed to ONE step 2026-11-23).
 *
 * Default mode "Invite" does everything in one shot: creates the login
 * (they set their own password), places the profile, sets the role, and
 * hands back a 14-day invite link with Copy / Share / Text buttons — no
 * separate Invite step, no temp passwords. "Roster only" still inserts a
 * placeholder profile for board-minted canvassers (Invite later attaches
 * the login with history intact). Role choices follow creatableRolesFor
 * (Owners: all; Managers: up to Captain + Office; Captains: canvasser
 * tier). Picking a van syncs the office to that van's office.
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
  const createPersonFn = useServerFn(createPersonWithInvite);
  const creatable = creatableRolesFor(realRole);

  const [name, setName] = useState("");
  const [role, setRole] = useState<AppRole>("canvasser");
  const [vanId, setVanId] = useState<string | null>(initialVanId);
  const [office, setOffice] = useState<OfficeLocation>(DEFAULT_OFFICE);
  const [mode, setMode] = useState<"invite" | "roster">("invite");
  const [email, setEmail] = useState("");
  const [phone, setPhone] = useState("");
  /** The finished invite — the dialog swaps to a share view instead of
   *  closing, so the link can't get lost behind a toast. */
  const [result, setResult] = useState<{ link: string; name: string; phone: string } | null>(null);
  const [copied, setCopied] = useState(false);

  // Re-seed each open: destination + its office, everything else blank.
  useEffect(() => {
    if (open) {
      setName("");
      setRole("canvasser");
      setVanId(initialVanId);
      const van = initialVanId ? vans.find((v) => v.id === initialVanId) : null;
      setOffice((van?.office_location as OfficeLocation) ?? DEFAULT_OFFICE);
      setMode("invite");
      setEmail("");
      setPhone("");
      setResult(null);
      setCopied(false);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, initialVanId]);

  const safeRole: AppRole = creatable.includes(role) ? role : "canvasser";

  // The van selector hides for office-tier roles — clear any stale pick so
  // a pre-seeded van (Fleet's Add button) can't ride along unseen.
  useEffect(() => {
    if (isVanExemptRole(safeRole) && vanId) setVanId(null);
  }, [safeRole, vanId]);
  // Office roles (Office, HR, Bookkeeper, Sales Rep, Owner, Manager) never
  // ride a van — vanless, they land in "the office", never on The Bench.
  const destinationName = vanId
    ? (vans.find((v) => v.id === vanId)?.name ?? "Van")
    : isVanExemptRole(safeRole)
      ? "the office"
      : "The Bench";

  const create = useMutation({
    mutationFn: async () => {
      const trimmed = name.trim();
      if (!trimmed) throw new Error("Full name required");
      if (mode === "invite") {
        return createPersonFn({
          data: {
            display_name: trimmed,
            role: safeRole,
            office_location: office,
            team_id: vanId,
            email: email.trim().toLowerCase(),
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
      if (mode === "invite") {
        setResult({ link: (res as { link: string }).link, name: trimmed, phone: phone.trim() });
        return; // stay open — the share view is the point
      }
      if (onInvite) {
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

  const submitDisabled = create.isPending || !name.trim() || (mode === "invite" && !email.trim());

  async function copyLink() {
    if (!result) return;
    try {
      await navigator.clipboard.writeText(result.link);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    } catch {
      toast.error("Couldn't copy — long-press the link instead.");
    }
  }

  const smsHref = result
    ? `sms:${result.phone}?&body=${encodeURIComponent(
        `Welcome to Turf Invaders! Tap to set up your account: ${result.link}`,
      )}`
    : "#";

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-h-[90dvh] overflow-y-auto">
        {result ? (
          <>
            <DialogHeader>
              <DialogTitle className="font-display uppercase tracking-widest">
                {result.name} is in
              </DialogTitle>
              <DialogDescription>
                Send them this link — they tap it, set their own password, and land on their home
                screen. It works for 14 days; re-inviting replaces it.
              </DialogDescription>
            </DialogHeader>
            <div className="space-y-3">
              <Input readOnly value={result.link} onFocus={(e) => e.currentTarget.select()} />
              <div className="grid grid-cols-1 sm:grid-cols-3 gap-2">
                <Button onClick={copyLink} className="min-h-11 md:min-h-9">
                  {copied ? <Check className="w-4 h-4 mr-1" /> : <Copy className="w-4 h-4 mr-1" />}
                  {copied ? "Copied" : "Copy link"}
                </Button>
                {result.phone ? (
                  <Button asChild variant="outline" className="min-h-11 md:min-h-9">
                    <a href={smsHref}>
                      <MessageSquare className="w-4 h-4 mr-1" />
                      Text it
                    </a>
                  </Button>
                ) : null}
                {typeof navigator !== "undefined" && "share" in navigator ? (
                  <Button
                    variant="outline"
                    className="min-h-11 md:min-h-9"
                    onClick={() =>
                      navigator
                        .share({ title: "Turf Invaders invite", url: result.link })
                        .catch(() => {})
                    }
                  >
                    <Share2 className="w-4 h-4 mr-1" />
                    Share…
                  </Button>
                ) : null}
              </div>
            </div>
            <DialogFooter>
              <Button onClick={() => onOpenChange(false)}>Done</Button>
            </DialogFooter>
          </>
        ) : (
          <>
            <DialogHeader>
              <DialogTitle className="font-display uppercase tracking-widest">
                Add Player
              </DialogTitle>
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

              {!isVanExemptRole(safeRole) && (
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
                      <SelectItem value="free">The Bench (assign later)</SelectItem>
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
              )}

              {/* Mode toggle: one-step invite (default) vs roster-only placeholder */}
              <div className="grid grid-cols-2 gap-2">
                <button
                  type="button"
                  onClick={() => setMode("invite")}
                  className={`rounded-md border px-3 py-2 text-left text-xs transition-colors min-h-14 ${
                    mode === "invite"
                      ? "border-neon text-neon bg-neon/10"
                      : "border-border text-muted-foreground hover:text-foreground"
                  }`}
                >
                  <span className="font-display uppercase tracking-widest text-[10px] flex items-center gap-1.5">
                    <Share2 className="w-3.5 h-3.5" /> Invite
                  </span>
                  <span className="block mt-0.5 text-[11px] opacity-80">
                    One step: login + a link you text them
                  </span>
                </button>
                <button
                  type="button"
                  onClick={() => setMode("roster")}
                  className={`rounded-md border px-3 py-2 text-left text-xs transition-colors min-h-14 ${
                    mode === "roster"
                      ? "border-neon text-neon bg-neon/10"
                      : "border-border text-muted-foreground hover:text-foreground"
                  }`}
                >
                  <span className="font-display uppercase tracking-widest text-[10px] flex items-center gap-1.5">
                    <UserPlus className="w-3.5 h-3.5" /> Roster only
                  </span>
                  <span className="block mt-0.5 text-[11px] opacity-80">
                    No login yet — invite later
                  </span>
                </button>
              </div>

              {mode === "invite" && (
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
                    <Label htmlFor="ap-phone">Phone (for Text it)</Label>
                    <Input
                      id="ap-phone"
                      type="tel"
                      value={phone}
                      onChange={(e) => setPhone(e.target.value)}
                      placeholder="optional"
                    />
                  </div>
                  <p className="sm:col-span-2 text-[11px] text-muted-foreground -mt-1">
                    No passwords to hand around: you get a link good for 14 days, they tap it and
                    set their own.
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
                  {create.isPending
                    ? "Adding…"
                    : mode === "invite"
                      ? "Add & get invite link"
                      : `Add to ${destinationName}`}
                </Button>
              </DialogFooter>
            </form>
          </>
        )}
      </DialogContent>
    </Dialog>
  );
}
