// Van Wars data — the weekly street race (Mon–Sat). Crew standings by war
// score (leads set per active knocker — see src/lib/vanwars.ts) ride the SAME
// week ladder the Solo board uses (useArcadeLadder → getDispatchProduction,
// 60s-polled), so a posted result moves both boards. The Wall-of-Fame history
// read FAILS OPEN (empty) so Van Wars renders before migrations land — the
// deliberate opposite of the "must throw on error" rule, because a missing
// table must never blank the race. Crowning is no longer a button: the
// Saturday 6 PM PT cron (src/routes/api/internal/crown-vanwars.ts) records
// the winner into vanwars_wins and announces it on the Street Feed.

import { useMemo } from "react";
import { useQuery } from "@tanstack/react-query";
import { supabase } from "@/integrations/supabase/client";
import type { SupabaseClient } from "@supabase/supabase-js";
import { useArcadeLadder } from "@/hooks/useCanvasserArcade";
import { buildVanWarStandings, type VanWarStanding } from "@/lib/vanwars";

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
  /** Wall of Fame: recent weekly winners + monthly kings, newest first. */
  wins: VanWarWin[];
  loading: boolean;
};

export function useVanWars(): VanWarsData {
  const ladder = useArcadeLadder("week");

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
  // the team name for crews without one. Two light reads of standard typed
  // tables → teamId → captain first name.
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

  const captainByTeam = useMemo(() => captainsQ.data ?? {}, [captainsQ.data]);

  const standings = useMemo(
    () =>
      buildVanWarStandings(
        ladder.rows.map((r) => ({
          teamId: r.teamId,
          label: (r.teamId && captainByTeam[r.teamId]) || r.teamName || "Unassigned",
          teamName: r.teamName,
          teamColor: r.teamColor,
          ld: r.ld,
          drs: r.drs,
          pts: r.pts,
          vol: r.vol,
          sitSits: r.sit.sits,
          sitLeads: r.sit.leads,
        })),
      ),
    [ladder.rows, captainByTeam],
  );

  return {
    standings,
    leader: standings.find((s) => s.ranked) ?? null,
    wins: winsQ.data ?? [],
    loading: ladder.loading,
  };
}
