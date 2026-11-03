// §6 Bounties — time-boxed point boosts. Reads the active ones (window around
// now) for the field banner; managers create them. Fails open to empty.
// Scoring (game only, never pay):
//  · score_v2 OFF (legacy): multiplier× arcade points per confirmed lead set
//    in the window (getDispatchProduction.bountyPts) — category is ignored,
//    so the composer only offers "leads".
//  · score_v2 ON (Tier 2, 2026-11-03): the SQL triggers honor the category
//    per grant (arcade_bounty_mult) — doors / leads / sit / sale all score,
//    and the composer opens the full picker.

import { useQuery } from "@tanstack/react-query";
import { supabase } from "@/integrations/supabase/client";
import type { SupabaseClient } from "@supabase/supabase-js";

const rawTable = (name: string) => (supabase as unknown as SupabaseClient).from(name);

export type BountyCategory = "doors" | "leads" | "sit" | "sale";

export type Bounty = {
  id: string;
  label: string;
  /** What the multiplier applies to. Legacy scoring (score_v2 off) only ever
   *  multiplies leads; the v2 triggers honor the category per grant
   *  (arcade_bounty_mult), so the composer only offers the full set once the
   *  flag is on. */
  category: BountyCategory;
  multiplier: number;
  starts_at: string;
  ends_at: string;
};

export function useActiveBounties(): Bounty[] {
  const { data } = useQuery({
    queryKey: ["bounties"],
    staleTime: 30_000,
    refetchInterval: 60_000,
    queryFn: async () => {
      const { data, error } = await rawTable("bounties")
        .select("id, label, category, multiplier, starts_at, ends_at")
        .gt("ends_at", new Date().toISOString())
        .order("ends_at", { ascending: true });
      if (error) return [] as Bounty[];
      return (data ?? []) as unknown as Bounty[];
    },
  });
  const now = Date.now();
  return (data ?? []).filter(
    (b) => new Date(b.starts_at).getTime() <= now && new Date(b.ends_at).getTime() > now,
  );
}

/** Create a bounty running for `minutes` from now. Managers only (RLS). */
export async function createBounty(b: {
  label: string;
  category: BountyCategory;
  multiplier: number;
  minutes: number;
  userId: string;
}): Promise<void> {
  await rawTable("bounties").insert({
    label: b.label,
    category: b.category,
    multiplier: b.multiplier,
    ends_at: new Date(Date.now() + b.minutes * 60_000).toISOString(),
    created_by: b.userId,
  });
}
