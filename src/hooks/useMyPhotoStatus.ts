// Does the signed-in player have a profile photo yet? (owner directive
// 2026-10-06). The blocking gate turns on this one boolean, computed entirely
// client-side from data the player can already read under RLS:
//
//   hasPhoto = an APPROVED fighter cartoon exists for my name (reps via
//              rep_photos / Monday, canvassers via canvasser_photos / selfie)
//              OR I have uploaded a selfie of my own (my canvasser_photos row
//              has a photo_path), whatever the cartoon's state.
//
// The second clause is deliberate: the gate's job is to COLLECT a photo, not to
// wait on Gemini. The selfie row is written the instant the upload lands, so a
// player who did their part is never re-trapped if cartoon generation is slow,
// rate-limited, or down (the "never trap them in a dead screen" rule). RLS lets
// a user read their own canvasser_photos row at any status, so this needs no
// privileged server call.

import { useQuery } from "@tanstack/react-query";
import { supabase } from "@/integrations/supabase/client";
import { useRepCartoons, cartoonFor } from "@/hooks/useRepCartoons";

export const myPhotoStatusKey = ["my_photo_selfie"] as const;

export function useMyPhotoStatus(
  userId: string | null | undefined,
  realDisplayName: string | null | undefined,
): { hasPhoto: boolean; loading: boolean } {
  const cartoonsQuery = useRepCartoons();
  const cartoons = cartoonsQuery.data;

  const selfieQuery = useQuery({
    queryKey: [...myPhotoStatusKey, userId ?? "anon"],
    enabled: !!userId,
    staleTime: 60_000,
    queryFn: async (): Promise<boolean> => {
      const { data, error } = await supabase
        .from("canvasser_photos")
        .select("photo_path")
        .eq("profile_id", userId!)
        .maybeSingle();
      if (error) return false;
      return !!data?.photo_path;
    },
  });

  const mine = cartoonFor(cartoons, realDisplayName);
  const hasApprovedFighter = !!mine?.portrait || !!mine?.full;
  const hasSelfie = selfieQuery.data === true;

  // Only consider it loaded once BOTH signals have resolved — a half-loaded
  // "false" must never flash the full-screen gate at someone who has a photo.
  const loading = cartoons === undefined || (!!userId && selfieQuery.isLoading);

  return { hasPhoto: hasApprovedFighter || hasSelfie, loading };
}
