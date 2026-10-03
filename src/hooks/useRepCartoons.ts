import { useQuery } from "@tanstack/react-query";
import { supabase } from "@/integrations/supabase/client";
import { normalizeName } from "@/lib/utils";

/**
 * Approved Street Fighter cartoons, keyed by normalized rep name — the join to
 * the name-keyed Kombat board. Only 'approved' rows are returned (RLS also
 * enforces it), so nothing pending/awkward ever reaches the team. Pre-migration
 * or any read error degrades to an empty map → RepAvatar falls back to initials.
 */

export type RepCartoon = { name: string; portrait: string | null; full: string | null };

export const repCartoonsKey = ["rep_cartoons_approved"] as const;

export function useRepCartoons() {
  return useQuery({
    queryKey: repCartoonsKey,
    staleTime: 5 * 60_000,
    queryFn: async (): Promise<Map<string, RepCartoon>> => {
      const { data, error } = await supabase
        .from("rep_photos")
        .select("name, name_norm, cartoon_portrait_url, cartoon_full_url")
        .eq("cartoon_status", "approved");
      if (error) return new Map();
      const map = new Map<string, RepCartoon>();
      for (const r of data ?? []) {
        map.set(r.name_norm, {
          name: r.name,
          portrait: r.cartoon_portrait_url,
          full: r.cartoon_full_url,
        });
      }
      return map;
    },
  });
}

/** Resolve a board rep_name to its cartoon through normalized-name matching. */
export function cartoonFor(
  map: Map<string, RepCartoon> | undefined,
  repName: string | null | undefined,
): RepCartoon | undefined {
  if (!map || !repName) return undefined;
  return map.get(normalizeName(repName));
}
