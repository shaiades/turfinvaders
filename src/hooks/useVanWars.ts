// Van Wars data — the weekly street race (Mon–Sat). Crew standings by war
// score ride the SAME week ladder the Solo board uses (useArcadeLadder →
// getDispatchProduction, realtime-invalidated), so a posted result moves both
// boards live. The tunable scoring config and the Wall-of-Fame history come
// from two owner-managed tables; both reads FAIL OPEN (defaults / empty) so Van
// Wars works before the migration is applied — the deliberate opposite of the
// "must throw on error" rule, because missing config must never blank the race.

import { useMemo, useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { supabase } from "@/integrations/supabase/client";
import type { SupabaseClient } from "@supabase/supabase-js";
import { laMonthStartISO, laWeekStartISO } from "@/lib/dates";
import { useArcadeLadder } from "@/hooks/useCanvasserArcade";
import {
  buildVanWarStandings,
  resolveVanWarsConfig,
  type VanWarStanding,
  type VanWarsConfig,
} from "@/lib/vanwars";

// Van Wars tables aren't in the generated Supabase types yet — raw-cast
// builder, the same pattern the gratitude / objection reads use.
const rawTable = (name: string) => (supabase as unknown as SupabaseClient).from(name);

export type VanWarWin = {
  week_start: string;
  team_name: string;
  color: string | null;
  war_score: number | null;
  /** "week" = a Saturday weekly win; "king" = the monthly Turf King belt. */
  kind: string;
  /** For a king row, the month it belongs to (e.g. "2026-10"). */
  period: string | null;
};

export type VanWarsData = {
  standings: VanWarStanding[];
  leader: VanWarStanding | null;
  config: VanWarsConfig;
  /** Wall of Fame: recent weekly winners + monthly kings, newest first. */
  wins: VanWarWin[];
  loading: boolean;
};

export function useVanWars(): VanWarsData {
  const ladder = useArcadeLadder("week");

  const cfgQ = useQuery({
    queryKey: ["vanwars", "config"],
    staleTime: 5 * 60_000,
    queryFn: async () => {
      // Fail open to defaults: a missing table / RLS denial must not blank the
      // race (see the module note — this is deliberately NOT "throw on error").
      const { data, error } = await rawTable("vanwars_config").select("*").limit(1).maybeSingle();
      if (error) return null;
      return data;
    },
  });

  const winsQ = useQuery({
    queryKey: ["vanwars", "wins"],
    staleTime: 60_000,
    queryFn: async () => {
      const { data, error } = await rawTable("vanwars_wins")
        .select("*")
        .order("week_start", { ascending: false })
        .limit(12);
      if (error) return [] as VanWarWin[];
      return (data ?? []) as unknown as VanWarWin[];
    },
  });

  // Vans race under their CAPTAIN's name (owner, 2026-10-05), falling back to
  // the team name for crews without one (e.g. the Confirmation desk). Two light
  // reads of standard typed tables → teamId → captain first name.
  const captainsQ = useQuery({
    queryKey: ["vanwars", "captains"],
    staleTime: 5 * 60_000,
    queryFn: async () => {
      const { data: roleRows, error: rErr } = await supabase
        .from("user_roles")
        .select("user_id")
        .eq("role", "captain");
      if (rErr || !roleRows?.length) return {} as Record<string, string>;
      const ids = roleRows.map((r) => r.user_id);
      const { data: profs, error: pErr } = await supabase
        .from("profiles")
        .select("display_name, team_id")
        .in("id", ids);
      if (pErr) return {} as Record<string, string>;
      const byTeam: Record<string, string> = {};
      for (const p of profs ?? []) {
        if (p.team_id && p.display_name && !byTeam[p.team_id]) {
          byTeam[p.team_id] = String(p.display_name).split(" ")[0];
        }
      }
      return byTeam;
    },
  });

  const config = useMemo(() => resolveVanWarsConfig(cfgQ.data), [cfgQ.data]);
  const captainByTeam = useMemo(() => captainsQ.data ?? {}, [captainsQ.data]);

  const standings = useMemo(
    () =>
      buildVanWarStandings(
        ladder.rows.map((r) => ({
          teamId: r.teamId,
          label: (r.teamId && captainByTeam[r.teamId]) || r.teamName || "Unassigned",
          teamColor: r.teamColor,
          pts: r.pts,
          sal: r.sal,
          vol: r.vol,
          sitSits: r.sit.sits,
          sitLeads: r.sit.leads,
        })),
        config,
      ),
    [ladder.rows, config, captainByTeam],
  );

  return {
    standings,
    leader: standings[0] ?? null,
    config,
    wins: winsQ.data ?? [],
    loading: ladder.loading,
  };
}

/** True from Saturday 6 PM PT through Sunday — the window a captain may crown
 *  this week's winner (the race locks Saturday 6 PM; Monday starts fresh). */
export function isCrownWindow(now: Date = new Date()): boolean {
  const la = new Date(now.toLocaleString("en-US", { timeZone: "America/Los_Angeles" }));
  const day = la.getDay();
  return (day === 6 && la.getHours() >= 18) || day === 0;
}

/**
 * Crown THIS week's leader into the Wall of Fame (vanwars_wins) and recompute
 * the monthly Turf King (the crew with the most weekly wins this month). Always
 * records the OBJECTIVE standings[0], so it doesn't matter who fires it;
 * idempotent on (week_start, kind). RLS limits the write to captain / owner /
 * office_staff, and the UI only exposes it inside the crown window.
 */
export function useCrownVanWars() {
  const qc = useQueryClient();
  const [crowning, setCrowning] = useState(false);
  const crown = async (standings: VanWarStanding[]) => {
    if (crowning || standings.length === 0) return;
    setCrowning(true);
    try {
      const week = laWeekStartISO();
      const w = standings[0];
      await rawTable("vanwars_wins").upsert(
        {
          week_start: week,
          kind: "week",
          team_id: w.teamId,
          team_name: w.name,
          color: w.color,
          war_score: Math.round(w.war),
        },
        { onConflict: "week_start,kind" },
      );
      // Monthly Turf King = the crew with the most weekly wins this month.
      const month = laMonthStartISO();
      const { data: monthWins } = await rawTable("vanwars_wins")
        .select("team_name, color, kind, week_start")
        .eq("kind", "week")
        .gte("week_start", month);
      const tally = new Map<string, { n: number; color: string | null }>();
      for (const r of (monthWins ?? []) as Array<{ team_name: string; color: string | null }>) {
        const cur = tally.get(r.team_name) ?? { n: 0, color: r.color };
        cur.n += 1;
        tally.set(r.team_name, cur);
      }
      let king: { name: string; color: string | null; n: number } | null = null;
      for (const [name, v] of tally) {
        if (!king || v.n > king.n) king = { name, color: v.color, n: v.n };
      }
      if (king) {
        await rawTable("vanwars_wins").upsert(
          {
            week_start: month,
            kind: "king",
            team_name: king.name,
            color: king.color,
            period: month.slice(0, 7),
          },
          { onConflict: "week_start,kind" },
        );
      }
      await qc.invalidateQueries({ queryKey: ["vanwars"] });
    } finally {
      setCrowning(false);
    }
  };
  return { crown, crowning };
}
