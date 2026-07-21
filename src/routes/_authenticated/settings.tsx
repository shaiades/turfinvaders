import { createFileRoute, redirect } from "@tanstack/react-router";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { supabase } from "@/integrations/supabase/client";
import { ArcadePanel } from "@/components/arcade";
import { toast } from "sonner";
import { useState, useEffect } from "react";
import { Eye, EyeOff } from "lucide-react";

export const Route = createFileRoute("/_authenticated/settings")({
  head: () => ({ meta: [{ title: "Company Settings — Knockout" }] }),
  beforeLoad: async () => {
    const { data } = await supabase.auth.getUser();
    if (!data.user) throw redirect({ to: "/auth" });
    const { data: roles } = await supabase.from("user_roles").select("role").eq("user_id", data.user.id).eq("role", "owner");
    if (!roles || roles.length === 0) throw redirect({ to: "/dashboard", search: { tab: "dispatch" } });
  },
  component: SettingsPage,
});

function SettingsPage() {
  const qc = useQueryClient();
  const { data: settings, isLoading } = useQuery({
    queryKey: ["company_settings"],
    queryFn: async () => (await supabase.from("company_settings").select("*").maybeSingle()).data,
  });

  const [name, setName] = useState("");
  useEffect(() => { if (settings?.company_name) setName(settings.company_name); }, [settings?.company_name]);

  const update = useMutation({
    mutationFn: async (patch: { global_visibility?: boolean; company_name?: string }) => {
      const { error } = await supabase.from("company_settings").update({ ...patch, updated_at: new Date().toISOString() }).eq("id", true);
      if (error) throw error;
    },
    onSuccess: () => { qc.invalidateQueries({ queryKey: ["company_settings"] }); toast.success("Saved"); },
    onError: (e) => toast.error(e.message),
  });

  if (isLoading) return <div className="text-sm text-muted-foreground">Loading…</div>;
  const visibility = !!settings?.global_visibility;

  return (
    <div className="space-y-8 max-w-3xl">
      <div>
        <div className="text-[10px] font-display uppercase tracking-widest text-muted-foreground">Owner Only</div>
        <h1 className="font-display text-2xl text-neon mt-1">COMPANY SETTINGS</h1>
      </div>

      <ArcadePanel title="Global Visibility">
        <div className="flex flex-col sm:flex-row sm:items-start sm:justify-between gap-4">
          <div>
            <p className="text-sm">
              When ON, Captains can view other teams' dashboards and Canvassers can view peer profiles & stats.
              When OFF, everyone is scoped to their own team / own dashboard.
            </p>
            <p className="text-xs text-muted-foreground mt-2">
              Personal income is always private — peer profiles only show production + revenue generated.
            </p>
          </div>
          <button
            onClick={() => update.mutate({ global_visibility: !visibility })}
            disabled={update.isPending}
            className={`shrink-0 inline-flex items-center gap-2 px-4 py-3 rounded-md font-display text-xs uppercase tracking-widest transition-colors ${
              visibility
                ? "bg-[var(--victory)] text-primary-foreground shadow-[var(--shadow-glow)]"
                : "bg-surface-elevated text-muted-foreground border border-border"
            }`}
            aria-pressed={visibility}
          >
            {visibility ? <><Eye className="w-4 h-4" /> ON</> : <><EyeOff className="w-4 h-4" /> OFF</>}
          </button>
        </div>
      </ArcadePanel>

      <ArcadePanel title="Company">
        <label className="block">
          <span className="text-[10px] font-display uppercase tracking-widest text-muted-foreground">Company name</span>
          <input
            value={name} onChange={(e) => setName(e.target.value)}
            className="mt-1 w-full bg-input border border-border rounded-md px-3 py-2.5 text-base md:text-sm"
          />
        </label>
        <button
          onClick={() => update.mutate({ company_name: name })}
          disabled={update.isPending || name === settings?.company_name}
          className="mt-4 bg-primary text-primary-foreground font-display text-xs uppercase tracking-widest px-4 py-2.5 rounded-md disabled:opacity-50"
        >
          Save
        </button>
      </ArcadePanel>
    </div>
  );
}
