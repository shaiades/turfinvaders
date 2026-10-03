import { useQuery } from "@tanstack/react-query";
import { supabase } from "@/integrations/supabase/client";
import { normalizeName } from "@/lib/utils";

/**
 * Approved Street Fighter cartoons, keyed by normalized name — the join to the
 * name-keyed boards. Covers BOTH casts: sales reps (rep_photos, Monday-sourced)
 * and canvassers (canvasser_photos, selfie-sourced). Only 'approved' rows are
 * returned (RLS also enforces it), so nothing pending/awkward ever reaches the
 * team. Each source is read independently and tolerates its own failure (e.g. a
 * table that hasn't been migrated yet) so one missing table never blanks the
 * other — a miss just degrades that name to RepAvatar's initials fallback.
 */

export type RepCartoon = { name: string; portrait: string | null; full: string | null };

export const repCartoonsKey = ["rep_cartoons_approved"] as const;

export function useRepCartoons() {
  return useQuery({
    queryKey: repCartoonsKey,
    staleTime: 5 * 60_000,
    queryFn: async (): Promise<Map<string, RepCartoon>> => {
      const [repRes, canvRes] = await Promise.all([
        supabase
          .from("rep_photos")
          .select("name, name_norm, cartoon_portrait_url, cartoon_full_url")
          .eq("cartoon_status", "approved"),
        supabase
          .from("canvasser_photos")
          .select("name, name_norm, cartoon_portrait_url, cartoon_full_url")
          .eq("cartoon_status", "approved"),
      ]);
      const map = new Map<string, RepCartoon>();
      // Canvassers first, then reps override on a name collision (reps are the
      // longer-standing cast). A real person is one or the other, so a clash is
      // rare — this just makes the tie deterministic.
      if (!canvRes.error) {
        for (const r of canvRes.data ?? []) {
          map.set(r.name_norm, {
            name: r.name,
            portrait: r.cartoon_portrait_url,
            full: r.cartoon_full_url,
          });
        }
      }
      if (!repRes.error) {
        for (const r of repRes.data ?? []) {
          map.set(r.name_norm, {
            name: r.name,
            portrait: r.cartoon_portrait_url,
            full: r.cartoon_full_url,
          });
        }
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
