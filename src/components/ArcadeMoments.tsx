// Arcade Score v2 moment dispatcher (engagement audit 2026-11-03, Tier 2):
// ONE realtime channel on canvasser_arcade_ledger filtered to the signed-in
// canvasser, mounted ONCE in AppShell — never per-screen (realtime incident
// 2026-10-06: six per-mount subscriptions per client took the project down;
// this file and LeadConfirmedCelebration are the app's only fixed channels).
// Every server-granted point becomes feedback within a second of the action:
//
//   talk            crit → 💥 CRITICAL HIT (chest sound + toast)
//                   combo milestone (3/5/8+) → 🔥 COMBO xN (coin sound)
//                   plain talk → nothing here (the piggy bank already coins)
//   lead_set        ⚡ +N PTS toast (LeadStrikeFx owns the big submit moment)
//   lead_confirmed  ✅ +N PTS toast (LeadConfirmedCelebration owns confetti)
//   sit             THE K.O. — full-screen SitKoFx with your fighter
//   sale            💰 +N PTS toast (the gold FLAWLESS VICTORY rides the
//                   lead_events 'sold' row, which carries the dollar amount)
//   super           ⚡ SUPER UNLEASHED (levelup sound + confetti)
//
// Also invalidates the HUD meter/combo queries so the strip ticks instantly.
// Renders only the active SitKoFx; everything else is toasts. Guards:
// 5-minute created_at fence + a sessionStorage seen-ring (reconnect replays).

import { useEffect, useRef, useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { supabase } from "@/integrations/supabase/client";
import { arcadeScoreKeys } from "@/hooks/useArcadeScore";
import { playArcadeSound, haptic } from "@/lib/arcade-fx";
import { rewardToast } from "@/lib/reward-toast";
import { SitKoFx } from "@/components/SitKoFx";
import { useCanvasserProfile } from "@/hooks/useCanvasserProfile";
import { useRepCartoons, cartoonFor } from "@/hooks/useRepCartoons";

const RECENT_MS = 5 * 60_000;
const SEEN_KEY = "ti_arcade_moment_seen:v1";
const SEEN_CAP = 80;
const COMBO_MILESTONES = new Set([3, 5, 8, 12, 20]);

function hasSeen(id: string): boolean {
  try {
    const ring = JSON.parse(window.sessionStorage.getItem(SEEN_KEY) ?? "[]") as string[];
    return ring.includes(id);
  } catch {
    return false;
  }
}
function markSeen(id: string) {
  try {
    const ring = JSON.parse(window.sessionStorage.getItem(SEEN_KEY) ?? "[]") as string[];
    ring.push(id);
    window.sessionStorage.setItem(SEEN_KEY, JSON.stringify(ring.slice(-SEEN_CAP)));
  } catch {
    /* private mode — the recency fence still bounds refires */
  }
}

type LedgerPayload = {
  id: string;
  category: string;
  points: number | null;
  created_at: string;
  meta: { crit?: boolean; combo?: number; bounty?: number } | null;
};

export function ArcadeMoments({ userId }: { userId: string }) {
  const qc = useQueryClient();
  const profile = useCanvasserProfile(userId);
  const cartoons = useRepCartoons().data;
  const [sitKo, setSitKo] = useState<{ points: number } | null>(null);
  const sitKoRef = useRef(false);

  useEffect(() => {
    const ch = supabase
      .channel(`arcade-moments-${userId}`)
      .on(
        "postgres_changes",
        {
          event: "INSERT",
          schema: "public",
          table: "canvasser_arcade_ledger",
          filter: `canvasser_id=eq.${userId}`,
        },
        (payload) => {
          const row = payload.new as LedgerPayload;
          if (!row?.id) return;
          if (Date.now() - Date.parse(row.created_at) > RECENT_MS) return;
          if (hasSeen(row.id)) return;
          markSeen(row.id);

          // The HUD meter/combo tick the moment the grant lands.
          void qc.invalidateQueries({ queryKey: arcadeScoreKeys.today(userId) });
          void qc.invalidateQueries({ queryKey: arcadeScoreKeys.combo(userId) });

          const pts = Math.round(Number(row.points ?? 0));
          switch (row.category) {
            case "talk": {
              if (row.meta?.crit) {
                playArcadeSound("chest");
                haptic([30, 40, 30, 40, 60]);
                rewardToast(`💥 CRITICAL HIT — +${pts} pts`, {
                  description: "The arcade gods smiled on that door.",
                });
              } else if (row.meta?.combo && COMBO_MILESTONES.has(row.meta.combo)) {
                playArcadeSound("coin");
                haptic([15, 25, 15]);
                rewardToast(`🔥 COMBO x${row.meta.combo}`, {
                  description: "Keep the chain alive — don't let it drop.",
                });
              }
              break;
            }
            case "lead_set":
              rewardToast(`⚡ +${pts} PTS — lead on the board`);
              break;
            case "lead_confirmed":
              // LeadConfirmedCelebration owns the confetti; this is the score.
              rewardToast(`✅ +${pts} PTS — confirmed lead`);
              break;
            case "sit": {
              // THE K.O. — one at a time; a double-sit day queues no second
              // overlay (the toast still says the points).
              if (!sitKoRef.current) {
                sitKoRef.current = true;
                setSitKo({ points: pts });
              } else {
                rewardToast(`K.O.! Another sit — +${pts} pts`);
              }
              break;
            }
            case "sale":
              playArcadeSound("coin");
              rewardToast(`💰 +${pts} PTS — SALE`);
              break;
            case "super":
              playArcadeSound("levelup");
              haptic([40, 50, 40, 50, 80]);
              rewardToast(`⚡ SUPER UNLEASHED — +${pts} pts`, {
                description: "Daily target smashed. You're in the bonus zone.",
              });
              import("canvas-confetti")
                .then((m) =>
                  m.default({
                    particleCount: 90,
                    spread: 100,
                    startVelocity: 40,
                    origin: { y: 0.5 },
                    colors: ["#22d3ee", "#f5c518", "#ffffff"],
                    disableForReducedMotion: true,
                  }),
                )
                .catch(() => {});
              break;
          }
        },
      )
      .subscribe();
    return () => {
      void supabase.removeChannel(ch);
    };
  }, [userId, qc]);

  if (!sitKo) return null;
  return (
    <SitKoFx
      points={sitKo.points}
      cartoon={cartoonFor(cartoons, profile.data?.display_name ?? null)}
      onDone={() => {
        sitKoRef.current = false;
        setSitKo(null);
      }}
    />
  );
}
