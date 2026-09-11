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
import { addDaysISO, laWeekStartISO } from "@/lib/dates";
import {
  HOURLY_MID,
  HOURLY_TOP,
  MONSTER_BONUS,
  MONSTER_THRESHOLD,
  POINTS_TIER_MID,
  POINTS_TIER_TOP,
  SIT_BONUS_THRESHOLD,
  weeklyPoints,
} from "@/lib/pay";
import { MondayEmbed } from "@/components/MondayEmbed";
import {
  findOfficeRow,
  sumLogCounters,
  useSaveTodayLog,
  useSixtyDayLogs,
  useTodayLogs,
  type DailyLogRow,
  type SaveTodayLogInput,
} from "@/hooks/useDailyLogs";
import { useCanvasserProfile } from "@/hooks/useCanvasserProfile";

/**
 * The DESK LOG (audit 2026-09-11): only the facts the field can't count for
 * itself. The door work — doors, talked, renters, leads called in — is
 * auto-bumped per pin by bump_daily_log_from_pin and shows here as
 * read-only counters (manual inputs were a double-entry trap: typing +1
 * renter never ticked talked, pins do both). Confirmed Leads left entirely
 * — that's the office's fact, read from daily_metrics. Notes left too
 * (owner call): it promised "your Manager or Captain" an audience that no
 * surface ever rendered. Also here: both lead-submission paths and the
 * recent-leads status list.
 */

// Pin-fed columns — displayed, never edited. Wording follows the
// GlossarySheet / pay.ts vocabulary, never invented.
const AUTO_VOCAB: { key: AutoKey; label: string; hint: string }[] = [
  { key: "doors_knocked", label: "Doors", hint: "Every pin counts the knock" },
  { key: "people_talked_to", label: "Talked", hint: "Conversations at the door" },
  { key: "renters", label: "Renters", hint: "A renter answered — not the owner" },
  { key: "leads_called_in", label: "Leads", hint: "Lead pins + Submit New Lead" },
];

// The desk facts — what happened AFTER the knock, typed by you.
const VOCAB: { key: LogKey; label: string; hint?: string }[] = [
  { key: "demos_sits", label: "Demos / Sits", hint: "You sat the demo at the table" },
  { key: "sales", label: "Sales" },
  { key: "next_days", label: "Next Days", hint: "Confirmed to run tomorrow" },
  { key: "future_leads", label: "Future Leads", hint: "Confirmed for a later date" },
  { key: "one_legs", label: "One Legs", hint: "Only one decision-maker was home" },
  { key: "no_shows", label: "No Shows", hint: "Customer wasn't there when it ran" },
  { key: "no_demo", label: "No Demo", hint: "Ran but no demo happened" },
];

type AutoKey = "doors_knocked" | "people_talked_to" | "renters" | "leads_called_in";

type LogKey =
  | "next_days"
  | "future_leads"
  | "demos_sits"
  | "sales"
  | "one_legs"
  | "no_shows"
  | "no_demo";

type LogField = LogKey;
type LogState = Record<LogKey, number>;

const EMPTY: LogState = {
  next_days: 0,
  future_leads: 0,
  demos_sits: 0,
  sales: 0,
  one_legs: 0,
  no_shows: 0,
  no_demo: 0,
};

function fromRow(row: DailyLogRow | undefined, key: LogKey): number {
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
  const sixtyQ = useSixtyDayLogs(user?.id);
  const homeRow = findOfficeRow(todayLogs.data, myOffice);

  const [form, setForm] = useState<LogState>(EMPTY);
  const [showBackupForm, setShowBackupForm] = useState(false);
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
        if (!dirtyRef.current.has(v.key)) next[v.key] = fromRow(homeRow, v.key);
      }
      return next;
    });
  }, [homeRow]);

  const setField = (key: LogField, value: number) => {
    setForm((f) => ({ ...f, [key]: value }));
    setDirty((d) => (d.has(key) ? d : new Set(d).add(key)));
  };

  const save = useSaveTodayLog(user?.id);
  const submitSave = () => {
    const patch: SaveTodayLogInput["patch"] = {};
    for (const key of dirty) {
      patch[key] = form[key];
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
              if (patch[key] === undefined || formRef.current[key] !== patch[key]) next.add(key);
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

  // Live points preview: the week's saved sits/sales with today's HOME-ROW
  // values swapped for what's currently typed — the tier consequence of a
  // sit shows the moment it's typed, before Save.
  const wkStart = laWeekStartISO();
  const wkEnd = addDaysISO(wkStart, 5);
  const weekRows = (sixtyQ.data ?? []).filter((r) => r.log_date >= wkStart && r.log_date <= wkEnd);
  const wk = sumLogCounters(weekRows);
  const homeSits = fromRow(homeRow, "demos_sits");
  const homeSales = fromRow(homeRow, "sales");
  const previewPts = weeklyPoints(
    Math.max(0, wk.demos_sits - homeSits + form.demos_sits),
    Math.max(0, wk.sales - homeSales + form.sales),
  );

  // All-office totals — the same numbers Stats and the HUD show.
  const totals = sumLogCounters(todayLogs.data);

  return (
    <div className="space-y-8">
      <ArcadePanel
        title="Desk Log"
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

        {/* Door work — counted by pins, shown here read-only so this tab can
            never disagree with Active Run / Stats / the HUD. */}
        <div className="mb-6">
          <div className="text-[10px] font-display uppercase tracking-widest text-muted-foreground mb-2">
            Door Work · <span className="text-neon">auto from your pins</span>
          </div>
          <div className="grid grid-cols-4 gap-2">
            {AUTO_VOCAB.map((a) => (
              <div
                key={a.key}
                className="rounded-md border border-border/60 bg-black/30 px-2 py-2.5 text-center"
                title={a.hint}
              >
                <div className="font-display text-2xl leading-none text-neon tabular-nums">
                  {totals[a.key]}
                </div>
                <div className="mt-1.5 text-[9px] font-display uppercase tracking-widest text-muted-foreground">
                  {a.label}
                </div>
              </div>
            ))}
          </div>
          <p className="mt-2 text-[10px] text-muted-foreground">
            Counts live as pins land on Active Run. Missed pins on a dead-phone day? Tell your
            captain.
          </p>
        </div>

        {/* The money strip — sits and sales below ARE the paycheck. */}
        <div className="mb-4 rounded-md border border-victory/40 bg-[color-mix(in_oklab,var(--victory)_7%,var(--surface))] px-3 py-2.5">
          <div className="text-[10px] font-display uppercase tracking-widest">
            <span className="text-muted-foreground">Wk Pts · </span>
            <span className="text-victory">{previewPts}</span>
            <span className="text-muted-foreground">
              {" · "}
              {previewPts >= MONSTER_THRESHOLD
                ? `$${MONSTER_BONUS} monster secured 💰`
                : previewPts >= POINTS_TIER_TOP
                  ? `${MONSTER_THRESHOLD - previewPts} more = $${MONSTER_BONUS} monster`
                  : previewPts >= POINTS_TIER_MID
                    ? `${POINTS_TIER_TOP - previewPts} more = $${HOURLY_TOP}/hr + 2% comm`
                    : `${POINTS_TIER_MID - previewPts} more = $${HOURLY_MID}/hr`}
            </span>
          </div>
          <div className="mt-1 text-[9px] font-display uppercase tracking-widest text-muted-foreground/70">
            PM sit = 1 pt · sale = 2 pts · sits past {SIT_BONUS_THRESHOLD} pay a bonus each
          </div>
        </div>

        <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-4 gap-4">
          {VOCAB.map((v) => (
            <div key={v.key}>
              <Label className="text-[10px] font-display uppercase tracking-widest text-muted-foreground">
                {v.label}
              </Label>
              {v.hint && (
                <p className="mt-0.5 text-[10px] leading-tight text-muted-foreground">{v.hint}</p>
              )}
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
      </ArcadePanel>

      <NewLeadCard userId={user?.id} teamId={teamId} />

      {/* The Monday.com form is a second, differently-shaped lead form; the
          internal card above is the primary path, so the embed stays behind a
          collapsed disclosure (which also defers the iframe load). */}
      <div>
        <button
          type="button"
          aria-expanded={showBackupForm}
          onClick={() => setShowBackupForm((s) => !s)}
          className="min-h-11 flex items-center gap-1.5 font-display text-[10px] uppercase tracking-widest text-muted-foreground hover:text-foreground"
        >
          Lead form (backup) {showBackupForm ? "▾" : "▸"}
        </button>
        {showBackupForm && <MondayEmbed canEdit={canEditMondayUrl} />}
      </div>

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
              <Label className="min-h-11 flex items-center gap-2">
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
                <div className="font-medium truncate">
                  {l.customer_name || "Unnamed lead"}
                  {l.is_sale && l.sale_amount != null && (
                    <span className="ml-2 font-display text-xs text-victory">
                      ${Number(l.sale_amount).toLocaleString()}
                    </span>
                  )}
                </div>
                <div className="text-xs text-muted-foreground truncate">
                  {l.address || "—"} · {new Date(l.created_at).toLocaleString()}
                </div>
                {/* Denials used to vanish silently — the desk's reason was
                    fetched and never shown. Seeing it is the coaching. */}
                {l.status === "denied" && l.deny_reason && (
                  <div className="mt-1 text-xs text-destructive">Denied: {l.deny_reason}</div>
                )}
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
