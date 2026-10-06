// Persisted badge trophies for the Fighter card (§1 "also fix"). Badges used to
// be a live per-scope evaluation — they lit while the condition held and went
// dark when it lapsed. Now an earned badge is SAVED (public.canvasser_badges)
// and stays lit forever, and the first time one is earned a one-time unlock
// animation plays, then the row is flipped `seen=true` so it never replays
// (persisted, not localStorage → once per player, not once per device).
//
// The caller passes the live-evaluated set (from useWrapData); this hook
// reconciles it against the saved trophies: anything newly true is written.
// GAMIFICATION ONLY — cosmetic; the arcade already trusts client-shaped
// aggregates and the table's CHECK fences badge_id. FAILS OPEN: if the table
// isn't deployed yet the query errors quietly and the UI still shows the live
// set, just without persistence or the unlock animation.

import { useEffect, useMemo, useRef } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { supabase } from "@/integrations/supabase/client";
import { BADGES, type BadgeDef, type BadgeId } from "@/lib/canvasserPay";

// canvasser_badges isn't in the generated Supabase types yet — raw-cast table
// builder (the useVanWars pattern), structurally typed for the two calls this
// hook makes so an untyped table name doesn't resolve its args to `never`.
type RawResult = Promise<{ data: unknown; error: unknown }>;
type RawBuilder = {
  select: (cols: string) => { eq: (col: string, val: string) => RawResult };
  upsert: (rows: Record<string, unknown>[], opts: { onConflict: string }) => RawResult;
};
const rawTable = (name: string): RawBuilder =>
  (supabase as unknown as { from: (t: string) => RawBuilder }).from(name);

const BADGE_BY_ID = new Map<string, BadgeDef>(BADGES.map((b) => [b.id, b]));

type BadgeRow = { badge_id: string; seen: boolean };

export type CanvasserBadges = {
  /** Every badge the player has ever earned (saved ∪ live), permanently lit. */
  earned: Set<BadgeId>;
  /** Freshly-earned badges whose unlock animation hasn't played — celebrate these. */
  unseen: BadgeDef[];
  /** Mark unlock animations as played so they never replay. */
  markSeen: (ids: BadgeId[]) => void;
  loading: boolean;
};

export function useCanvasserBadges(
  userId: string | undefined,
  liveEarned: Set<BadgeId>,
  liveReady: boolean,
): CanvasserBadges {
  const qc = useQueryClient();

  const q = useQuery({
    enabled: !!userId,
    queryKey: ["canvasser_badges", userId],
    staleTime: 60_000,
    retry: false,
    queryFn: async (): Promise<BadgeRow[]> => {
      const { data, error } = await rawTable("canvasser_badges")
        .select("badge_id, seen")
        .eq("user_id", userId!);
      if (error) throw error;
      return (data ?? []) as unknown as BadgeRow[];
    },
  });

  const upsert = useMutation({
    mutationFn: async (rows: { badge_id: BadgeId; seen: boolean }[]) => {
      if (!userId || rows.length === 0) return;
      const { error } = await rawTable("canvasser_badges").upsert(
        rows.map((r) => ({ user_id: userId, badge_id: r.badge_id, seen: r.seen })),
        { onConflict: "user_id,badge_id" },
      );
      if (error) throw error;
    },
    onSuccess: () => {
      if (userId) qc.invalidateQueries({ queryKey: ["canvasser_badges", userId] });
    },
  });

  // A stable primitive of the live set so the reconcile effect fires only when
  // the EARNED CONTENTS change, not every render (the Set identity churns).
  const liveKey = useMemo(() => [...liveEarned].sort().join(","), [liveEarned]);
  const rows = q.data;
  const writing = useRef(false);

  useEffect(() => {
    if (!userId || !liveReady || !rows || q.isFetching || writing.current) return;
    const persisted = new Set(rows.map((r) => r.badge_id));
    const liveIds = liveKey ? (liveKey.split(",") as BadgeId[]) : [];
    const toAdd = liveIds.filter((id) => !persisted.has(id));
    if (toAdd.length === 0) return;
    // First sighting (no saved rows): backfill everything already true as
    // seen=true so a veteran doesn't get a confetti storm on rollout. After
    // that, every genuinely new unlock lands seen=false and animates once.
    const firstSighting = rows.length === 0;
    writing.current = true;
    upsert.mutate(
      toAdd.map((id) => ({ badge_id: id, seen: firstSighting })),
      { onSettled: () => void (writing.current = false) },
    );
    // upsert is a stable mutation object; liveKey/rows/flags drive the effect.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [userId, liveReady, rows, q.isFetching, liveKey]);

  const earned = useMemo(() => {
    const s = new Set<BadgeId>();
    for (const r of rows ?? []) if (BADGE_BY_ID.has(r.badge_id)) s.add(r.badge_id as BadgeId);
    for (const id of liveEarned) s.add(id);
    return s;
  }, [rows, liveEarned]);

  const unseen = useMemo(
    () =>
      (rows ?? [])
        .filter((r) => !r.seen && BADGE_BY_ID.has(r.badge_id))
        .map((r) => BADGE_BY_ID.get(r.badge_id)!),
    [rows],
  );

  return {
    earned,
    unseen,
    markSeen: (ids) => {
      if (ids.length) upsert.mutate(ids.map((id) => ({ badge_id: id, seen: true })));
    },
    loading: q.isLoading,
  };
}
