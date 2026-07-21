import { createFileRoute } from "@tanstack/react-router";
import { useEffect, useState } from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { supabase } from "@/integrations/supabase/client";
import { laTodayISO } from "@/lib/dates";
import { useAuth } from "@/hooks/useAuth";
import { ArcadePanel } from "@/components/arcade";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";
import { toast } from "sonner";
import { Plus, Save, Send } from "lucide-react";
import { MondayEmbed } from "@/components/MondayEmbed";

export const Route = createFileRoute("/_authenticated/log")({
  head: () => ({ meta: [{ title: "Daily Log — Knockout" }] }),
  component: LogPage,
});

const VOCAB: { key: LogKey; label: string }[] = [
  { key: "doors_knocked", label: "Doors Knocked" },
  { key: "people_talked_to", label: "People Talked To" },
  { key: "renters", label: "Renters" },
  { key: "leads_called_in", label: "Leads Called In" },
  { key: "confirmed_leads", label: "Confirmed Leads" },
  { key: "next_days", label: "Next Days" },
  { key: "future_leads", label: "Future Leads" },
  { key: "demos_sits", label: "Demos / Sits" },
  { key: "sales", label: "Sales" },
  { key: "one_legs", label: "One Legs" },
  { key: "no_shows", label: "No Shows" },
  { key: "no_demo", label: "No Demo" },
];

type LogKey =
  | "doors_knocked" | "people_talked_to" | "renters" | "leads_called_in"
  | "confirmed_leads" | "next_days" | "future_leads" | "demos_sits" | "sales"
  | "one_legs" | "no_shows" | "no_demo";

type LogState = Record<LogKey, number> & { notes: string };

const EMPTY: LogState = {
  doors_knocked: 0, people_talked_to: 0, renters: 0, leads_called_in: 0,
  confirmed_leads: 0, next_days: 0, future_leads: 0, demos_sits: 0, sales: 0,
  one_legs: 0, no_shows: 0, no_demo: 0, notes: "",
};

const todayISO = () => laTodayISO();

function LogPage() {
  const { user, teamId, role, loading } = useAuth();
  const qc = useQueryClient();
  const [form, setForm] = useState<LogState>(EMPTY);

  const existing = useQuery({
    enabled: !!user,
    queryKey: ["daily_logs", "today", user?.id],
    queryFn: async () => {
      const { data, error } = await supabase
        .from("daily_logs").select("*")
        .eq("canvasser_id", user!.id).eq("log_date", todayISO())
        .maybeSingle();
      if (error) throw error;
      return data;
    },
  });

  useEffect(() => {
    if (existing.data) {
      setForm({
        doors_knocked: existing.data.doors_knocked ?? 0,
        people_talked_to: existing.data.people_talked_to ?? 0,
        renters: existing.data.renters ?? 0,
        leads_called_in: existing.data.leads_called_in ?? 0,
        confirmed_leads: (existing.data as { confirmed_leads?: number }).confirmed_leads ?? 0,
        next_days: existing.data.next_days ?? 0,
        future_leads: existing.data.future_leads ?? 0,
        demos_sits: existing.data.demos_sits ?? 0,
        sales: existing.data.sales ?? 0,
        one_legs: existing.data.one_legs ?? 0,
        no_shows: existing.data.no_shows ?? 0,
        no_demo: existing.data.no_demo ?? 0,
        notes: existing.data.notes ?? "",
      });
    }
  }, [existing.data]);

  const save = useMutation({
    mutationFn: async () => {
      if (!user) throw new Error("Not signed in");
      const payload = {
        canvasser_id: user.id,
        team_id: teamId,
        log_date: todayISO(),
        ...form,
      };
      const { error } = await supabase
        .from("daily_logs")
        .upsert(payload, { onConflict: "canvasser_id,log_date" });
      if (error) throw error;
    },
    onSuccess: () => {
      toast.success("Daily log saved");
      qc.invalidateQueries({ queryKey: ["daily_logs"] });
    },
    onError: (e: Error) => toast.error(e.message),
  });

  if (loading) return <div className="text-sm text-muted-foreground">Loading…</div>;

  return (
    <div className="space-y-8 max-w-5xl">
      <div>
        <div className="text-[10px] font-display uppercase tracking-widest text-muted-foreground">
          {role === "canvasser" ? "Player Log" : "Daily Log"}
        </div>
        <h1 className="font-display text-2xl text-neon mt-1">DAILY LOG · {todayISO()}</h1>
        <p className="text-xs text-muted-foreground mt-2">
          Log your day. Numbers are saved instantly; submitted leads go to the Confirmation Desk.
        </p>
      </div>

      <ArcadePanel
        title="Today's Counts"
        action={
          <Button size="sm" onClick={() => save.mutate()} disabled={save.isPending}>
            <Save className="w-3.5 h-3.5 mr-1.5" /> {save.isPending ? "Saving…" : "Save"}
          </Button>
        }
      >
        <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-4 gap-4">
          {VOCAB.map((v) => (
            <div key={v.key}>
              <Label className="text-[10px] font-display uppercase tracking-widest text-muted-foreground">
                {v.label}
              </Label>
              <Input
                type="number" min={0} inputMode="numeric"
                className="mt-1.5 font-display text-lg"
                value={form[v.key]}
                onChange={(e) => setForm((f) => ({ ...f, [v.key]: Math.max(0, Number(e.target.value) || 0) }))}
              />
            </div>
          ))}
        </div>
        <div className="mt-5">
          <Label className="text-[10px] font-display uppercase tracking-widest text-muted-foreground">
            Notes
          </Label>
          <Textarea
            className="mt-1.5" rows={2}
            value={form.notes}
            onChange={(e) => setForm((f) => ({ ...f, notes: e.target.value }))}
            placeholder="Anything Office Staff or your Captain should know about today…"
          />
        </div>
      </ArcadePanel>

      <NewLeadCard userId={user?.id} teamId={teamId} />

      <MondayEmbed canEdit={role === "owner" || role === "office_staff"} />

      <MyRecentLeads userId={user?.id} />
    </div>
  );
}

function NewLeadCard({ userId, teamId }: { userId?: string; teamId: string | null }) {
  const qc = useQueryClient();
  const [open, setOpen] = useState(false);
  const [customer, setCustomer] = useState("");
  const [address, setAddress] = useState("");
  const [isSale, setIsSale] = useState(false);
  const [amount, setAmount] = useState<string>("");
  const [notes, setNotes] = useState("");

  const submit = useMutation({
    mutationFn: async () => {
      if (!userId) throw new Error("Not signed in");
      const { error } = await supabase.from("leads").insert({
        canvasser_id: userId,
        team_id: teamId,
        customer_name: customer || null,
        address: address || null,
        is_sale: isSale,
        sale_amount: isSale && amount ? Number(amount) : null,
        notes: notes || null,
        // status defaults to 'pending'
      });
      if (error) throw error;
    },
    onSuccess: () => {
      toast.success("Lead submitted — awaiting confirmation");
      setCustomer(""); setAddress(""); setIsSale(false); setAmount(""); setNotes("");
      setOpen(false);
      qc.invalidateQueries({ queryKey: ["my_leads"] });
      qc.invalidateQueries({ queryKey: ["pending_leads"] });
    },
    onError: (e: Error) => toast.error(e.message),
  });

  return (
    <ArcadePanel
      title="Submit a New Lead"
      action={
        <Button size="sm" variant={open ? "ghost" : "default"} onClick={() => setOpen((o) => !o)}>
          <Plus className="w-3.5 h-3.5 mr-1.5" /> {open ? "Close" : "New Lead"}
        </Button>
      }
    >
      {!open ? (
        <p className="text-xs text-muted-foreground">
          Submit a lead with status <span className="text-warning font-display">PENDING</span>. It will only count toward
          live van + office totals once Office Staff hits Confirm.
        </p>
      ) : (
        <div className="space-y-4">
          <div className="grid sm:grid-cols-2 gap-4">
            <div>
              <Label>Customer name</Label>
              <Input value={customer} onChange={(e) => setCustomer(e.target.value)} maxLength={120} />
            </div>
            <div>
              <Label>Address</Label>
              <Input value={address} onChange={(e) => setAddress(e.target.value)} maxLength={200} />
            </div>
          </div>
          <div className="grid sm:grid-cols-2 gap-4">
            <div>
              <Label className="flex items-center gap-2">
                <input type="checkbox" checked={isSale} onChange={(e) => setIsSale(e.target.checked)} />
                Closed a sale on this lead
              </Label>
              {isSale && (
                <Input
                  className="mt-2" type="number" min={0} step="0.01"
                  placeholder="Sale amount (USD)"
                  value={amount} onChange={(e) => setAmount(e.target.value)}
                />
              )}
            </div>
            <div>
              <Label>Notes</Label>
              <Textarea rows={2} value={notes} onChange={(e) => setNotes(e.target.value)} maxLength={500} />
            </div>
          </div>
          <div className="flex justify-end">
            <Button onClick={() => submit.mutate()} disabled={submit.isPending}>
              <Send className="w-3.5 h-3.5 mr-1.5" /> {submit.isPending ? "Submitting…" : "Submit Lead"}
            </Button>
          </div>
        </div>
      )}
    </ArcadePanel>
  );
}

function MyRecentLeads({ userId }: { userId?: string }) {
  const { data, isLoading } = useQuery({
    enabled: !!userId,
    queryKey: ["my_leads", userId],
    queryFn: async () => {
      const { data, error } = await supabase
        .from("leads")
        .select("id, status, customer_name, address, is_sale, sale_amount, created_at, reviewed_at, deny_reason")
        .eq("canvasser_id", userId!)
        .order("created_at", { ascending: false })
        .limit(20);
      if (error) throw error;
      return data ?? [];
    },
  });
  return (
    <ArcadePanel title="My Recent Leads">
      {isLoading ? (
        <div className="text-sm text-muted-foreground">Loading…</div>
      ) : (data ?? []).length === 0 ? (
        <div className="text-sm text-muted-foreground">No leads submitted yet.</div>
      ) : (
        <ul className="divide-y divide-border">
          {data!.map((l) => (
            <li key={l.id} className="py-3 flex items-center justify-between gap-3">
              <div className="min-w-0">
                <div className="font-medium truncate">{l.customer_name || "Unnamed lead"}</div>
                <div className="text-xs text-muted-foreground truncate">
                  {l.address || "—"} · {new Date(l.created_at).toLocaleString()}
                </div>
              </div>
              <StatusPill status={l.status as "pending"|"confirmed"|"denied"} />
            </li>
          ))}
        </ul>
      )}
    </ArcadePanel>
  );
}

function StatusPill({ status }: { status: "pending"|"confirmed"|"denied" }) {
  const map = {
    pending:   "border-[var(--warning)] text-[var(--warning)]",
    confirmed: "border-[var(--victory)] text-victory",
    denied:    "border-destructive text-destructive",
  } as const;
  return (
    <span className={`text-[10px] font-display uppercase tracking-widest px-2 py-1 rounded border ${map[status]}`}>
      {status}
    </span>
  );
}
