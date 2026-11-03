import { useQuery } from "@tanstack/react-query";
import { supabase } from "@/integrations/supabase/client";
import {
  finalePoints,
  totalsFromLedger,
  type ArcadeLedgerRow,
  type ArcadeRules,
} from "@/lib/canvasser-arcade";

/**
 * ONE canvasser's FINAL ROUND total (engagement audit 2026-11-03, Tier 3) —
 * their finale-window ledger re-weighted by finalePoints, for the Daily Wrap
 * belt slide. Self-only and window-bounded, so no paging needed (a month of
 * one knocker's grants sits far under the 1000-row page). The tab's full
 * standings live in FinalRound.tsx; this stays a separate tiny read so the
 * wrap never pulls the whole team's ledger.
 */
export function useFinaleWrap(uid: string | undefined, rules: ArcadeRules, enabled: boolean) {
  const f = rules.finale;
  const q = useQuery({
    queryKey: ["finale_wrap", uid, f.start, f.end],
    enabled: enabled && !!uid && !!f.start && !!f.end,
    staleTime: 60_000,
    queryFn: async () => {
      const { data, error } = await supabase
        .from("canvasser_arcade_ledger")
        .select("canvasser_id, day, category, points")
        .eq("canvasser_id", uid!)
        .gte("day", f.start!)
        .lte("day", f.end!);
      if (error) throw error;
      const totals = totalsFromLedger((data ?? []) as ArcadeLedgerRow[]);
      return finalePoints(totals.byCategory.get(uid!), rules);
    },
  });
  return { points: q.data ?? 0, loading: q.isLoading };
}
