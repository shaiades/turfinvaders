import { createFileRoute, redirect } from "@tanstack/react-router";
import { useEffect, useState } from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { supabase } from "@/integrations/supabase/client";
import { useAuth } from "@/hooks/useAuth";
import { ArcadePanel, TeamBadge } from "@/components/arcade";
import { LiveLeadCounter } from "@/components/LiveLeadCounter";
import { useTodayLeads } from "@/hooks/useTodayLeads";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";
import { toast } from "sonner";
import { Check, X, Inbox } from "lucide-react";

export const Route = createFileRoute("/_authenticated/confirmation-desk")({
  head: () => ({ meta: [{ title: "Confirmation Desk — Knockout" }] }),
  beforeLoad: async () => {
    const { data } = await supabase.auth.getUser();
    if (!data.user) throw redirect({ to: "/auth" });
    const { data: roles } = await supabase
      .from("user_roles").select("role").eq("user_id", data.user.id);
    const r = (roles ?? []).map((x) => x.role);
    if (!r.includes("owner") && !r.includes("office_staff")) {
      throw redirect({ to: "/dashboard" });
    }
  },
  component: ConfirmationDesk,
});

type PendingLead = {
  id: string;
  canvasser_id: string;
  team_id: string | null;
  customer_name: string | null;
  address: string | null;
  is_sale: boolean;
  sale_amount: number | null;
  notes: string | null;
  created_at: string;
};

function ConfirmationDesk() {
  const { user } = useAuth();
  const qc = useQueryClient();
  const { data: leadsToday } = useTodayLeads();

  const pending = useQuery({
    queryKey: ["pending_leads"],
    queryFn: async () => {
      const { data, error } = await supabase
        .from("leads")
        .select("id, canvasser_id, team_id, customer_name, address, is_sale, sale_amount, notes, created_at")
        .eq("status", "pending")
        .order("created_at", { ascending: true });
      if (error) throw error;
      return (data ?? []) as PendingLead[];
    },
  });

  const directory = useQuery({
    queryKey: ["lead-directory"],
    queryFn: async () => {
      const [profilesRes, teamsRes] = await Promise.all([
        supabase.from("profiles").select("id, display_name"),
        supabase.from("teams").select("id, name, color"),
      ]);
      return {
        profiles: new Map((profilesRes.data ?? []).map((p) => [p.id, p])),
        teams: new Map((teamsRes.data ?? []).map((t) => [t.id, t])),
      };
    },
  });

  useEffect(() => {
    const ch = supabase
      .channel("pending-leads-live")
      .on("postgres_changes",
        { event: "*", schema: "public", table: "leads" },
        () => qc.invalidateQueries({ queryKey: ["pending_leads"] }),
      )
      .subscribe();
    return () => { supabase.removeChannel(ch); };
  }, [qc]);

  const decide = useMutation({
    mutationFn: async (args: { id: string; status: "confirmed" | "denied"; deny_reason?: string }) => {
      const { error } = await supabase
        .from("leads")
        .update({
          status: args.status,
          deny_reason: args.deny_reason ?? null,
          reviewed_at: new Date().toISOString(),
          reviewed_by: user?.id ?? null,
        })
        .eq("id", args.id);
      if (error) throw error;
    },
    onSuccess: (_d, vars) => {
      toast.success(vars.status === "confirmed" ? "Lead confirmed — counter ticked!" : "Lead denied");
      qc.invalidateQueries({ queryKey: ["pending_leads"] });
      qc.invalidateQueries({ queryKey: ["lead_events", "today"] });
    },
    onError: (e: Error) => toast.error(e.message),
  });

  return (
    <div className="space-y-8">
      <div className="flex flex-wrap items-end justify-between gap-3">
        <div>
          <div className="text-[10px] font-display uppercase tracking-widest text-muted-foreground">Office Staff</div>
          <h1 className="font-display text-2xl text-neon mt-1">CONFIRMATION DESK</h1>
          <p className="text-xs text-muted-foreground mt-2">
            Live queue of pending leads. Confirm to tick the van + office counters; deny to discard.
          </p>
        </div>
        <LiveLeadCounter value={leadsToday.total} size="md" accent="victory" label="CONFIRMED · TODAY" />
      </div>

      <ArcadePanel
        title="Pending Queue"
        action={
          <span className="text-[10px] font-display uppercase tracking-widest text-warning">
            {(pending.data?.length ?? 0)} waiting
          </span>
        }
      >
        {pending.isLoading ? (
          <div className="text-sm text-muted-foreground">Loading…</div>
        ) : (pending.data ?? []).length === 0 ? (
          <div className="text-center py-10 text-muted-foreground">
            <Inbox className="w-8 h-8 mx-auto mb-3 opacity-60" />
            <div className="text-sm">Queue is clear. All leads reviewed.</div>
          </div>
        ) : (
          <ul className="divide-y divide-border">
            {pending.data!.map((l) => (
              <PendingRow
                key={l.id} lead={l}
                canvasserName={directory.data?.profiles.get(l.canvasser_id)?.display_name ?? "Unknown"}
                team={l.team_id ? directory.data?.teams.get(l.team_id) : undefined}
                onConfirm={() => decide.mutate({ id: l.id, status: "confirmed" })}
                onDeny={(reason) => decide.mutate({ id: l.id, status: "denied", deny_reason: reason })}
                pending={decide.isPending}
              />
            ))}
          </ul>
        )}
      </ArcadePanel>
    </div>
  );
}

function PendingRow({
  lead, canvasserName, team, onConfirm, onDeny, pending,
}: {
  lead: PendingLead;
  canvasserName: string;
  team?: { id: string; name: string; color: string };
  onConfirm: () => void;
  onDeny: (reason: string) => void;
  pending: boolean;
}) {
  const [denying, setDenying] = useState(false);
  const [reason, setReason] = useState("");
  return (
    <li className="py-4 grid gap-3 md:grid-cols-[1fr_auto] md:items-center">
      <div className="min-w-0">
        <div className="flex flex-wrap items-center gap-2">
          <span className="font-medium">{lead.customer_name || "Unnamed lead"}</span>
          {team && <TeamBadge name={team.name} color={team.color} />}
          {lead.is_sale && (
            <span className="text-[10px] font-display uppercase tracking-widest px-2 py-0.5 rounded border border-[var(--victory)] text-victory">
              Sale {lead.sale_amount ? `· $${Number(lead.sale_amount).toLocaleString()}` : ""}
            </span>
          )}
        </div>
        <div className="text-xs text-muted-foreground mt-1">
          {canvasserName} · {lead.address || "no address"} · {new Date(lead.created_at).toLocaleString()}
        </div>
        {lead.notes && <div className="text-xs mt-1.5 text-muted-foreground italic">"{lead.notes}"</div>}
        {denying && (
          <div className="mt-3 flex gap-2 items-start">
            <Textarea
              rows={2} placeholder="Reason for denial…"
              value={reason} onChange={(e) => setReason(e.target.value)}
            />
            <div className="flex flex-col gap-1.5">
              <Button size="sm" variant="destructive" disabled={pending}
                onClick={() => { onDeny(reason); setDenying(false); setReason(""); }}>
                Confirm Deny
              </Button>
              <Button size="sm" variant="ghost" onClick={() => { setDenying(false); setReason(""); }}>Cancel</Button>
            </div>
          </div>
        )}
      </div>
      {!denying && (
        <div className="flex gap-2 md:justify-end">
          <Button size="sm" variant="outline" onClick={() => setDenying(true)} disabled={pending}>
            <X className="w-3.5 h-3.5 mr-1.5" /> Deny
          </Button>
          <Button size="sm" onClick={onConfirm} disabled={pending}
            className="bg-[var(--victory)] text-black hover:opacity-90">
            <Check className="w-3.5 h-3.5 mr-1.5" /> Confirm
          </Button>
        </div>
      )}
    </li>
  );
}
