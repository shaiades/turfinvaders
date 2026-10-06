// The data contract for the Canvasser Arcade — leaderboard ladder + Van Wars,
// the $100K boss meter, and the paycheck wallet — all built on the SAME server
// aggregates the Fleet Dispatch board uses (getDispatchProduction) and the real
// pay engine (useMyEarnings → calc_weekly/monthly_paycheck). Nothing here
// invents a number; it only ranks, nets and shapes trusted totals so the UI
// stays dumb. Every dollar matches a paycheck.

import { useId, useMemo } from "react";
import { useQuery } from "@tanstack/react-query";
import { supabase } from "@/integrations/supabase/client";
import { getDispatchProduction } from "@/lib/dispatch.functions";
import {
  addDaysISO,
  laMidnightUtcISO,
  laMonthStartISO,
  laTodayISO,
  laWeekStartISO,
  remainingWorkdaysInMonth,
} from "@/lib/dates";
import { useAuth } from "@/hooks/useAuth";
import { useRealtimeInvalidate } from "@/hooks/useRealtimeInvalidate";
import { isLeadSourceName } from "@/lib/lead-sources";
import { useMyEarnings } from "@/hooks/useMyEarnings";
import {
  bossState,
  lootLines,
  lootTotal,
  paceProjection,
  sitRate,
  type BossState,
  type LootLine,
  type SitRate,
} from "@/lib/canvasserPay";

export type RangeKey = "day" | "week" | "month";

export function rangeFor(key: RangeKey): { start: string; end: string } {
  const today = laTodayISO();
  if (key === "day") return { start: today, end: today };
  if (key === "week") {
    const w = laWeekStartISO();
    return { start: w, end: addDaysISO(w, 5) };
  }
  return { start: laMonthStartISO(), end: today };
}

export type LadderRow = {
  id: string;
  name: string;
  teamId: string | null;
  teamName: string | null;
  teamColor: string | null;
  /** Weekly-points equivalent over the range (sit = 1, sale = 2). */
  pts: number;
  /** Credited sale volume, net of WCC cancellations. */
  vol: number;
  /** Sales count. */
  sal: number;
  /** Lead count (daily_logs funnel). */
  lds: number;
  drs: number;
  tlk: number;
  /** WCC-cancelled sales in range. */
  cancels: number;
  /** Closer-outcome sit rate over the leads this rep set (board leads). */
  sit: SitRate;
};

export type VanRow = {
  name: string;
  color: string;
  pts: number;
  vol: number;
  lds: number;
  sits: number;
  leads: number;
  /** Funnel sit rate for the van (its team health bar). */
  sit: SitRate;
};

export type ArcadeLadder = {
  rows: LadderRow[];
  vans: VanRow[];
  self: {
    row: LadderRow;
    rank: number;
    /** The row directly above, and the gap to pass it. */
    ahead: LadderRow | null;
    gapPts: number;
    gapVol: number;
  } | null;
  loading: boolean;
};

/**
 * The ranked ladder (pts → $ → leads) and the Van Wars rollup for a range,
 * plus the viewer's own standing and "next to pass" gap. Realtime-invalidates
 * on daily_logs / leads so a posted result bumps the board live.
 */
export function useArcadeLadder(range: RangeKey): ArcadeLadder {
  const { user } = useAuth();
  const selfId = user?.id;
  const { start, end } = rangeFor(range);

  const prodQ = useQuery({
    queryKey: ["arcade_ladder", "prod", start, end],
    queryFn: async () =>
      getDispatchProduction({
        data: {
          log_start: start,
          log_end: end,
          vol_start: laMidnightUtcISO(start),
          vol_end: laMidnightUtcISO(addDaysISO(end, 1)),
        },
      }),
  });

  const rosterQ = useQuery({
    queryKey: ["arcade_ladder", "roster"],
    staleTime: 5 * 60_000,
    queryFn: async () => {
      const [profilesR, teamsR] = await Promise.all([
        supabase.from("profiles").select("id, display_name, team_id"),
        supabase.from("teams").select("id, name, color"),
      ]);
      if (profilesR.error) throw profilesR.error;
      if (teamsR.error) throw teamsR.error;
      return { profiles: profilesR.data ?? [], teams: teamsR.data ?? [] };
    },
  });

  // useArcadeLadder is mounted by several co-rendered consumers at once — the
  // Mission Fighter/Paycheck/Stats cards, the Leaderboard, Van Wars, and the
  // Wrap (useWrapData mounts it TWICE). useRealtimeInvalidate's contract is
  // that co-mounted subscribers must NOT share a channel name: supabase-js
  // hands the second mount the already-subscribed "arcade-ladder" channel, and
  // `.on("postgres_changes")` on an already-subscribed channel throws. From
  // inside the effect that tore the whole arcade down to the root "Connection
  // Lost" boundary for every canvasser (incident 2026-10-06). A per-instance id
  // keeps each mount on its own channel — the few extra sockets are cheap and
  // the invalidations are debounced.
  const rtId = useId();
  useRealtimeInvalidate({
    channel: `arcade-ladder-${rtId}`,
    tables: ["daily_logs", "leads"],
    invalidateKeys: [["arcade_ladder", "prod"]],
    enabled: !!selfId,
  });

  const { rows, vans } = useMemo(() => {
    const prod = prodQ.data;
    const roster = rosterQ.data;
    if (!prod || !roster) return { rows: [] as LadderRow[], vans: [] as VanRow[] };
    const teamById = new Map(roster.teams.map((t) => [t.id, t]));
    const profById = new Map(roster.profiles.map((p) => [p.id, p]));

    const ids = new Set<string>([
      ...Object.keys(prod.points ?? {}),
      ...Object.keys(prod.volume ?? {}),
      ...Object.keys(prod.results ?? {}),
      ...Object.keys(prod.cancels ?? {}),
    ]);
    const rows: LadderRow[] = [];
    for (const id of ids) {
      const r = prod.results?.[id];
      const pts = prod.points?.[id] ?? 0;
      const vol = prod.volume?.[id] ?? 0;
      const lds = r?.lds ?? 0;
      const cxl = prod.cancels?.[id] ?? 0;
      if (pts === 0 && vol === 0 && lds === 0 && cxl === 0 && (r?.drs ?? 0) === 0) continue;
      const prof = profById.get(id);
      // Pseudo lead-source channels (Job Walk, Upsell…) are office credit, not
      // canvassers — they never appear on the reps' ladder.
      if (isLeadSourceName(prof?.display_name)) continue;
      const teamId = prod.snapshotTeam?.[id] ?? prof?.team_id ?? null;
      const team = teamId ? teamById.get(teamId) : null;
      rows.push({
        id,
        name: prof?.display_name ?? "Unknown",
        teamId: teamId ?? null,
        teamName: team?.name ?? null,
        teamColor: team?.color ?? null,
        pts,
        vol,
        sal: r?.sal ?? 0,
        lds,
        drs: r?.drs ?? 0,
        tlk: r?.tlk ?? 0,
        cancels: cxl,
        sit: sitRate(prod.funnelSits?.[id] ?? 0, prod.funnelLeads?.[id] ?? 0),
      });
    }
    rows.sort((a, b) => b.pts - a.pts || b.vol - a.vol || b.lds - a.lds || b.drs - a.drs);

    const vanMap = new Map<string, VanRow & { _sits: number; _leads: number }>();
    for (const r of rows) {
      const key = r.teamName ?? "Unassigned";
      const v =
        vanMap.get(key) ??
        ({
          name: key,
          color: r.teamColor ?? "#8a8f99",
          pts: 0,
          vol: 0,
          lds: 0,
          sits: 0,
          leads: 0,
          sit: sitRate(0, 0),
          _sits: 0,
          _leads: 0,
        } as VanRow & { _sits: number; _leads: number });
      v.pts += r.pts;
      v.vol += r.vol;
      v.lds += r.lds;
      v._sits += r.sit.sits;
      v._leads += r.sit.leads;
      vanMap.set(key, v);
    }
    const vans: VanRow[] = [...vanMap.values()]
      .map((v) => ({
        name: v.name,
        color: v.color,
        pts: v.pts,
        vol: v.vol,
        lds: v.lds,
        sits: v._sits,
        leads: v._leads,
        sit: sitRate(v._sits, v._leads),
      }))
      .sort((a, b) => b.pts - a.pts || b.vol - a.vol);
    return { rows, vans };
  }, [prodQ.data, rosterQ.data]);

  const self = useMemo(() => {
    const idx = rows.findIndex((r) => r.id === selfId);
    if (idx < 0) return null;
    const ahead = idx > 0 ? rows[idx - 1] : null;
    return {
      row: rows[idx],
      rank: idx + 1,
      ahead,
      gapPts: ahead ? ahead.pts - rows[idx].pts : 0,
      gapVol: ahead ? ahead.vol - rows[idx].vol : 0,
    };
  }, [rows, selfId]);

  return { rows, vans, self, loading: prodQ.isLoading || rosterQ.isLoading };
}

export type BossMeter = {
  boss: BossState;
  /** Month-to-date credited volume powering the boss (engine truth). */
  monthVolume: number;
  /** Projected end-of-month at the current pace. */
  pace: { projectedVolume: number; projectedBonuses: number };
  loading: boolean;
};

/**
 * The $100K boss meter for one canvasser, from the pay engine's monthly
 * sale_price_total — the exact figure calc_monthly_paycheck pays the $1,500
 * volume bonus on (cancellations already excluded). Pace is a straight-line
 * projection over the month's Mon–Sat workdays.
 */
export function useBossMeter(userId: string): BossMeter {
  const earnings = useMyEarnings(userId);
  const monthVolume = Number(earnings.monthPaycheck?.sale_price_total ?? 0);
  const today = laTodayISO();
  const total = remainingWorkdaysInMonth(laMonthStartISO());
  const remaining = remainingWorkdaysInMonth(today);
  const elapsed = Math.max(1, total - remaining + 1);
  return {
    boss: bossState(monthVolume),
    monthVolume,
    pace: paceProjection(monthVolume, elapsed, total),
    loading: earnings.isLoading,
  };
}

export type Wallet = {
  /** Loot lines for the selected scope. */
  lines: LootLine[];
  total: number;
  weekTotal: number;
  monthTotal: number;
  loading: boolean;
};

/**
 * The paycheck wallet: real loot lines from the pay engine. `scope` picks which
 * paycheck row feeds the breakdown — the week's clocked+commission+bonus row,
 * or the month (week totals folded + the $1,500 volume bonus chest).
 */
export function useWallet(userId: string, scope: "week" | "month"): Wallet {
  const earnings = useMyEarnings(userId);
  const wk = earnings.weekPaycheck;
  const mo = earnings.monthPaycheck;

  const lines = useMemo<LootLine[]>(() => {
    if (scope === "week") {
      return lootLines({
        base_pay: wk?.base_pay,
        ot_premium_pay: wk?.ot_premium_pay,
        meal_premium_pay: wk?.meal_premium_pay,
        commission: wk?.commission,
        sit_bonus: wk?.sit_bonus,
        monster_bonus: wk?.monster_bonus,
      });
    }
    // Month: the engine returns one folded weekly_pay_total + the volume bonus.
    // Show the volume-bonus chest explicitly and fold everything else earned
    // this month into the base line so the wallet total equals total_pay.
    const nonVolume = Number(mo?.weekly_pay_total ?? 0);
    return [
      { kind: "base", label: "Pay this month", coin: "silver", amount: nonVolume },
      {
        kind: "volumeBonus",
        label: "$100K bonus",
        coin: "chest",
        amount: Number(mo?.volume_bonus ?? 0) + Number(mo?.volume_bonus_ot_true_up ?? 0),
      },
    ];
  }, [scope, wk, mo]);

  return {
    lines,
    total: lootTotal(lines),
    weekTotal: earnings.weekEarned,
    monthTotal: earnings.monthEarned,
    loading: earnings.isLoading,
  };
}
