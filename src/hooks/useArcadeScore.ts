import { useQuery } from "@tanstack/react-query";
import { supabase } from "@/integrations/supabase/client";
import { laTodayISO } from "@/lib/dates";
import {
  comboDisplay,
  mergeArcadeRules,
  superMeterState,
  type ArcadeRules,
  type ComboDisplay,
  type SuperMeterState,
} from "@/lib/canvasser-arcade";

/**
 * Arcade Score v2 self-state (engagement audit 2026-11-03, Tier 2): today's
 * ledger points, the super meter and the live combo chain for ONE canvasser.
 * 60s polling like the ladder (realtime incident 2026-10-06) — ArcadeMoments'
 * single shared channel invalidates these keys the instant a grant lands, so
 * the poll is only the fallback. All reads; the server grants every point.
 */

export const arcadeScoreKeys = {
  rules: ["arcade_rules"] as const,
  today: (uid: string) => ["arcade_score", "today", uid] as const,
  combo: (uid: string) => ["arcade_combo", uid] as const,
  flag: ["arcade_flags", "score_v2"] as const,
};

export function useArcadeScore(uid: string | undefined): {
  enabled: boolean;
  rules: ArcadeRules;
  todayPoints: number;
  meter: SuperMeterState;
  combo: ComboDisplay;
  /** Raw server row, for callers that re-project the drain timer each second
   *  (comboDisplay with a live `nowMs`) instead of waiting for a refetch. */
  comboState: { day: string; count: number; last_at: string } | null;
  loading: boolean;
} {
  const today = laTodayISO();

  const flagQ = useQuery({
    queryKey: arcadeScoreKeys.flag,
    staleTime: 5 * 60_000,
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
  const on = !!flagQ.data && !!uid;

  const rulesQ = useQuery({
    queryKey: arcadeScoreKeys.rules,
    enabled: on,
    staleTime: 5 * 60_000,
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
  const rules = rulesQ.data ?? mergeArcadeRules(null);

  const todayQ = useQuery({
    queryKey: arcadeScoreKeys.today(uid ?? "none"),
    enabled: on,
    refetchInterval: 60_000,
    queryFn: async () => {
      const { data, error } = await supabase
        .from("canvasser_arcade_ledger")
        .select("points")
        .eq("canvasser_id", uid!)
        .eq("day", today);
      if (error) throw error;
      return (data ?? []).reduce((a, r) => a + Number(r.points ?? 0), 0);
    },
  });

  const comboQ = useQuery({
    queryKey: arcadeScoreKeys.combo(uid ?? "none"),
    enabled: on,
    refetchInterval: 60_000,
    queryFn: async () => {
      const { data, error } = await supabase
        .from("canvasser_combo_state")
        .select("day, count, last_at")
        .eq("canvasser_id", uid!)
        .maybeSingle();
      if (error) throw error;
      return data ?? null;
    },
  });

  const todayPoints = todayQ.data ?? 0;
  return {
    enabled: on,
    rules,
    todayPoints,
    meter: superMeterState(todayPoints, rules),
    combo: comboDisplay(comboQ.data, rules),
    comboState: comboQ.data ?? null,
    loading: on && (todayQ.isLoading || rulesQ.isLoading),
  };
}
