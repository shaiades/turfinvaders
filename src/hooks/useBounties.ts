// §6 Bounties — time-boxed point boosts. Reads the active ones (window around
// now) for the field banner; managers create them. Fails open to empty. Since
// the 2026-10-15 audit a bounty means exactly one thing: multiplier× arcade
// points per confirmed lead set in the window (scored in
// getDispatchProduction.bountyPts). The old sit/sale/doors category is legacy
// storage only — the column is NOT NULL in the table, so writes pin it to
// 'sit', and nothing reads it for scoring.

import { useQuery } from "@tanstack/react-query";
import { supabase } from "@/integrations/supabase/client";
import type { SupabaseClient } from "@supabase/supabase-js";

const rawTable = (name: string) => (supabase as unknown as SupabaseClient).from(name);

export type Bounty = {
  id: string;
  label: string;
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
        .select("id, label, multiplier, starts_at, ends_at")
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
  multiplier: number;
  minutes: number;
  userId: string;
}): Promise<void> {
  await rawTable("bounties").insert({
    label: b.label,
    // Legacy NOT NULL column — pinned, unread by scoring (see module note).
    category: "sit",
    multiplier: b.multiplier,
    ends_at: new Date(Date.now() + b.minutes * 60_000).toISOString(),
    created_by: b.userId,
  });
}
