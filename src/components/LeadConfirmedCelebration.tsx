import { useCallback, useEffect, useRef } from "react";
import confetti from "canvas-confetti";
import { supabase } from "@/integrations/supabase/client";
import { makeBeeper } from "@/components/intro-fx";
import { rewardToast } from "@/lib/reward-toast";
import { CONFETTI_COLORS } from "@/components/tutorial/CanvasserTutorial";

/**
 * LEAD CONFIRMED — the payoff moment. Until now the desk verifying a lead
 * produced zero feedback on the knocker's phone (a status pill quietly
 * recolored on the Mission tab they weren't looking at). Mounted app-wide
 * in AppShell for canvasser-tier + captains; renders nothing.
 *
 * Signal: realtime INSERT on lead_events — fire_lead_event_on_confirm
 * (migration 20260718173539) inserts exactly on the not-confirmed→confirmed
 * transition, for BOTH desk confirms and Monday-webhook confirms, with
 * occurred_at ≈ now (CSV backfills arrive backdated and fall to the recency
 * fence). Deliberately NOT the leads table: no replica identity means no
 * old-status on UPDATE payloads, and reviewed_at is desk-only.
 *
 * Guards: 5-minute occurred_at fence (backfills/CSV imports) + a
 * sessionStorage seen-ring (realtime reconnect replays). Known accepted
 * gap, same as the hype ticker: team-less Free Agents get no event (the
 * trigger's team_id IS NOT NULL guard).
 *
 * Preview: `?lead_confirm_demo=1` fires the visual once, zero DB traffic
 * (piggy_demo precedent).
 */

const RECENT_MS = 5 * 60_000;
const SEEN_KEY = "ti_lead_confirm_seen:v1";
const SEEN_CAP = 50;

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

export function LeadConfirmedCelebration({ userId }: { userId: string }) {
  const beepRef = useRef<ReturnType<typeof makeBeeper> | null>(null);

  const celebrate = useCallback(() => {
    confetti({
      particleCount: 140,
      spread: 70,
      startVelocity: 40,
      origin: { y: 0.65 },
      colors: CONFETTI_COLORS,
      zIndex: 10500,
      disableForReducedMotion: true,
    });
    rewardToast("🎉 LEAD CONFIRMED", {
      description: "The desk verified it — that lead counts.",
    });
    // Piggy's two-note ka-ching (best-effort; silent until audio unlocks).
    beepRef.current ??= makeBeeper();
    beepRef.current(1318, 70, 0, "sine");
    beepRef.current(1760, 260, 80, "sine");
  }, []);

  useEffect(() => {
    const ch = supabase
      .channel(`lead-confirmed-${userId}`)
      .on(
        "postgres_changes",
        {
          event: "INSERT",
          schema: "public",
          table: "lead_events",
          filter: `canvasser_id=eq.${userId}`,
        },
        (payload) => {
          const row = payload.new as { id: string; occurred_at: string };
          if (!row?.id) return;
          if (Date.now() - Date.parse(row.occurred_at) > RECENT_MS) return;
          if (hasSeen(row.id)) return;
          markSeen(row.id);
          celebrate();
        },
      )
      .subscribe();
    return () => {
      void supabase.removeChannel(ch);
    };
  }, [userId, celebrate]);

  // Demo lever — parsed post-mount (SSR hydration safety, piggy precedent).
  const demoFiredRef = useRef(false);
  useEffect(() => {
    if (demoFiredRef.current) return;
    const params = new URLSearchParams(window.location.search);
    if (params.get("lead_confirm_demo") !== "1") return;
    demoFiredRef.current = true;
    const id = window.setTimeout(celebrate, 800);
    return () => window.clearTimeout(id);
  }, [celebrate]);

  return null;
}
