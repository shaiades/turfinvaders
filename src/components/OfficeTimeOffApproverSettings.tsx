import { useEffect, useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import { Check } from "lucide-react";
import { supabase } from "@/integrations/supabase/client";
import { ArcadePanel } from "@/components/arcade";
import { Button } from "@/components/ui/button";

/** Owner-only: who approves OFFICE staff time-off (owner decision
 *  2026-11-23 — Tyler + Shai + HR Zuleyma, not every owner). Candidates are
 *  owners and HR. Backs review_day_off v4 and the notify-day-off audience via
 *  system_settings.office_timeoff_approver_ids. An empty list falls back to
 *  the normal admin rule, so unchecking everyone turns the restriction off.
 *  Mounted beside the Day Off queue in the timesheet editor. */
export function OfficeTimeOffApproverSettings() {
  const qc = useQueryClient();

  const owners = useQuery({
    queryKey: ["office-timeoff-approvers", "owners"],
    queryFn: async () => {
      const { data: roleRows, error: rErr } = await supabase
        .from("user_roles")
        .select("user_id, role")
        .in("role", ["owner", "hr"]);
      if (rErr) throw rErr;
      const roleById = new Map((roleRows ?? []).map((r) => [r.user_id, r.role]));
      const ids = [...roleById.keys()];
      if (ids.length === 0) return [] as Array<{ id: string; name: string }>;
      const { data: profs, error: pErr } = await supabase
        .from("profiles")
        .select("id, display_name")
        .in("id", ids);
      if (pErr) throw pErr;
      return (profs ?? [])
        .map((p) => ({
          id: p.id,
          name: (p.display_name ?? "Unknown") + (roleById.get(p.id) === "hr" ? " · HR" : ""),
        }))
        .sort((a, b) => a.name.localeCompare(b.name));
    },
  });

  const current = useQuery({
    queryKey: ["office-timeoff-approvers", "current"],
    queryFn: async () => {
      const { data, error } = await supabase.rpc("office_timeoff_approver_ids");
      if (error) return null; // migration not applied yet → render dark
      return (data as string[] | null) ?? [];
    },
  });

  const [picked, setPicked] = useState<Set<string>>(new Set());
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    if (current.data) setPicked(new Set(current.data));
  }, [current.data]);

  if (current.data === null || current.data === undefined) return null;
  const ownerList = owners.data ?? [];
  if (ownerList.length === 0) return null;

  const dirty =
    picked.size !== (current.data?.length ?? 0) ||
    (current.data ?? []).some((id) => !picked.has(id));

  async function save() {
    setSaving(true);
    const { error } = await supabase
      .from("system_settings")
      .update({ office_timeoff_approver_ids: [...picked] })
      .eq("id", true);
    setSaving(false);
    if (error) {
      toast.error("Save failed", { description: error.message });
      return;
    }
    qc.invalidateQueries({ queryKey: ["office-timeoff-approvers"] });
    qc.invalidateQueries({ queryKey: ["day-off"] });
    toast.success(
      picked.size > 0
        ? "Office time-off now answers to the checked people only"
        : "Restriction off — any time admin can review office requests",
    );
  }

  return (
    <ArcadePanel
      title="Office Time-Off Approvers"
      action={
        <span className="text-[10px] font-display uppercase tracking-widest text-muted-foreground">
          Owners only
        </span>
      }
    >
      <p className="text-xs text-muted-foreground mb-3">
        Office staff requests go only to the checked people — nobody else gets the push or the
        Approve button. Uncheck everyone to let any time admin review.
      </p>
      <div className="flex flex-wrap gap-2">
        {ownerList.map((o) => {
          const on = picked.has(o.id);
          return (
            <Button
              key={o.id}
              size="sm"
              variant={on ? "default" : "outline"}
              onClick={() =>
                setPicked((prev) => {
                  const next = new Set(prev);
                  if (next.has(o.id)) next.delete(o.id);
                  else next.add(o.id);
                  return next;
                })
              }
              className="min-h-11 md:min-h-8 font-display text-[10px] uppercase tracking-widest"
            >
              {on ? <Check className="w-3.5 h-3.5 mr-1" /> : null}
              {o.name}
            </Button>
          );
        })}
      </div>
      {dirty ? (
        <div className="mt-3">
          <Button
            size="sm"
            disabled={saving}
            onClick={save}
            className="min-h-11 md:min-h-8 font-display text-[10px] uppercase tracking-widest"
          >
            {saving ? "Saving…" : "Save approvers"}
          </Button>
        </div>
      ) : null}
    </ArcadePanel>
  );
}
