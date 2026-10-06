// Van Wars data — the weekly street race (Mon–Sat). Crew standings by war
// score ride the SAME week ladder the Solo board uses (useArcadeLadder →
// getDispatchProduction, realtime-invalidated), so a posted result moves both
// boards live. The tunable scoring config and the Wall-of-Fame history come
// from two owner-managed tables; both reads FAIL OPEN (defaults / empty) so Van
// Wars works before the migration is applied — the deliberate opposite of the
// "must throw on error" rule, because missing config must never blank the race.

import { useMemo } from "react";
import { useQuery } from "@tanstack/react-query";
import { supabase } from "@/integrations/supabase/client";
import { useArcadeLadder } from "@/hooks/useCanvasserArcade";
import {
  buildVanWarStandings,
  resolveVanWarsConfig,
  type VanWarStanding,
  type VanWarsConfig,
} from "@/lib/vanwars";

// Van Wars tables aren't in the generated Supabase types yet — raw-cast
// builder, the same pattern the gratitude / objection reads use.
const rawTable = (name: string) =>
  (supabase as unknown as { from: (t: string) => ReturnType<typeof supabase.from> }).from(name);

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

  const config = useMemo(() => resolveVanWarsConfig(cfgQ.data), [cfgQ.data]);

  const standings = useMemo(
    () =>
      buildVanWarStandings(
        ladder.rows.map((r) => ({
          teamName: r.teamName,
          teamColor: r.teamColor,
          pts: r.pts,
          sal: r.sal,
          vol: r.vol,
          sitSits: r.sit.sits,
          sitLeads: r.sit.leads,
        })),
        config,
      ),
    [ladder.rows, config],
  );

  return {
    standings,
    leader: standings[0] ?? null,
    config,
    wins: winsQ.data ?? [],
    loading: ladder.loading,
  };
}
