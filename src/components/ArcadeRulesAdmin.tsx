// Arcade Score v2 rules editor (engagement audit 2026-11-03, Tier 2) — the
// canvasser twin of KombatMonthAdmin's RulesEditor: every weight of the field
// economy editable without a deploy, upserted whole into the arcade_rules
// jsonb singleton (merged over DEFAULT_ARCADE_RULES on every read, so a
// missing key never zeroes a weight). Also holds the score_v2 master switch
// (arcade_flags) — the whole engine is dormant until the owner flips it.
// Drafts are strings so a half-typed number never writes.

import { useEffect, useRef, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import { supabase } from "@/integrations/supabase/client";
import { ArcadePanel, NeonButton } from "@/components/arcade";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  DEFAULT_ARCADE_RULES,
  mergeArcadeRules,
  type ArcadeRules,
} from "@/lib/canvasser-arcade";

export function ArcadeRulesAdmin() {
  const qc = useQueryClient();
  const rulesQ = useQuery({
    queryKey: ["arcade_rules"],
    queryFn: async () => {
      const { data, error } = await supabase
        .from("arcade_rules")
        .select("rules")
        .eq("id", true)
        .maybeSingle();
      if (error) throw error;
      return mergeArcadeRules(data?.rules ?? null);
    },
  });
  const flagQ = useQuery({
    queryKey: ["arcade_flags", "score_v2"],
    queryFn: async () => {
      const { data, error } = await supabase
        .from("arcade_flags")
        .select("score_v2")
        .eq("id", 1)
        .maybeSingle();
      if (error) throw error;
      return !!(data as { score_v2?: boolean } | null)?.score_v2;
    },
  });

  const flipFlag = useMutation({
    mutationFn: async (on: boolean) => {
      const { error } = await supabase
        .from("arcade_flags")
        .update({ score_v2: on } as never)
        .eq("id", 1);
      if (error) throw new Error(error.message);
      return on;
    },
    onSuccess: (on) => {
      toast.success(
        on
          ? "Arcade Score v2 is LIVE — points now mint on every action."
          : "Arcade Score v2 paused — mystery drops resume.",
      );
      void qc.invalidateQueries({ queryKey: ["arcade_flags", "score_v2"] });
    },
    onError: (e) => toast.error((e as Error).message),
  });

  const rules = rulesQ.data ?? DEFAULT_ARCADE_RULES;
  return (
    <ArcadePanel
      title="Arcade Score v2"
      faction="turf"
      status={flagQ.data ? "good" : "warn"}
      action={
        <NeonButton
          tone={flagQ.data ? "turf-cyan" : "turf-pink"}
          disabled={flagQ.isLoading || flipFlag.isPending}
          onClick={() => flipFlag.mutate(!flagQ.data)}
          aria-pressed={!!flagQ.data}
        >
          {flagQ.data ? "LIVE — tap to pause" : "OFF — tap to go live"}
        </NeonButton>
      }
    >
      <RulesForm rules={rules} onChanged={() => qc.invalidateQueries({ queryKey: ["arcade_rules"] })} />
    </ArcadePanel>
  );
}

function RulesForm({ rules, onChanged }: { rules: ArcadeRules; onChanged: () => void }) {
  const [draft, setDraft] = useState<Record<string, string>>(() => flatten(rules));
  const [dirty, setDirty] = useState(false);

  // Loaded values re-seed an untouched draft (KombatMonthAdmin precedent —
  // Save must never quietly write defaults over the owner's tuning).
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
        .from("arcade_rules")
        .upsert({ id: true, rules: next as never }, { onConflict: "id" });
      if (error) throw new Error(error.message);
    },
    onSuccess: () => {
      toast.success("Arcade rules saved — new grants use them immediately.");
      setDirty(false);
      onChanged();
    },
    onError: (e) => toast.error((e as Error).message),
  });

  const num = (id: string, label: string) => (
    <div className="space-y-1" key={id}>
      <Label htmlFor={`ar-${id}`} className="text-[10px] leading-tight">
        {label}
      </Label>
      <Input
        id={`ar-${id}`}
        inputMode="decimal"
        className="min-h-11 md:min-h-9 text-base md:text-xs"
        value={draft[id] ?? ""}
        onChange={(e) => set(id, e.target.value)}
      />
    </div>
  );
  const text = (id: string, label: string, placeholder = "") => (
    <div className="space-y-1" key={id}>
      <Label htmlFor={`ar-${id}`} className="text-[10px] leading-tight">
        {label}
      </Label>
      <Input
        id={`ar-${id}`}
        placeholder={placeholder}
        className="min-h-11 md:min-h-9 text-base md:text-xs"
        value={draft[id] ?? ""}
        onChange={(e) => set(id, e.target.value)}
      />
    </div>
  );

  return (
    <div className="space-y-5">
      <section>
        <Heading>Points per action (quality-weighted: the funnel pays)</Heading>
        <div className="grid grid-cols-2 gap-3 md:grid-cols-5">
          {num("pts.talk", "Conversation")}
          {num("pts.lead_set", "Lead set")}
          {num("pts.lead_confirmed", "Lead CONFIRMED")}
          {num("pts.sit", "Sit (the K.O.)")}
          {num("pts.sale", "Sale")}
        </div>
      </section>
      <section>
        <Heading>Critical hits (the slot machine)</Heading>
        <div className="grid grid-cols-2 gap-3 md:grid-cols-3">
          {num("crit.chance", "Chance (0–1)")}
          {num("crit.mult", "Multiplier")}
          {num("crit.daily_cap", "Max per day")}
        </div>
      </section>
      <section>
        <Heading>Combo &amp; Super</Heading>
        <div className="grid grid-cols-2 gap-3 md:grid-cols-4">
          {num("combo.window_min", "Combo window (min)")}
          {num("combo.cap", "Combo bonus cap")}
          {num("super.daily_target", "Super: daily target")}
          {num("super.bonus", "Super: bonus pts")}
        </div>
      </section>
      <section>
        <Heading>FINAL ROUND (end-of-year finale — blank dates = off)</Heading>
        <div className="grid grid-cols-2 gap-3 md:grid-cols-4">
          {text("finale.start", "Start (YYYY-MM-DD)", "2026-11-17")}
          {text("finale.end", "End (YYYY-MM-DD)", "2026-12-31")}
          {num("finale.weights.sit", "Sit weight")}
          {num("finale.weights.lead_confirmed", "Confirm weight")}
        </div>
        <div className="mt-3 grid grid-cols-2 gap-3 md:grid-cols-4">
          {rules.finale.tiers.map((t, i) => (
            <div key={t.key} className="space-y-2 rounded-lg border border-border p-2">
              <p className="font-display text-[10px] uppercase tracking-widest text-muted-foreground">
                {t.label}
              </p>
              {num(`finale.tiers.${i}.points`, "Points")}
            </div>
          ))}
        </div>
        <p className="mt-2 text-xs text-muted-foreground">
          Belts re-weight ledger history live — safe to tune mid-contest. Belts are status
          only; the finale cash is the $100K Boss ($1,500 per $100K sold) from the pay engine.
        </p>
      </section>
      <NeonButton tone="turf-cyan" disabled={!dirty || save.isPending} onClick={() => save.mutate()}>
        {save.isPending ? "Saving…" : "Save arcade rules"}
      </NeonButton>
    </div>
  );
}

function Heading({ children }: { children: React.ReactNode }) {
  return (
    <p className="mb-2 font-display text-[10px] uppercase tracking-widest text-muted-foreground">
      {children}
    </p>
  );
}

function flatten(rules: ArcadeRules): Record<string, string> {
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
    if (typeof obj === "string" || obj === null) {
      out[prefix] = obj ?? "";
      return;
    }
    if (Array.isArray(obj)) {
      obj.forEach((v, i) => walk(v, `${prefix}.${i}`));
      return;
    }
    if (typeof obj === "object") {
      for (const [k, v] of Object.entries(obj)) walk(v, prefix === "" ? k : `${prefix}.${k}`);
    }
  };
  walk(rules, "");
  return out;
}

function unflatten(draft: Record<string, string>, base: ArcadeRules): ArcadeRules {
  const next = JSON.parse(JSON.stringify(base)) as ArcadeRules;
  for (const [path, raw] of Object.entries(draft)) {
    const parts = path.split(".");
    let cur: Record<string, unknown> = next as unknown as Record<string, unknown>;
    for (let i = 0; i < parts.length - 1; i++) {
      cur = cur[parts[i]] as Record<string, unknown>;
      if (cur === undefined) break;
    }
    if (cur === undefined) continue;
    const leaf = parts[parts.length - 1];
    const prev = (cur as Record<string, unknown>)[leaf];
    if (typeof prev === "boolean") {
      (cur as Record<string, unknown>)[leaf] = raw === "1";
    } else if (typeof prev === "number") {
      const n = Number(raw);
      if (Number.isFinite(n)) (cur as Record<string, unknown>)[leaf] = n;
    } else if (typeof prev === "string" || prev === null) {
      // finale.start/end: a blank writes null (= finale off), text otherwise.
      (cur as Record<string, unknown>)[leaf] = raw === "" ? null : raw;
    } else if (prev === undefined && raw !== "") {
      const n = Number(raw);
      if (Number.isFinite(n)) (cur as Record<string, unknown>)[leaf] = n;
    }
  }
  return next;
}
