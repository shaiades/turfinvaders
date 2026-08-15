import { useEffect, useMemo, useRef, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { supabase } from "@/integrations/supabase/client";
import { DEFAULT_OFFICE } from "@/lib/offices";
import { useAuth } from "@/hooks/useAuth";
import { ArcadePanel } from "@/components/arcade";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";
import { toast } from "sonner";
import { Plus, Save, Send } from "lucide-react";
import { MondayEmbed } from "@/components/MondayEmbed";
import {
  findOfficeRow,
  sumLogCounters,
  useSaveTodayLog,
  useTodayLogs,
  type DailyLogRow,
  type SaveTodayLogInput,
} from "@/hooks/useDailyLogs";
import { useCanvasserProfile } from "@/hooks/useCanvasserProfile";

/**
 * The daily-log surface: today's counts + notes, both lead-submission paths
 * (internal pending lead → Confirmation Desk, Monday.com form → Incoming
 * Leads board), and the recent-leads status list. Rendered by the canvasser
 * Mission page's Log tab AND the leadership /log page.
 */

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
  | "doors_knocked"
  | "people_talked_to"
  | "renters"
  | "leads_called_in"
  | "confirmed_leads"
  | "next_days"
  | "future_leads"
  | "demos_sits"
  | "sales"
  | "one_legs"
  | "no_shows"
  | "no_demo";

type LogField = LogKey | "notes";
type LogState = Record<LogKey, number> & { notes: string };

const EMPTY: LogState = {
  doors_knocked: 0,
  people_talked_to: 0,
  renters: 0,
  leads_called_in: 0,
  confirmed_leads: 0,
  next_days: 0,
  future_leads: 0,
  demos_sits: 0,
  sales: 0,
  one_legs: 0,
  no_shows: 0,
  no_demo: 0,
  notes: "",
};

function fromRow(row: DailyLogRow | undefined, key: LogField): number | string {
  if (key === "notes") return row?.notes ?? "";
  return row?.[key] ?? 0;
}

export function DailyLogPanel({ canEditMondayUrl }: { canEditMondayUrl: boolean }) {
  const { user, teamId } = useAuth();

  // daily_logs rows are per (canvasser, day, office); the manual log always
  // targets the canvasser's home-office row, but reads span every office so
  // the totals here can't silently disagree with the Stats tab.
  const profile = useCanvasserProfile(user?.id);
  const myOffice = profile.data?.office_location ?? DEFAULT_OFFICE;
  // Don't accept edits until the real home office is known — a keystroke
  // made while myOffice is still the DEFAULT_OFFICE placeholder would be
  // dirty-pinned against the wrong row and later upserted over the real one.
  const officeReady = !profile.isLoading;
  const todayLogs = useTodayLogs(user?.id);
  const homeRow = findOfficeRow(todayLogs.data, myOffice);

  const [form, setForm] = useState<LogState>(EMPTY);
  // Fields the user has actually edited. Save sends ONLY these, so a pin
  // bumped into an untouched column between load and Save survives; the
  // hydration effect below also skips them so a background refetch can't
  // clobber in-progress typing.
  const [dirty, setDirty] = useState<Set<LogField>>(() => new Set());
  const dirtyRef = useRef(dirty);
  dirtyRef.current = dirty;
  const formRef = useRef(form);
  formRef.current = form;

  useEffect(() => {
    setForm((f) => {
      const next = { ...f };
      for (const v of VOCAB) {
        if (!dirtyRef.current.has(v.key)) next[v.key] = fromRow(homeRow, v.key) as number;
      }
      if (!dirtyRef.current.has("notes")) next.notes = fromRow(homeRow, "notes") as string;
      return next;
    });
  }, [homeRow]);

  const setField = (key: LogField, value: number | string) => {
    setForm((f) => ({ ...f, [key]: value }));
    setDirty((d) => (d.has(key) ? d : new Set(d).add(key)));
  };

  const save = useSaveTodayLog(user?.id);
  const submitSave = () => {
    const patch: SaveTodayLogInput["patch"] = {};
    for (const key of dirty) {
      if (key === "notes") patch.notes = form.notes;
      else patch[key] = form[key];
    }
    save.mutate(
      { office: myOffice, teamId, patch },
      {
        onSuccess: () => {
          toast.success("Daily log saved");
          // Un-dirty ONLY fields whose current value is exactly what this
          // save sent. Inputs stay enabled while the save is in flight, so a
          // field edited (or first touched) mid-save must stay dirty — a
          // blanket clear would let the post-save refetch silently revert
          // those keystrokes.
          setDirty((d) => {
            const next = new Set<LogField>();
            for (const key of d) {
              const sent = key === "notes" ? patch.notes : patch[key];
              const current = key === "notes" ? formRef.current.notes : formRef.current[key];
              if (sent === undefined || current !== sent) next.add(key);
            }
            return next;
          });
        },
        onError: (e: Error) => toast.error(e.message),
      },
    );
  };

  // Activity today that lives on a non-home-office row (pin bumps after an
  // office switch, office-staff entries). The editor can't touch those rows,
  // so surface them — otherwise this tab and the Stats totals visibly differ.
  const otherOffice = useMemo(
    () => sumLogCounters((todayLogs.data ?? []).filter((r) => r.office_location !== myOffice)),
    [todayLogs.data, myOffice],
  );
  const otherParts = [
    otherOffice.doors_knocked > 0 ? `${otherOffice.doors_knocked} doors` : null,
    otherOffice.people_talked_to > 0 ? `${otherOffice.people_talked_to} talks` : null,
    otherOffice.leads_called_in > 0 ? `${otherOffice.leads_called_in} leads called in` : null,
  ].filter(Boolean);

  return (
    <div className="space-y-8">
      <ArcadePanel
        title="Today's Counts"
        action={
          <Button
            onClick={submitSave}
            disabled={save.isPending || dirty.size === 0 || !officeReady}
          >
            <Save className="w-3.5 h-3.5 mr-1.5" /> {save.isPending ? "Saving…" : "Save"}
          </Button>
        }
      >
        {otherParts.length > 0 && (
          <div className="mb-4 rounded-md border border-warning/40 bg-warning/5 px-3 py-2 text-[11px] text-muted-foreground">
            Today's totals also include{" "}
            <span className="text-warning font-display">{otherParts.join(" · ")}</span> logged under
            another office — those aren't editable here.
          </div>
        )}
        <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-4 gap-4">
          {VOCAB.map((v) => (
            <div key={v.key}>
              <Label className="text-[10px] font-display uppercase tracking-widest text-muted-foreground">
                {v.label}
              </Label>
              <Input
                type="number"
                min={0}
                inputMode="numeric"
                className="mt-1.5 font-display text-lg"
                value={form[v.key]}
                disabled={!officeReady}
                onChange={(e) => setField(v.key, Math.max(0, Number(e.target.value) || 0))}
              />
            </div>
          ))}
        </div>
        <div className="mt-5">
          <Label className="text-[10px] font-display uppercase tracking-widest text-muted-foreground">
            Notes
          </Label>
          <Textarea
            className="mt-1.5"
            rows={2}
            value={form.notes}
            disabled={!officeReady}
            onChange={(e) => setField("notes", e.target.value)}
            placeholder="Anything your Manager or Captain should know about today…"
          />
        </div>
      </ArcadePanel>

      <NewLeadCard userId={user?.id} teamId={teamId} />

      <MondayEmbed canEdit={canEditMondayUrl} />

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
      setCustomer("");
      setAddress("");
      setIsSale(false);
      setAmount("");
      setNotes("");
      setOpen(false);
      qc.invalidateQueries({ queryKey: ["my_leads"] });
      qc.invalidateQueries({ queryKey: ["pending_leads"] });
      // A lead marked as a sale feeds the Stats MTD revenue once confirmed.
      qc.invalidateQueries({ queryKey: ["my_confirmed_sales"] });
    },
    onError: (e: Error) => toast.error(e.message),
  });

  return (
    <ArcadePanel
      title="Submit a New Lead"
      action={
        <Button variant={open ? "ghost" : "default"} onClick={() => setOpen((o) => !o)}>
          <Plus className="w-3.5 h-3.5 mr-1.5" /> {open ? "Close" : "New Lead"}
        </Button>
      }
    >
      {!open ? (
        <p className="text-xs text-muted-foreground">
          Submit a lead with status <span className="text-warning font-display">PENDING</span>. It
          will only count toward live van + office totals once a Manager hits Confirm.
        </p>
      ) : (
        <div className="space-y-4">
          <div className="grid sm:grid-cols-2 gap-4">
            <div>
              <Label>Customer name</Label>
              <Input
                value={customer}
                onChange={(e) => setCustomer(e.target.value)}
                maxLength={120}
              />
            </div>
            <div>
              <Label>Address</Label>
              <Input value={address} onChange={(e) => setAddress(e.target.value)} maxLength={200} />
            </div>
          </div>
          <div className="grid sm:grid-cols-2 gap-4">
            <div>
              <Label className="flex items-center gap-2">
                <input
                  type="checkbox"
                  className="w-5 h-5"
                  checked={isSale}
                  onChange={(e) => setIsSale(e.target.checked)}
                />
                Closed a sale on this lead
              </Label>
              {isSale && (
                <Input
                  className="mt-2"
                  type="number"
                  min={0}
                  step="0.01"
                  placeholder="Sale amount (USD)"
                  value={amount}
                  onChange={(e) => setAmount(e.target.value)}
                />
              )}
            </div>
            <div>
              <Label>Notes</Label>
              <Textarea
                rows={2}
                value={notes}
                onChange={(e) => setNotes(e.target.value)}
                maxLength={500}
              />
            </div>
          </div>
          <div className="flex justify-end">
            <Button onClick={() => submit.mutate()} disabled={submit.isPending}>
              <Send className="w-3.5 h-3.5 mr-1.5" />{" "}
              {submit.isPending ? "Submitting…" : "Submit Lead"}
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
        .select(
          "id, status, customer_name, address, is_sale, sale_amount, created_at, reviewed_at, deny_reason",
        )
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
              <StatusPill status={l.status as "pending" | "confirmed" | "denied"} />
            </li>
          ))}
        </ul>
      )}
    </ArcadePanel>
  );
}

function StatusPill({ status }: { status: "pending" | "confirmed" | "denied" }) {
  const map = {
    pending: "border-[var(--warning)] text-[var(--warning)]",
    confirmed: "border-[var(--victory)] text-victory",
    denied: "border-destructive text-destructive",
  } as const;
  return (
    <span
      className={`text-[10px] font-display uppercase tracking-widest px-2 py-1 rounded border ${map[status]}`}
    >
      {status}
    </span>
  );
}
