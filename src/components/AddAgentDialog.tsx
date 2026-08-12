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
import { UserPlus } from "lucide-react";
import { addTeamMember } from "@/lib/users.functions";
import { DEFAULT_OFFICE, OFFICE_LOCATIONS, type OfficeLocation } from "@/lib/offices";

type VanLite = { id: string; name: string; color?: string | null; office_location?: string | null };

/**
 * Creates a placeholder Canvasser, optionally straight into a van. Shared by
 * the Fleet Dispatch board (per-van "+" button) and the Manage Fleet panel.
 * `initialVanId` presets the destination each time the dialog opens; picking
 * a van syncs the office to that van's office.
 */
export function AddAgentDialog({
  open,
  onOpenChange,
  vans,
  initialVanId = null,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  vans: VanLite[];
  initialVanId?: string | null;
}) {
  const qc = useQueryClient();
  const addTeamMemberFn = useServerFn(addTeamMember);
  const [name, setName] = useState("");
  const [vanId, setVanId] = useState<string | null>(initialVanId);
  const [office, setOffice] = useState<OfficeLocation>(DEFAULT_OFFICE);

  // Re-seed destination + office each time the dialog opens.
  useEffect(() => {
    if (open) {
      setVanId(initialVanId);
      const van = initialVanId ? vans.find((v) => v.id === initialVanId) : null;
      setOffice((van?.office_location as OfficeLocation) ?? DEFAULT_OFFICE);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, initialVanId]);

  const destinationName = vanId ? (vans.find((v) => v.id === vanId)?.name ?? "Van") : "Free Agents";

  const addAgent = useMutation({
    mutationFn: async () => {
      const trimmed = name.trim();
      if (!trimmed) throw new Error("Full Name required");
      await addTeamMemberFn({
        data: {
          full_name: trimmed,
          office_location: office,
          role: "canvasser",
          team_id: vanId,
        },
      });
    },
    onSuccess: () => {
      toast.success(`${name.trim()} added to ${destinationName}`);
      setName("");
      onOpenChange(false);
      qc.invalidateQueries({ queryKey: ["fleet_dispatch"] });
      qc.invalidateQueries({ queryKey: ["manage_users"] });
    },
    onError: (e: Error) => toast.error(e.message ?? "Failed to add agent"),
  });

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle className="font-display uppercase tracking-widest">Add Agent</DialogTitle>
          <DialogDescription>
            Creates a placeholder Canvasser in {destinationName}.
          </DialogDescription>
        </DialogHeader>
        <div className="space-y-3 py-2">
          <div>
            <Label
              htmlFor="agent-name"
              className="text-[10px] font-display uppercase tracking-widest text-muted-foreground"
            >
              Full Name
            </Label>
            <Input
              id="agent-name"
              autoFocus
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder="e.g. Alex Morgan"
              onKeyDown={(e) => {
                if (e.key === "Enter") addAgent.mutate();
              }}
            />
          </div>
          <div>
            <Label className="text-[10px] font-display uppercase tracking-widest text-muted-foreground">
              Van
            </Label>
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
          <div>
            <Label className="text-[10px] font-display uppercase tracking-widest text-muted-foreground">
              Office
            </Label>
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
        <DialogFooter>
          <Button variant="ghost" onClick={() => onOpenChange(false)}>
            Cancel
          </Button>
          <Button
            onClick={() => addAgent.mutate()}
            disabled={addAgent.isPending || !name.trim()}
            className="bg-neon text-background hover:bg-neon/90"
          >
            <UserPlus className="w-4 h-4 mr-1" /> Add to {destinationName}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
