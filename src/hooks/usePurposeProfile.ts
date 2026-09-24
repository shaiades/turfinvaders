import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import type { ModuleKey } from "@/lib/purpose/types";
import { MODULE_KEYS } from "@/lib/purpose/questionKeys";
import {
  isMissingMigration,
  purposeRpc,
  purposeTable,
  type PurposeProfileRow,
} from "./usePurposeTable";

/** Own purpose_profiles row. null data = not started (no row yet);
 *  `missingMigration` = the purpose tables aren't in prod yet. */

export const purposeProfileKey = (userId: string) => ["purpose_profile", userId] as const;

export function usePurposeProfile(userId: string | undefined) {
  return useQuery({
    enabled: !!userId,
    queryKey: purposeProfileKey(userId ?? ""),
    staleTime: 30_000,
    retry: false,
    queryFn: async () => {
      const { data, error } = await purposeTable("purpose_profiles")
        .select("*")
        .eq("user_id", userId!)
        .maybeSingle();
      if (error) {
        if (isMissingMigration(error)) return { row: null, missingMigration: true } as const;
        throw error;
      }
      return {
        row: (data ?? null) as unknown as PurposeProfileRow | null,
        missingMigration: false,
      } as const;
    },
  });
}

/** "Start My Purpose" — get-or-create via the SECURITY DEFINER RPC (it
 *  enforces the sales_rep/owner gate and the launch flag server-side). */
export function useEnsurePurposeProfile(userId: string | undefined) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async () => {
      const { data, error } = await purposeRpc("ensure_purpose_profile");
      if (error) throw error;
      return data as unknown as PurposeProfileRow;
    },
    onSuccess: () => {
      if (userId) qc.invalidateQueries({ queryKey: purposeProfileKey(userId) });
    },
  });
}

/** Persist the resume position. Fire-and-forget from the workshop hook —
 *  losing a position write costs one step of resume accuracy, never data. */
export async function savePurposePosition(
  userId: string,
  module: ModuleKey,
  stepKey: string,
): Promise<void> {
  await purposeTable("purpose_profiles")
    .update({ current_module: MODULE_KEYS[module], current_step: stepKey })
    .eq("user_id", userId);
}

/** Final submit — the RPC re-validates completeness server-side (QA #9
 *  backstop) and stamps status/completed_at/workshop_completed. */
export function useSubmitPurpose(userId: string | undefined) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async () => {
      const { data, error } = await purposeRpc("submit_purpose_profile");
      if (error) throw error;
      return data as unknown as { ok: boolean };
    },
    onSuccess: () => {
      if (userId) qc.invalidateQueries({ queryKey: purposeProfileKey(userId) });
      qc.invalidateQueries({ queryKey: ["purpose_answers"] });
      qc.invalidateQueries({ queryKey: ["purpose_leadership"] });
    },
  });
}
