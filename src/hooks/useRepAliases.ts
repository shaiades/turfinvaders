import { useQuery } from "@tanstack/react-query";
import { supabase } from "@/integrations/supabase/client";
import { normalizeName } from "@/lib/utils";

/**
 * Handle→board-name aliases for Close Kombat identity (owner directive
 * 2026-10-05). Returns a Map keyed by NORMALIZED profiles.display_name, value
 * = the raw canonical board name — the exact shape buildRepMatcher's alias
 * tier wants. Pass `useRepAliases().data` straight into buildRepMatcher.
 *
 * Keyed by the LIVE display_name (joined here, never stored on the alias row)
 * so a profile rename can't strand its alias, and View-As — which swaps
 * display_name but keeps the owner's user id — resolves the same way a real
 * sign-in does. Aliases are a tiny, rarely-changing set, so two flat reads
 * (the alias rows, then those profiles' names) beat a typed embed the
 * generated Relationships don't describe.
 */

export const repAliasesKey = ["kombat_rep_aliases"] as const;

export function useRepAliases() {
  return useQuery({
    queryKey: repAliasesKey,
    staleTime: 5 * 60_000,
    queryFn: async (): Promise<Map<string, string>> => {
      const { data: aliasRows, error } = await supabase
        .from("kombat_rep_aliases")
        .select("profile_id, board_name");
      if (error || !aliasRows || aliasRows.length === 0) return new Map();

      const ids = [...new Set(aliasRows.map((r) => r.profile_id))];
      const { data: profs } = await supabase
        .from("profiles")
        .select("id, display_name")
        .in("id", ids);
      const nameById = new Map((profs ?? []).map((p) => [p.id, p.display_name]));

      const map = new Map<string, string>();
      for (const r of aliasRows) {
        const dn = nameById.get(r.profile_id);
        const key = normalizeName(dn);
        if (key !== "") map.set(key, r.board_name);
      }
      return map;
    },
  });
}
