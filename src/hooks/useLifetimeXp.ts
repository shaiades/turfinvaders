import { useEffect } from "react";
import { useQuery } from "@tanstack/react-query";
import { supabase } from "@/integrations/supabase/client";
import { levelForXp, xpFor, type LevelState } from "@/lib/canvasserPay";
import { playArcadeSound, haptic } from "@/lib/arcade-fx";
import { rewardToast } from "@/lib/reward-toast";

/**
 * Lifetime arcade XP + level (engagement audit 2026-11-03, Tier 1 §1.4 —
 * un-retiring the Phase 4 §1 cosmetic level as a SECOND strip next to the
 * pay tier, not a replacement: the pay tier stays the money axis, the level
 * is the identity/status axis that only ever climbs).
 *
 * Same arcade_lifetime_xp RPC + query key as useWrapData, so mounting this
 * beside a Wrap or Fighter card adds zero fetches. SELF-scoped server-side
 * (auth.uid()); callers in a View-As preview pass enabled=false.
 *
 * Level-up moment: the last-seen level is remembered per device
 * (localStorage); when the fetched level exceeds it we fire the levelup
 * chiptune + a title toast, once. Cosmetic only — XP never touches pay.
 */

const LEVEL_SEEN_KEY = "ti_arcade_level_seen:v1";

function lastSeenLevel(uid: string): number | null {
  try {
    const map = JSON.parse(window.localStorage.getItem(LEVEL_SEEN_KEY) ?? "{}") as Record<
      string,
      number
    >;
    return typeof map[uid] === "number" ? map[uid] : null;
  } catch {
    return null;
  }
}

function markSeenLevel(uid: string, level: number) {
  try {
    const map = JSON.parse(window.localStorage.getItem(LEVEL_SEEN_KEY) ?? "{}") as Record<
      string,
      number
    >;
    map[uid] = level;
    window.localStorage.setItem(LEVEL_SEEN_KEY, JSON.stringify(map));
  } catch {
    /* private mode — the moment just might replay on another visit */
  }
}

export function useLifetimeXp(
  uid: string | undefined,
  opts: { enabled?: boolean; celebrate?: boolean } = {},
): { level: LevelState | null; xp: number | null; loading: boolean } {
  const enabled = (opts.enabled ?? true) && !!uid;
  const q = useQuery({
    enabled,
    queryKey: ["arcade_lifetime_xp", uid],
    staleTime: 5 * 60_000,
    retry: false,
    queryFn: async (): Promise<{ appts: number; sits: number; solds: number }> => {
      const { data, error } = await (
        supabase as unknown as {
          rpc: (fn: string) => Promise<{ data: unknown; error: unknown }>;
        }
      ).rpc("arcade_lifetime_xp");
      if (error) throw error;
      const row = (Array.isArray(data) ? data[0] : data) as
        | { appts?: number; sits?: number; solds?: number }
        | null
        | undefined;
      return {
        appts: Number(row?.appts ?? 0),
        sits: Number(row?.sits ?? 0),
        solds: Number(row?.solds ?? 0),
      };
    },
  });

  const xp = q.data ? xpFor(q.data) : null;
  const level = xp == null ? null : levelForXp(xp);

  // LEVEL UP — once per new level per device. First visit just records the
  // baseline silently (no retroactive fanfare for levels earned pre-feature).
  useEffect(() => {
    if (!uid || !level || !(opts.celebrate ?? false)) return;
    const seen = lastSeenLevel(uid);
    if (seen == null) {
      markSeenLevel(uid, level.level);
      return;
    }
    if (level.level > seen) {
      markSeenLevel(uid, level.level);
      playArcadeSound("levelup");
      haptic([30, 40, 30, 40, 60]);
      rewardToast(`⬆️ LEVEL ${level.level} — ${level.title.toUpperCase()}`, {
        description: "Your fighter just ranked up. Lifetime grind, locked in.",
        duration: 7000,
      });
    }
  }, [uid, level, opts.celebrate]);

  return { level, xp, loading: enabled ? q.isLoading : false };
}
