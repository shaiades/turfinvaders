import { useMutation, useQueryClient } from "@tanstack/react-query";
import { supabase } from "@/integrations/supabase/client";
import { toast } from "sonner";

type VanLite = { id: string; name: string; office_location?: string | null };

const ROSTER_KEYS = [["fleet_dispatch"], ["weekly_results"], ["payroll-ledger"], ["manage_users"]];

/** Move one person (possibly several duplicate profiles grouped under one
 *  board row) to a van or to Free Agents (null). Assigning to a van cascades
 *  the van's office onto the person, matching FleetDispatchManage. */
export function useMoveAgents(vans: VanLite[]) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async ({ ids, vanId }: { ids: string[]; vanId: string | null; name?: string }) => {
      const patch: { team_id: string | null; office_location?: string } = { team_id: vanId };
      if (vanId) {
        const van = vans.find((v) => v.id === vanId);
        if (van?.office_location) patch.office_location = van.office_location;
      }
      // .select() so an RLS-blocked update (0 rows) errors instead of
      // silently toasting success.
      const { data, error } = await supabase
        .from("profiles")
        .update(patch)
        .in("id", ids)
        .select("id");
      if (error) throw error;
      if (!data?.length) throw new Error("Move failed — you don't have permission for this agent");
    },
    onSuccess: (_d, vars) => {
      const van = vars.vanId ? vans.find((v) => v.id === vars.vanId) : null;
      toast.success(`${vars.name ?? "Agent"} moved to ${van ? van.name : "Free Agents"}`);
      for (const key of ROSTER_KEYS) qc.invalidateQueries({ queryKey: key });
    },
    onError: (e: Error) => toast.error(e.message),
  });
}

/** Rename/merge touch display_name and re-attribute history, so beyond the
 *  roster keys every query family that caches names or per-person aggregates
 *  has to refetch. */
const NAME_KEYS = [
  ...ROSTER_KEYS,
  ["all_canvassers_simple"],
  ["live_daily_action"],
  ["daily_wrap"],
  ["fleet_status"],
  ["raw_daily_logs"],
  ["monthly-volume-bonus"],
];

type SkippedAlias = { alias?: string; reason?: string };

type RenameSummary = {
  aliases_skipped?: SkippedAlias[];
  name_collision_ids?: string[];
} | null;

/** The old name failed to become an alias — Monday cards carrying it will
 *  NOT auto-route to this player. Say so instead of a silent success. */
function warnSkippedAliases(skipped: SkippedAlias[] | undefined) {
  const names = (skipped ?? [])
    .filter((s) => s.reason === "skipped_shared_name")
    .map((s) => `"${s.alias ?? "?"}"`);
  if (names.length) {
    toast.warning(
      `${names.join(", ")} is still used by another profile (possibly archived), so Monday cards with that name won't auto-route here. Combine or rename that profile too.`,
    );
  }
}

/** Rename every profile grouped under one board row. The rename_canvasser
 *  RPC records the old name in canvasser_aliases so Monday cards still
 *  carrying it keep crediting this person instead of the Bouncer minting a
 *  fresh placeholder. */
export function useRenameCanvasser() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async ({
      ids,
      newName,
    }: {
      ids: string[];
      newName: string;
      oldName?: string | null;
    }) => {
      const { data, error } = await supabase.rpc("rename_canvasser", {
        _ids: ids,
        _new_name: newName,
      });
      if (error) throw error;
      return data as RenameSummary;
    },
    onSuccess: (summary, vars) => {
      toast.success(`"${vars.oldName ?? "Player"}" is now "${vars.newName}"`);
      warnSkippedAliases(summary?.aliases_skipped);
      // The dialog blocks collisions with ACTIVE profiles; the RPC also sees
      // archived same-named ones, which the exact-match webhook tier can
      // still credit — worth a heads-up.
      if (summary?.name_collision_ids?.length) {
        toast.warning(
          `Another profile also carries "${vars.newName}" — the board shows them as one row. Use Combine to truly merge their histories.`,
        );
      }
      for (const key of NAME_KEYS) qc.invalidateQueries({ queryKey: key });
    },
    onError: (e: Error) => toast.error(e.message ?? "Rename failed"),
  });
}

type MergeSummary = {
  aliases_skipped?: SkippedAlias[];
  keep_name_result?: RenameSummary;
  moved?: Record<string, number>;
} | null;

/** Combine duplicate identities: every loser profile's history moves onto
 *  the keeper (counters sum where both logged the same day), the losers'
 *  names become aliases of the keeper, and the loser rows are deleted
 *  (placeholders) or archived (real accounts). keepName lets the OTHER
 *  side's name survive on the keeper (applied atomically in the RPC).
 *  Irreversible. */
export function useMergeCanvassers() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async ({
      loserIds,
      keeperId,
      keepName,
    }: {
      loserIds: string[];
      keeperId: string;
      keepName?: string | null;
      keeperName?: string;
      loserName?: string;
    }) => {
      const { data, error } = await supabase.rpc("merge_canvassers", {
        _loser_ids: loserIds,
        _keeper: keeperId,
        _keep_name: keepName ?? undefined,
      });
      if (error) throw error;
      return data as MergeSummary;
    },
    onSuccess: (summary, vars) => {
      const parts = Object.entries(summary?.moved ?? {})
        .filter(([, n]) => n > 0)
        .map(([k, n]) => `${n} ${k.replace(/_/g, " ")}`);
      toast.success(
        `Combined "${vars.loserName ?? "player"}" into "${vars.keeperName ?? "player"}"` +
          (parts.length ? ` — moved ${parts.join(", ")}` : ""),
      );
      warnSkippedAliases([
        ...(summary?.aliases_skipped ?? []),
        ...(summary?.keep_name_result?.aliases_skipped ?? []),
      ]);
      // The dialog only sees ACTIVE profiles; the nested rename also sees
      // archived same-named ones, which the exact-match webhook tier can
      // still credit.
      if (summary?.keep_name_result?.name_collision_ids?.length) {
        toast.warning(
          `Another (possibly archived) profile also carries "${vars.keeperName ?? "that name"}" — Monday cards may still credit it. Check Archived Agents.`,
        );
      }
      for (const key of NAME_KEYS) qc.invalidateQueries({ queryKey: key });
    },
    onError: (e: Error) => toast.error(e.message ?? "Combine failed"),
  });
}

/** "Remove from roster" — archive via the archive_agent RPC (is_active=false,
 *  team_id=null, history untouched; reversible from Archived Agents). */
export function useArchiveAgents() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async ({ ids }: { ids: string[]; name?: string }) => {
      for (const id of ids) {
        const { error } = await supabase.rpc("archive_agent", { _user_id: id });
        if (error) throw error;
      }
    },
    onSuccess: (_d, vars) => {
      toast.success(
        `${vars.name ?? "Agent"} removed from roster — history kept. Reactivate from Archived Agents.`,
      );
      for (const key of ROSTER_KEYS) qc.invalidateQueries({ queryKey: key });
    },
    onError: (e: Error) => toast.error(e.message ?? "Failed to remove"),
  });
}
