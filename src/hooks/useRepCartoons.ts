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

export type RepCartoon = {
  name: string;
  portrait: string | null;
  full: string | null;
  /** Turnaround spin frames (8 views at 45° — front first), when generated
   *  from the CURRENT full-body art. The stats turntable steps through them
   *  like a videogame character-select; absent → pseudo-spin fallback.
   *  Optional so ad-hoc preview literals (the admin galleries' "on the
   *  board" chips) don't have to carry it. */
  turn?: string[] | null;
};

export const repCartoonsKey = ["rep_cartoons_approved"] as const;

/** cartoon_meta.turn_urls, but only when it came from the live full art —
 *  a re-rolled fighter must never spin last season's body. */
function turnFrames(meta: unknown, fullUrl: string | null): string[] | null {
  const m = (meta ?? {}) as { turn_urls?: unknown; turn_source?: unknown };
  return fullUrl &&
    m.turn_source === fullUrl &&
    Array.isArray(m.turn_urls) &&
    m.turn_urls.length >= 4 &&
    m.turn_urls.every((u) => typeof u === "string")
    ? (m.turn_urls as string[])
    : null;
}

export function useRepCartoons() {
  return useQuery({
    queryKey: repCartoonsKey,
    staleTime: 5 * 60_000,
    queryFn: async (): Promise<Map<string, RepCartoon>> => {
      const [repRes, canvRes] = await Promise.all([
        supabase
          .from("rep_photos")
          .select("name, name_norm, cartoon_portrait_url, cartoon_full_url, cartoon_meta")
          .eq("cartoon_status", "approved"),
        supabase
          .from("canvasser_photos")
          .select("name, name_norm, cartoon_portrait_url, cartoon_full_url, cartoon_meta")
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
            turn: turnFrames(r.cartoon_meta, r.cartoon_full_url),
          });
        }
      }
      if (!repRes.error) {
        for (const r of repRes.data ?? []) {
          map.set(r.name_norm, {
            name: r.name,
            portrait: r.cartoon_portrait_url,
            full: r.cartoon_full_url,
            turn: turnFrames(r.cartoon_meta, r.cartoon_full_url),
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
