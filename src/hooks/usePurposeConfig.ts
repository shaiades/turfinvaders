import { useEffect } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import {
  isMissingMigration,
  purposeTable,
  type PurposeConfigRow,
} from "./usePurposeTable";

/** purpose_admin_config singleton — the My Purpose launch flag lives here.
 *  Ships false: the two owners walk the workshop first; the Purpose
 *  Leadership "Open to sales team" toggle flips it live. */

export const purposeConfigKey = () => ["purpose_admin_config"] as const;

/** Warm cache so a rep's bottom bar doesn't pop in on every cold load —
 *  AppShell seeds initialData from this and writes the resolved value back.
 *  Pre-launch the cached false means zero layout change for reps. */
const ENABLED_CACHE_KEY = "ti_purpose_enabled_v1";

export function readCachedPurposeEnabled(): boolean {
  try {
    return localStorage.getItem(ENABLED_CACHE_KEY) === "1";
  } catch {
    return false;
  }
}

function writeCachedPurposeEnabled(enabled: boolean) {
  try {
    localStorage.setItem(ENABLED_CACHE_KEY, enabled ? "1" : "0");
  } catch {
    /* best effort */
  }
}

export function usePurposeConfig(enabled: boolean) {
  const query = useQuery({
    enabled,
    queryKey: purposeConfigKey(),
    staleTime: 30_000,
    retry: false,
    queryFn: async () => {
      const { data, error } = await purposeTable("purpose_admin_config")
        .select("*")
        .eq("id", true)
        .maybeSingle();
      if (error) {
        // Migration not applied yet → behave as feature-off, don't error-loop.
        if (isMissingMigration(error)) return null;
        throw error;
      }
      return (data ?? null) as unknown as PurposeConfigRow | null;
    },
  });
  const repEnabled = query.data?.sales_rep_feature_enabled === true;
  useEffect(() => {
    if (query.data !== undefined && query.data !== null) writeCachedPurposeEnabled(repEnabled);
  }, [query.data, repEnabled]);
  return query;
}

export function useSavePurposeConfig() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (patch: Partial<PurposeConfigRow>) => {
      const { error } = await purposeTable("purpose_admin_config")
        .update(patch as Record<string, unknown>)
        .eq("id", true);
      if (error) throw error;
    },
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: purposeConfigKey() });
    },
  });
}
