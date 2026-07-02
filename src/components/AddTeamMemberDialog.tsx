import { useState } from "react";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { useServerFn } from "@tanstack/react-start";
import { addTeamMember } from "@/lib/users.functions";
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
  DialogTrigger,
} from "@/components/ui/dialog";
import { toast } from "sonner";
import { UserPlus } from "lucide-react";

type Office = "San Diego" | "Orange County";


type Role = "owner" | "office_staff" | "captain" | "canvasser";

export function AddTeamMemberDialog({ variant = "default" }: { variant?: "default" | "neon" } = {}) {
  const qc = useQueryClient();
  const addFn = useServerFn(addTeamMember);
  const [open, setOpen] = useState(false);
  const [fullName, setFullName] = useState("");
  const [office, setOffice] = useState<Office>("San Diego");
  const [role, setRole] = useState<Role>("canvasser");

  const create = useMutation({
    mutationFn: async () =>
      addFn({ data: { full_name: fullName.trim(), office_location: office, role } }),
    onSuccess: () => {
      toast.success(`${fullName} added to roster`, {
        style: { background: "hsl(142 76% 36%)", color: "white" },
      });
      // Refresh every dropdown/roster that reads from profiles/user_roles.
      qc.invalidateQueries({ queryKey: ["manage_users"] });
      qc.invalidateQueries({ queryKey: ["dispatch_roster"] });
      qc.invalidateQueries({ queryKey: ["profiles"] });
      qc.invalidateQueries({ queryKey: ["fleet"] });
      qc.invalidateQueries({ queryKey: ["territories"] });
      qc.invalidateQueries({ queryKey: ["leaderboard"] });
      qc.invalidateQueries({ queryKey: ["canvassers"] });
      // Broad safety net for any query keyed on profile lists.
      qc.invalidateQueries();
      setFullName("");
      setOffice("San Diego");
      setRole("canvasser");
      setOpen(false);
    },
    onError: (e: Error) => toast.error(e.message),
  });

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger asChild>
        {variant === "neon" ? (
          <Button
            className="gap-2 font-display uppercase tracking-widest text-xs bg-neon text-background hover:bg-neon/90 shadow-[0_0_24px_-4px_color-mix(in_oklab,var(--neon)_70%,transparent)]"
          >
            <UserPlus className="h-4 w-4" />+ Add New Team Member / Captain
          </Button>
        ) : (
          <Button variant="outline" className="gap-2">
            <UserPlus className="h-4 w-4" />+ Add Team Member
          </Button>
        )}
      </DialogTrigger>
      <DialogContent>
        <DialogHeader>
          <DialogTitle className="font-display uppercase tracking-widest">
            Add Team Member
          </DialogTitle>
          <DialogDescription>
            Insert a roster entry directly. No login required — they'll appear in dropdowns instantly.
          </DialogDescription>
        </DialogHeader>

        <form
          className="space-y-4"
          onSubmit={(e) => {
            e.preventDefault();
            if (!fullName.trim()) {
              toast.error("Full name is required");
              return;
            }
            create.mutate();
          }}
        >
          <div className="space-y-2">
            <Label htmlFor="tm-name">Full Name</Label>
            <Input
              id="tm-name"
              autoFocus
              value={fullName}
              onChange={(e) => setFullName(e.target.value)}
              placeholder="e.g. Logan Reyes"
            />
          </div>

          <div className="space-y-2">
            <Label htmlFor="tm-office">Office Location</Label>
            <select
              id="tm-office"
              value={office}
              onChange={(e) => setOffice(e.target.value as Office)}
              className="w-full bg-input border border-border rounded-md px-3 py-2 text-sm"
            >
              <option value="San Diego">San Diego</option>
              <option value="Orange County">Orange County</option>
            </select>
          </div>

          <div className="space-y-2">
            <Label htmlFor="tm-role">System Role</Label>
            <select
              id="tm-role"
              value={role}
              onChange={(e) => setRole(e.target.value as Role)}
              className="w-full bg-input border border-border rounded-md px-3 py-2 text-sm"
            >
              <option value="canvasser">Canvasser</option>
              <option value="captain">Captain</option>
              <option value="office_staff">Admin</option>
              <option value="owner">Owner</option>
            </select>
          </div>

          <DialogFooter>
            <Button type="button" variant="ghost" onClick={() => setOpen(false)}>
              Cancel
            </Button>
            <Button type="submit" disabled={create.isPending}>
              {create.isPending ? "Saving…" : "Save"}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
