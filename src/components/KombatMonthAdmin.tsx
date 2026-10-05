// Kombat Month admin tools (owner directive 2026-10-02): rules editor,
// bounties, payout projection against the budget cap, CSV exports and the
// manual ledger recompute. Rendered inside the Kombat tab for the Admin
// tier only (owner + office_staff — "Manager"); the proof review queue
// lives on /confirmation-desk next to the Dojo queue.

import { useEffect, useMemo, useRef, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { supabase } from "@/integrations/supabase/client";
import { toast } from "sonner";
import { ArcadePanel, ArcadePill, NeonButton } from "@/components/arcade";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { csvCell, downloadCsvFile } from "@/lib/csv";
import { buildRepMatcher } from "@/lib/rep-identity";
import { useRepAliases, repAliasesKey } from "@/hooks/useRepAliases";
import { useAuth } from "@/hooks/useAuth";
import { getKombatAdminBoard, recomputeKombat } from "@/lib/kombat-month.functions";
import {
  CATEGORY_LABELS,
  PROOF_CATEGORIES,
  PROOF_LABELS,
  eligibilityStatus,
  fmtPts,
  projectPayouts,
  tierFor,
  type KombatBounty,
  type KombatRules,
  type ProofCategory,
  type RepTotals,
} from "@/lib/kombat-month";
import type { LedgerRow } from "@/components/KombatMonth";

const fmtMoney = (n: number) =>
  new Intl.NumberFormat("en-US", {
    style: "currency",
    currency: "USD",
    maximumFractionDigits: 0,
  }).format(n);

const BOUNTY_CATEGORIES = Object.keys(CATEGORY_LABELS);

export function KombatMonthAdmin({
  rules,
  totals,
  ledger,
  written,
  bounties,
  onChanged,
}: {
  rules: KombatRules;
  totals: RepTotals[];
  ledger: LedgerRow[];
  written: number;
  bounties: KombatBounty[];
  onChanged: () => void;
}) {
  const boardQuery = useQuery({
    queryKey: ["kombat_admin_board"],
    queryFn: () => getKombatAdminBoard(),
  });

  const recompute = useMutation({
    mutationFn: () => recomputeKombat(),
    onSuccess: (s) => {
      toast.success(
        `Ledger recomputed: ${s.inserted} new, ${s.updated} updated, ${s.newly_locked} locked, ${s.newly_cancelled} cancelled, ${s.deleted} removed.`,
      );
      onChanged();
    },
    onError: (e) => toast.error((e as Error).message),
  });

  // Eligibility per LEDGER rep name: profile rows bind by the same matcher
  // the Stats tab uses (aliases included), so a handle like "CurtofWest"
  // binds its board name; a ledger name with no profile OR alias stays
  // ineligible and is called out so the owner fixes the name or adds an
  // alias, not wonder about the math.
  const aliases = useRepAliases().data;
  const repNames = useMemo(() => totals.map((t) => t.rep_name), [totals]);
  const { eligibleByRep, unmatched } = useMemo(() => {
    const map = new Map<string, boolean>();
    const un: string[] = [];
    const countedSaleSet = new Set(boardQuery.data?.counted_sale_reps ?? []);
    const claimed = new Map<string, string>();
    for (const rep of boardQuery.data?.reps ?? []) {
      const m = buildRepMatcher(rep.display_name, repNames, aliases);
      if (!m.matched) continue;
      claimed.set(m.matched, rep.display_name);
      const s = eligibilityStatus(
        {
          purposeSubmitted: rep.purpose_submitted,
          testDays: rep.test_days,
          hasCountedSale: countedSaleSet.has(m.matched),
        },
        rules,
      );
      map.set(m.matched, s.eligible);
    }
    for (const name of repNames) if (!claimed.has(name)) un.push(name);
    return { eligibleByRep: map, unmatched: un };
  }, [boardQuery.data, repNames, rules, aliases]);

  const projection = useMemo(
    () => projectPayouts(totals, eligibleByRep, written, rules),
    [totals, eligibleByRep, written, rules],
  );

  // Counting rows only (cancelled stay out). Status says "final" once the
  // month-end window froze the row, "live" while it can still cancel —
  // payroll runs off the final export after finalization.
  const exportLedger = () => {
    const counting = ledger.filter((r) => r.status !== "cancelled");
    if (counting.length === 0) {
      toast.error("No ledger rows yet.");
      return;
    }
    const lines = [
      [
        "Rep",
        "Category",
        "Points",
        "Status",
        "Occurred",
        "Final at",
        "Source kind",
        "Source id",
        "Customer",
        "Note",
      ]
        .map(csvCell)
        .join(","),
      ...counting.map((r) =>
        [
          r.rep_name,
          CATEGORY_LABELS[r.category] ?? r.category,
          r.points.toFixed(2),
          r.status === "locked" ? "final" : "live",
          r.occurred_on ?? "",
          r.locked_at ?? "",
          r.source_kind,
          r.source_id,
          (r.meta?.customer as string) ?? "",
          (r.meta?.note as string) ?? "",
        ]
          .map(csvCell)
          .join(","),
      ),
    ];
    downloadCsvFile(`kombat-ledger-${rules.contest.month.slice(0, 7)}.csv`, lines);
  };

  const exportPayouts = () => {
    const lines = [
      ["Rep", "Points", "Final points", "Eligible", "Tier", "Cash", "Cash (pro-rated)", "Dinner"]
        .map(csvCell)
        .join(","),
      ...projection.rows.map((r) =>
        [
          r.rep_name,
          fmtPts(r.points),
          fmtPts(r.locked),
          r.eligible ? "yes" : "no",
          r.tier?.label ?? "",
          r.cash.toFixed(2),
          (r.cash * projection.prorate).toFixed(2),
          r.dinner ? "yes" : "no",
        ]
          .map(csvCell)
          .join(","),
      ),
    ];
    downloadCsvFile(`kombat-payouts-${rules.contest.month.slice(0, 7)}.csv`, lines);
  };

  return (
    <div className="space-y-4 md:space-y-6">
      <ArcadePanel
        title="Payout projection"
        faction="kombat"
        status={projection.overBudget ? "alert" : "good"}
        action={
          <div className="flex flex-wrap gap-2">
            <NeonButton
              tone="kombat-gold"
              disabled={recompute.isPending}
              onClick={() => recompute.mutate()}
            >
              {recompute.isPending ? "Recomputing…" : "Recompute ledger"}
            </NeonButton>
            <NeonButton tone="turf-cyan" onClick={exportLedger}>
              Ledger CSV
            </NeonButton>
            <NeonButton tone="turf-cyan" onClick={exportPayouts}>
              Payouts CSV
            </NeonButton>
          </div>
        }
      >
        <div className="mb-3 flex flex-wrap gap-x-5 gap-y-1 text-sm">
          <span>
            Cash <strong>{fmtMoney(projection.cashTotal)}</strong>
            {projection.unlockActive && (
              <span className="ml-1 text-kombat-gold">
                (×{rules.prizes.unlock_multiplier} unlocked)
              </span>
            )}
          </span>
          <span>
            Dinners <strong>{projection.dinnerHeads}</strong>
            {rules.prizes.dinner_cost_per_head > 0 && <> · {fmtMoney(projection.dinnerCost)}</>}
          </span>
          <span>
            Budget <strong>{fmtMoney(rules.prizes.budget_cap)}</strong>
          </span>
        </div>
        {projection.overBudget && (
          <p className="mb-3 rounded-md border border-destructive/50 bg-destructive/10 px-3 py-2 text-sm text-destructive">
            Projected payouts ({fmtMoney(projection.grandTotal)}) are over the budget cap — cash
            pro-rates to {Math.round(projection.prorate * 100)}% (
            {fmtMoney(projection.cashTotal * projection.prorate)} cash).
          </p>
        )}
        {unmatched.length > 0 && (
          <p className="mb-3 text-xs text-muted-foreground">
            No profile matched for: {unmatched.join(", ")} — they show as ineligible until the name
            matches a player profile, or you bind their handle in Name aliases below.
          </p>
        )}
        <div className="overflow-x-auto">
          <table className="w-full min-w-[560px] text-sm">
            <thead>
              <tr className="text-left text-[10px] font-display uppercase tracking-widest text-muted-foreground">
                <th className="py-1.5 pr-2">Rep</th>
                <th className="py-1.5 pr-2 text-right">Pts</th>
                <th className="py-1.5 pr-2 text-right">Final</th>
                <th className="py-1.5 pr-2">Eligible</th>
                <th className="py-1.5 pr-2">Tier</th>
                <th className="py-1.5 text-right">Cash</th>
              </tr>
            </thead>
            <tbody>
              {projection.rows.map((r) => (
                <tr key={r.rep_name} className="border-t border-border">
                  <td className="py-2 pr-2">{r.rep_name}</td>
                  <td className="py-2 pr-2 text-right tabular-nums">{fmtPts(r.points)}</td>
                  <td className="py-2 pr-2 text-right tabular-nums">{fmtPts(r.locked)}</td>
                  <td className="py-2 pr-2">{r.eligible ? "✓" : "—"}</td>
                  <td className="py-2 pr-2">{tierFor(r.points, rules).current?.label ?? "—"}</td>
                  <td className="py-2 text-right tabular-nums">
                    {r.cash > 0 ? fmtMoney(r.cash * projection.prorate) : r.dinner ? "Dinner" : "—"}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </ArcadePanel>

      <AliasPanel repNames={repNames} unmatched={unmatched} onChanged={onChanged} />
      <BountyPanel bounties={bounties} onChanged={onChanged} />
      <RulesEditor rules={rules} onChanged={onChanged} />
    </div>
  );
}

// ── Name aliases ───────────────────────────────────────────────────────────
// Bind a player's chosen handle to their board name so they keep the handle
// AND their points bind (buildRepMatcher's alias tier). One alias per rep;
// re-pointing a board name just overwrites the row that owns it.

type AliasRow = { profile_id: string; display_name: string; board_name: string };

function AliasPanel({
  repNames,
  unmatched,
  onChanged,
}: {
  repNames: string[];
  unmatched: string[];
  onChanged: () => void;
}) {
  const { user } = useAuth();
  const qc = useQueryClient();
  const [profileId, setProfileId] = useState("");
  const [boardName, setBoardName] = useState("");

  // Every sales-rep profile — the handle side of an alias. Also the lookup
  // for rendering existing aliases (display_name by id).
  const repsQuery = useQuery({
    queryKey: ["kombat_alias_rep_profiles"],
    queryFn: async () => {
      const { data: roleRows, error: rErr } = await supabase
        .from("user_roles")
        .select("user_id")
        .eq("role", "sales_rep");
      if (rErr) throw new Error(rErr.message);
      const ids = [...new Set((roleRows ?? []).map((r) => r.user_id))];
      if (ids.length === 0) return [] as { id: string; display_name: string }[];
      const { data, error } = await supabase
        .from("profiles")
        .select("id, display_name")
        .in("id", ids)
        .order("display_name");
      if (error) throw new Error(error.message);
      return (data ?? []).map((p) => ({ id: p.id, display_name: p.display_name ?? "" }));
    },
  });

  const aliasesQuery = useQuery({
    queryKey: ["kombat_alias_rows"],
    queryFn: async (): Promise<AliasRow[]> => {
      const { data, error } = await supabase
        .from("kombat_rep_aliases")
        .select("profile_id, board_name");
      if (error) throw new Error(error.message);
      const nameById = new Map((repsQuery.data ?? []).map((p) => [p.id, p.display_name]));
      return (data ?? []).map((a) => ({
        profile_id: a.profile_id,
        board_name: a.board_name,
        display_name: nameById.get(a.profile_id) ?? "(unknown profile)",
      }));
    },
    enabled: repsQuery.isSuccess,
  });

  const refresh = () => {
    qc.invalidateQueries({ queryKey: repAliasesKey });
    qc.invalidateQueries({ queryKey: ["kombat_alias_rows"] });
    onChanged();
  };

  const save = useMutation({
    mutationFn: async () => {
      if (profileId === "" || boardName === "") {
        throw new Error("Pick both a player and a board name.");
      }
      const { error } = await supabase.from("kombat_rep_aliases").upsert(
        { profile_id: profileId, board_name: boardName, created_by: user?.id ?? null },
        { onConflict: "profile_id" },
      );
      if (error) throw new Error(error.message);
    },
    onSuccess: () => {
      toast.success("Alias saved — their points bind on the next refresh.");
      setProfileId("");
      setBoardName("");
      refresh();
    },
    onError: (e) => toast.error((e as Error).message),
  });

  const remove = useMutation({
    mutationFn: async (id: string) => {
      const { error } = await supabase.from("kombat_rep_aliases").delete().eq("profile_id", id);
      if (error) throw new Error(error.message);
    },
    onSuccess: () => {
      toast.success("Alias removed.");
      refresh();
    },
    onError: (e) => toast.error((e as Error).message),
  });

  const selectClass =
    "min-h-11 md:min-h-9 w-full rounded-md border border-border bg-background px-3 text-base md:text-xs";
  const rows = aliasesQuery.data ?? [];

  return (
    <ArcadePanel title="Name aliases" status={unmatched.length > 0 ? "warn" : "good"}>
      <div className="space-y-3">
        <p className="text-xs text-muted-foreground">
          Bind a player&apos;s handle to their board name so they keep the handle (e.g.
          &ldquo;CurtofWest&rdquo;) and still see their points. One alias per player.
        </p>

        {rows.length > 0 && (
          <ul className="space-y-1.5">
            {rows.map((a) => (
              <li
                key={a.profile_id}
                className="flex flex-wrap items-center gap-2 rounded-md border border-border px-3 py-2 text-sm"
              >
                <span className="min-w-0 flex-1">
                  <span className="font-medium">{a.display_name}</span>
                  <span className="text-muted-foreground"> → {a.board_name}</span>
                </span>
                <NeonButton
                  tone="kombat-red"
                  disabled={remove.isPending}
                  onClick={() => remove.mutate(a.profile_id)}
                >
                  Remove
                </NeonButton>
              </li>
            ))}
          </ul>
        )}

        <div className="grid grid-cols-1 gap-3 md:grid-cols-[1fr_1fr_auto] md:items-end">
          <div className="space-y-1.5">
            <Label htmlFor="alias-profile">Player (handle)</Label>
            <select
              id="alias-profile"
              className={selectClass}
              value={profileId}
              onChange={(e) => setProfileId(e.target.value)}
            >
              <option value="">Select a player…</option>
              {(repsQuery.data ?? []).map((p) => (
                <option key={p.id} value={p.id}>
                  {p.display_name}
                </option>
              ))}
            </select>
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="alias-board">Board name</Label>
            <select
              id="alias-board"
              className={selectClass}
              value={boardName}
              onChange={(e) => setBoardName(e.target.value)}
            >
              <option value="">Select a board name…</option>
              {repNames.map((n) => (
                <option key={n} value={n}>
                  {unmatched.includes(n) ? `${n} — unclaimed` : n}
                </option>
              ))}
            </select>
          </div>
          <NeonButton
            tone="kombat-gold"
            disabled={save.isPending || profileId === "" || boardName === ""}
            onClick={() => save.mutate()}
          >
            {save.isPending ? "Saving…" : "Add alias"}
          </NeonButton>
        </div>
        {repNames.length === 0 && (
          <p className="text-xs text-muted-foreground">
            Board names appear once the ledger has rows for the month.
          </p>
        )}
      </div>
    </ArcadePanel>
  );
}

// ── Bounties ─────────────────────────────────────────────────────────────

function BountyPanel({ bounties, onChanged }: { bounties: KombatBounty[]; onChanged: () => void }) {
  const [label, setLabel] = useState("");
  const [multiplier, setMultiplier] = useState("2");
  const [startsOn, setStartsOn] = useState("");
  const [endsOn, setEndsOn] = useState("");
  const [cats, setCats] = useState<string[]>([]);

  const create = useMutation({
    mutationFn: async () => {
      if (label.trim() === "" || startsOn === "" || endsOn === "") {
        throw new Error("Label, start and end are required.");
      }
      const m = Number(multiplier);
      if (!Number.isFinite(m) || m <= 0) throw new Error("Multiplier must be a positive number.");
      if (endsOn < startsOn) throw new Error("The bounty ends before it starts.");
      const { error } = await supabase.from("contest_bounties").insert({
        label: label.trim(),
        categories: cats,
        multiplier: m,
        starts_on: startsOn,
        ends_on: endsOn,
      });
      if (error) throw new Error(error.message);
    },
    onSuccess: () => {
      toast.success("Bounty live — it applies at the next recompute.");
      setLabel("");
      setCats([]);
      onChanged();
    },
    onError: (e) => toast.error((e as Error).message),
  });

  const toggle = useMutation({
    mutationFn: async (b: KombatBounty) => {
      const { error } = await supabase
        .from("contest_bounties")
        .update({ active: !b.active })
        .eq("id", b.id);
      if (error) throw new Error(error.message);
    },
    onSuccess: onChanged,
    onError: (e) => toast.error((e as Error).message),
  });

  return (
    <ArcadePanel title="Bounties" status="good">
      <div className="space-y-3">
        {bounties.length > 0 && (
          <ul className="space-y-1.5">
            {bounties.map((b) => (
              <li
                key={b.id}
                className="flex flex-wrap items-center gap-2 rounded-md border border-border px-3 py-2 text-sm"
              >
                <span className="min-w-0 flex-1">
                  <span className="font-medium">{b.label}</span>
                  <span className="text-muted-foreground">
                    {" "}
                    ×{b.multiplier} · {b.starts_on} → {b.ends_on}
                    {b.categories.length > 0 && (
                      <> · {b.categories.map((c) => CATEGORY_LABELS[c] ?? c).join(", ")}</>
                    )}
                  </span>
                </span>
                <NeonButton
                  tone={b.active ? "kombat-red" : "turf-cyan"}
                  onClick={() => toggle.mutate(b)}
                >
                  {b.active ? "Deactivate" : "Reactivate"}
                </NeonButton>
              </li>
            ))}
          </ul>
        )}
        <div className="grid grid-cols-1 gap-3 md:grid-cols-4">
          <div className="space-y-1.5 md:col-span-2">
            <Label htmlFor="bounty-label">Label</Label>
            <Input
              id="bounty-label"
              placeholder="Self Gen Week"
              className="min-h-11 md:min-h-9 text-base md:text-xs"
              value={label}
              onChange={(e) => setLabel(e.target.value)}
            />
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="bounty-mult">Multiplier</Label>
            <Input
              id="bounty-mult"
              inputMode="decimal"
              className="min-h-11 md:min-h-9 text-base md:text-xs"
              value={multiplier}
              onChange={(e) => setMultiplier(e.target.value)}
            />
          </div>
          <div className="grid grid-cols-2 gap-3 md:col-span-1">
            <div className="space-y-1.5">
              <Label htmlFor="bounty-start">Starts</Label>
              <Input
                id="bounty-start"
                type="date"
                className="min-h-11 md:min-h-9 text-base md:text-xs"
                value={startsOn}
                onChange={(e) => setStartsOn(e.target.value)}
              />
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="bounty-end">Ends</Label>
              <Input
                id="bounty-end"
                type="date"
                className="min-h-11 md:min-h-9 text-base md:text-xs"
                value={endsOn}
                onChange={(e) => setEndsOn(e.target.value)}
              />
            </div>
          </div>
        </div>
        <div className="flex flex-wrap gap-1.5">
          {BOUNTY_CATEGORIES.map((c) => (
            <ArcadePill
              key={c}
              tone="kombat-gold"
              active={cats.includes(c)}
              onClick={() => setCats((p) => (p.includes(c) ? p.filter((x) => x !== c) : [...p, c]))}
            >
              {CATEGORY_LABELS[c]}
            </ArcadePill>
          ))}
        </div>
        <p className="text-xs text-muted-foreground">
          No categories selected = the multiplier covers everything in the window.
        </p>
        <NeonButton tone="kombat-gold" disabled={create.isPending} onClick={() => create.mutate()}>
          Create bounty
        </NeonButton>
      </div>
    </ArcadePanel>
  );
}

// ── Rules editor ─────────────────────────────────────────────────────────
// Every weight the spec names, editable without a deploy. Drafts are kept
// as strings so a half-typed number never writes; Save validates and
// upserts the whole rules jsonb (merged over defaults on every read).

function RulesEditor({ rules, onChanged }: { rules: KombatRules; onChanged: () => void }) {
  const [draft, setDraft] = useState<Record<string, string>>(() => flatten(rules));
  const [dirty, setDirty] = useState(false);

  // The rules query resolves AFTER first mount (defaults render first), so
  // an untouched draft must follow the loaded values or Save would quietly
  // write the defaults over the owner's tuning (review 2026-10-02). A
  // dirty draft is the admin's — never clobber it.
  const rulesKey = JSON.stringify(rules);
  const seededFrom = useRef(rulesKey);
  useEffect(() => {
    if (!dirty && seededFrom.current !== rulesKey) {
      seededFrom.current = rulesKey;
      setDraft(flatten(rules));
    }
  }, [rulesKey, dirty, rules]);

  const set = (k: string, v: string) => {
    setDraft((d) => ({ ...d, [k]: v }));
    setDirty(true);
  };

  const save = useMutation({
    mutationFn: async () => {
      const next = unflatten(draft, rules);
      const { error } = await supabase
        .from("contest_rules")
        .upsert({ id: true, rules: next as never }, { onConflict: "id" });
      if (error) throw new Error(error.message);
    },
    onSuccess: () => {
      toast.success("Rules saved — run Recompute to apply them to existing pending points.");
      setDirty(false);
      onChanged();
    },
    onError: (e) => toast.error((e as Error).message),
  });

  const num = (id: string, label: string) => (
    <div className="space-y-1" key={id}>
      <Label htmlFor={`kr-${id}`} className="text-[10px] leading-tight">
        {label}
      </Label>
      <Input
        id={`kr-${id}`}
        inputMode="decimal"
        className="min-h-11 md:min-h-9 text-base md:text-xs"
        value={draft[id] ?? ""}
        onChange={(e) => set(id, e.target.value)}
      />
    </div>
  );

  return (
    <ArcadePanel
      title="Contest rules"
      status={dirty ? "warn" : "good"}
      action={
        <NeonButton
          tone="kombat-gold"
          disabled={!dirty || save.isPending}
          onClick={() => save.mutate()}
        >
          {save.isPending ? "Saving…" : "Save rules"}
        </NeonButton>
      }
    >
      <div className="space-y-5">
        <section>
          <RulesHeading>Money (volume splits across the reps; bonus full each)</RulesHeading>
          <div className="grid grid-cols-2 gap-3 md:grid-cols-3">
            {num("money.per_1000", "Per $1,000 written")}
            {num("money.advantage_plus", "Advantage+")}
            {num("lock.cancel_window_days", "Cancel window (days)")}
          </div>
        </section>
        <section>
          <RulesHeading>Card kicker — one per deal, full to each rep</RulesHeading>
          <div className="grid grid-cols-2 gap-3 md:grid-cols-4">
            {num("card.selfgen_sale", "Self-gen sale")}
            {num("card.referral_sale", "Referral sale")}
            {num("card.reload", "Reload sale")}
            {num("card.sale", "Sale")}
            {num("card.selfgen_miss", "Self-gen pitch (miss)")}
            {num("card.referral_miss", "Referral pitch (miss)")}
            {num("activity.reload_pitch", "Reload pitch (subitem)")}
            {num("card.sit", "Sit")}
          </div>
        </section>
        <section>
          <RulesHeading>Proof points + caps</RulesHeading>
          <div className="grid grid-cols-2 gap-3 md:grid-cols-6">
            {PROOF_CATEGORIES.map((c: ProofCategory) =>
              num(`proofs.weights.${c}`, PROOF_LABELS[c]),
            )}
            {num("proofs.caps.before_after_per_month", "Before/after per month")}
            {num("proofs.caps.role_play_per_week", "Role plays per week")}
            {num("proofs.caps.gym_per_day", "Gym per day")}
            {num("proofs.caps.gym_per_week", "Gym per week")}
            {num("proofs.caps.total_per_month", "All proofs per month")}
          </div>
        </section>
        <section>
          <RulesHeading>Prize tiers + budget</RulesHeading>
          <div className="grid grid-cols-2 gap-3 md:grid-cols-5">
            {rules.prizes.tiers.map((t, i) => (
              <div className="space-y-2" key={t.key}>
                {num(`prizes.tiers.${i}.points`, `${t.label} points`)}
                {num(`prizes.tiers.${i}.cash`, `${t.label} cash`)}
              </div>
            ))}
          </div>
          <div className="mt-3 grid grid-cols-2 gap-3 md:grid-cols-4">
            {num("prizes.unlock_threshold", "Company unlock ($ written)")}
            {num("prizes.unlock_multiplier", "Unlock multiplier")}
            {num("prizes.budget_cap", "Budget cap ($, dinners included)")}
            {num("prizes.dinner_cost_per_head", "Dinner cost per head ($)")}
          </div>
        </section>
      </div>
    </ArcadePanel>
  );
}

function RulesHeading({ children }: { children: React.ReactNode }) {
  return (
    <p className="mb-2 text-[10px] font-display uppercase tracking-widest text-muted-foreground">
      {children}
    </p>
  );
}

// Flat string drafts ⇄ the nested rules object. Only the numeric leaves
// the editor shows round-trip; everything else passes through untouched.
function flatten(rules: KombatRules): Record<string, string> {
  const out: Record<string, string> = {};
  const walk = (obj: unknown, prefix: string) => {
    if (typeof obj === "number") {
      out[prefix] = String(obj);
      return;
    }
    if (typeof obj === "boolean") {
      out[prefix] = obj ? "1" : "0";
      return;
    }
    if (Array.isArray(obj)) {
      obj.forEach((v, i) => walk(v, `${prefix}.${i}`));
      return;
    }
    if (typeof obj === "object" && obj !== null) {
      for (const [k, v] of Object.entries(obj)) walk(v, prefix === "" ? k : `${prefix}.${k}`);
    }
  };
  walk(rules, "");
  return out;
}

function unflatten(draft: Record<string, string>, base: KombatRules): KombatRules {
  const next = JSON.parse(JSON.stringify(base)) as KombatRules;
  for (const [path, raw] of Object.entries(draft)) {
    const parts = path.split(".");
    let cur: Record<string, unknown> = next as unknown as Record<string, unknown>;
    for (let i = 0; i < parts.length - 1; i++) {
      cur = cur[parts[i]] as Record<string, unknown>;
      if (cur === undefined) break;
    }
    if (cur === undefined) continue;
    const leaf = parts[parts.length - 1];
    const prevType = (cur as Record<string, unknown>)[leaf];
    if (typeof prevType === "boolean") {
      (cur as Record<string, unknown>)[leaf] = raw === "1";
    } else if (typeof prevType === "number") {
      const n = Number(raw);
      if (Number.isFinite(n)) (cur as Record<string, unknown>)[leaf] = n;
    } else if (typeof prevType === "string" && raw !== "") {
      (cur as Record<string, unknown>)[leaf] = raw;
    }
  }
  return next;
}
