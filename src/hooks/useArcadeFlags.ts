// Client-readable arcade feature flags (no secrets — safe to query from the
// field app, unlike system_settings which holds the Monday token). FAILS OPEN
// to the spec defaults, so a missing table / RLS denial never changes behavior.
//
// coach_private (default ON): "praise public, coach private" — the Doughnut
// Zone + Suspension lists live on the captain/manager views only, off the
// public canvasser Daily Wrap and the EOD recap.

import { useQuery } from "@tanstack/react-query";
import { supabase } from "@/integrations/supabase/client";
import type { SupabaseClient } from "@supabase/supabase-js";

const rawTable = (name: string) => (supabase as unknown as SupabaseClient).from(name);

export type ArcadeFlags = { coachPrivate: boolean };
export const DEFAULT_ARCADE_FLAGS: ArcadeFlags = { coachPrivate: true };

export function useArcadeFlags(): ArcadeFlags {
  const { data } = useQuery({
    queryKey: ["arcade_flags"],
    staleTime: 5 * 60_000,
    queryFn: async () => {
      const { data, error } = await rawTable("arcade_flags")
        .select("coach_private")
        .limit(1)
        .maybeSingle();
      if (error) return null;
      return data as { coach_private: boolean | null } | null;
    },
  });
  return { coachPrivate: data?.coach_private ?? DEFAULT_ARCADE_FLAGS.coachPrivate };
}
