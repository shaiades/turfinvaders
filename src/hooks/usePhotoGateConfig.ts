// The "Remind me later" escape-valve flag for the blocking photo gate. Lives in
// system_settings, which is OWNER-only under RLS, so every other role reads it
// through a service-role server fn. Defaults to false (fully blocking) on any
// miss — including before the migration that adds the column has been applied.

import { useQuery } from "@tanstack/react-query";
import { getPhotoGateConfigFn } from "@/lib/profile-photo.functions";

export function usePhotoGateConfig(enabled: boolean) {
  return useQuery({
    queryKey: ["photo_gate_config"],
    enabled,
    staleTime: 5 * 60_000,
    queryFn: async (): Promise<{ remindLaterEnabled: boolean }> => {
      try {
        return await getPhotoGateConfigFn();
      } catch {
        return { remindLaterEnabled: false };
      }
    },
  });
}
