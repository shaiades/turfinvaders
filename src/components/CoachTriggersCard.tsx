// "Who hit a trigger today" (Phase 5) — the owner's short list of coaching
// moments worth a 🎥, each with a one-tap send. Triggers (owner brief):
//   🩸 first lead EVER        first leads row landed today
//   💰 first sale from a lead their first is_sale lead confirmed today
//   ⚡ unlocked $30/hr        week points crossed 3 with today's production
//   🔄 back after a zero day  led today after a zero-lead previous workday
//   🤝 knocks plenty, converts low — the Phase 2 coaching flag (ride-along)
// Data: this week's daily_logs + today's leads (owner RLS reads all rows)
// plus the cached 14-day coaching aggregate. Display-only; sending goes
// through the composer → send_coach_message.

import { useMemo, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { supabase } from "@/integrations/supabase/client";
import { ArcadePanel } from "@/components/arcade";
import { Button } from "@/components/ui/button";
import { CoachMessageComposer } from "@/components/CoachMessageComposer";
import { getDispatchProduction } from "@/lib/dispatch.functions";
import { computeCoachingFlag, computeTeamBaseline, type ConverterRow } from "@/lib/coaching";
import { isNonPersonName } from "@/lib/lead-sources";
import { DOORS_TRACKED_SINCE } from "@/lib/funnel";
import { weeklyPoints, POINTS_TIER_MID, HOURLY_MID } from "@/lib/pay";
import { addDaysISO, laMidnightUtcISO, laTodayISO, laWeekStartISO } from "@/lib/dates";
import { Video } from "lucide-react";

type TriggerRow = {
  id: string;
  name: string;
  teamId: string | null;
  triggers: string[];
};

function useCoachTriggers() {
  const today = laTodayISO();
  const weekStart = laWeekStartISO();
  const start14 = (() => {
    const s = addDaysISO(today, -13);
    return s < DOORS_TRACKED_SINCE ? DOORS_TRACKED_SINCE : s;
  })();

  return useQuery({
    queryKey: ["coach_triggers", today],
    staleTime: 5 * 60_000,
    queryFn: async (): Promise<TriggerRow[]> => {
      const todayStartUtc = laMidnightUtcISO(today);
      const [logsR, leadsTodayR, profilesR, prod] = await Promise.all([
        supabase
          .from("daily_logs")
          .select("canvasser_id, log_date, demos_sits, sales, leads_called_in")
          .gte("log_date", weekStart),
        supabase
          .from("leads")
          .select("id, canvasser_id, is_sale, status, created_at")
          .gte("created_at", todayStartUtc),
        supabase.from("profiles").select("id, display_name, team_id"),
        // The same 14-day aggregate the coaching panel uses (shared cache key
        // would differ — this one is cheap and 5-min cached here).
        getDispatchProduction({
          data: {
            log_start: start14,
            log_end: today,
            vol_start: laMidnightUtcISO(start14),
            vol_end: laMidnightUtcISO(addDaysISO(today, 1)),
          },
        }),
      ]);
      if (logsR.error) throw logsR.error;
      if (leadsTodayR.error) throw leadsTodayR.error;
      if (profilesR.error) throw profilesR.error;

      const profById = new Map((profilesR.data ?? []).map((p) => [p.id, p] as const));
      const nameOf = (id: string) => profById.get(id)?.display_name ?? "Unknown";

      // ── firsts, from today's leads vs any prior lead/sale ──────────────────
      const leadsToday = (leadsTodayR.data ?? []).filter(
        (l) => l.canvasser_id && !isNonPersonName(nameOf(l.canvasser_id)),
      );
      const candidateIds = [...new Set(leadsToday.map((l) => l.canvasser_id as string))];
      const hadPriorLead = new Set<string>();
      const hadPriorSale = new Set<string>();
      if (candidateIds.length > 0) {
        const { data: priors } = await supabase
          .from("leads")
          .select("canvasser_id, is_sale")
          .in("canvasser_id", candidateIds)
          .lt("created_at", todayStartUtc)
          .limit(1000);
        for (const p of priors ?? []) {
          if (!p.canvasser_id) continue;
          hadPriorLead.add(p.canvasser_id);
          if (p.is_sale) hadPriorSale.add(p.canvasser_id);
        }
      }

      const triggersById = new Map<string, string[]>();
      const add = (id: string, label: string) => {
        const arr = triggersById.get(id) ?? [];
        if (!arr.includes(label)) arr.push(label);
        triggersById.set(id, arr);
      };

      for (const l of leadsToday) {
        const id = l.canvasser_id as string;
        if (!hadPriorLead.has(id)) add(id, "🩸 First lead EVER");
        if (l.is_sale && l.status === "confirmed" && !hadPriorSale.has(id)) {
          add(id, "💰 First sale from their lead");
        }
      }

      // ── week logs: tier unlock + back-after-zero ───────────────────────────
      type DayAgg = { sits: number; sales: number; leads: number };
      const byCanvasserDay = new Map<string, Map<string, DayAgg>>();
      for (const r of logsR.data ?? []) {
        if (!r.canvasser_id) continue;
        const days = byCanvasserDay.get(r.canvasser_id) ?? new Map<string, DayAgg>();
        const d = days.get(r.log_date) ?? { sits: 0, sales: 0, leads: 0 };
        d.sits += r.demos_sits ?? 0;
        d.sales += r.sales ?? 0;
        d.leads += r.leads_called_in ?? 0;
        days.set(r.log_date, d);
        byCanvasserDay.set(r.canvasser_id, days);
      }
      const yesterday = addDaysISO(today, -1);
      for (const [id, days] of byCanvasserDay) {
        if (isNonPersonName(nameOf(id))) continue;
        let before = 0;
        let withToday = 0;
        for (const [date, d] of days) {
          const pts = weeklyPoints(d.sits, d.sales);
          withToday += pts;
          if (date < today) before += pts;
        }
        if (before < POINTS_TIER_MID && withToday >= POINTS_TIER_MID) {
          add(id, `⚡ Unlocked $${HOURLY_MID}/hr today`);
        }
        const todayLeads = days.get(today)?.leads ?? 0;
        const yLeads = days.get(yesterday)?.leads;
        // "Back after a zero-lead day": worked yesterday (a log row exists),
        // blanked on leads, and scored today. Mondays skip (yesterday is
        // out-of-week here).
        if (todayLeads > 0 && yLeads === 0 && yesterday >= weekStart) {
          add(id, "🔄 Back after a zero-lead day");
        }
      }

      // ── coaching flag (ride-along) from the 14-day aggregate ───────────────
      const coachRows: ConverterRow[] = [];
      for (const [id, r] of Object.entries(prod.results ?? {})) {
        const name = nameOf(id);
        if (isNonPersonName(name)) continue;
        coachRows.push({
          id,
          name,
          drs: r.drs ?? 0,
          tlk: r.tlk ?? 0,
          ld: r.ld ?? 0,
          activeDays: prod.activeDays?.[id] ?? 0,
        });
      }
      const baseline = computeTeamBaseline(coachRows);
      for (const row of coachRows) {
        if (computeCoachingFlag(row, baseline).key === "ride_along") {
          add(row.id, "🤝 Knocks plenty, converts low → ride-along");
        }
      }

      return [...triggersById.entries()]
        .map(([id, triggers]) => ({
          id,
          name: nameOf(id),
          teamId: profById.get(id)?.team_id ?? null,
          triggers,
        }))
        .sort((a, b) => b.triggers.length - a.triggers.length || a.name.localeCompare(b.name));
    },
  });
}

export function CoachTriggersCard() {
  const triggers = useCoachTriggers();
  const [sendTo, setSendTo] = useState<TriggerRow | null>(null);
  const rows = useMemo(() => triggers.data ?? [], [triggers.data]);

  if (triggers.isLoading || rows.length === 0) return null;

  return (
    <div className="mb-6">
      <ArcadePanel
        title="🎥 Worth a message today"
        action={
          <span className="font-display text-[10px] uppercase tracking-widest text-muted-foreground">
            {rows.length} hit a trigger
          </span>
        }
      >
        <ul className="divide-y divide-border/60">
          {rows.map((r) => (
            <li key={r.id} className="flex items-center justify-between gap-3 py-2.5">
              <div className="min-w-0">
                <div className="truncate text-sm font-medium">{r.name}</div>
                <div className="mt-0.5 text-xs text-muted-foreground">{r.triggers.join(" · ")}</div>
              </div>
              <Button size="sm" variant="outline" onClick={() => setSendTo(r)}>
                <Video className="mr-1.5 h-3.5 w-3.5" /> Send
              </Button>
            </li>
          ))}
        </ul>
      </ArcadePanel>
      <CoachMessageComposer
        open={!!sendTo}
        onOpenChange={(o) => {
          if (!o) setSendTo(null);
        }}
        recipient={sendTo ? { id: sendTo.id, name: sendTo.name, teamId: sendTo.teamId } : null}
      />
    </div>
  );
}
