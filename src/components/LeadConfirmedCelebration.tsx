import { useCallback, useEffect, useRef } from "react";
import confetti from "canvas-confetti";
import { supabase } from "@/integrations/supabase/client";
import { makeBeeper } from "@/components/intro-fx";
import { rewardToast } from "@/lib/reward-toast";
import { CONFETTI_COLORS } from "@/components/tutorial/CanvasserTutorial";

/**
 * LEAD CONFIRMED / LEAD SOLD — the payoff moments. Until now the desk
 * verifying a lead produced zero feedback on the knocker's phone (a status
 * pill quietly recolored on the Mission tab they weren't looking at), and a
 * SALE produced nothing at all. Mounted app-wide in AppShell for
 * canvasser-tier + captains; renders nothing.
 *
 * Signal: realtime INSERT on lead_events, branched on `kind`
 * (20261103120000_confirm_sold_fx):
 *   'confirmed' — fire_lead_event_on_confirm (Desk path, 20260718173539) OR
 *     fire_lead_event_on_metrics_confirm (the Monday "Lead Status →
 *     Confirmed" path, which only bumps daily_metrics and previously never
 *     reached this component — field reps never saw the confetti for the
 *     MAIN confirm path).
 *   'sold' — fire_lead_event_on_sold: the sale landed with an amount. The
 *     big gold K.O. moment.
 * Deliberately NOT the leads table: no replica identity means no old-status
 * on UPDATE payloads, and reviewed_at is desk-only.
 *
 * Guards: 5-minute occurred_at fence (backfills/CSV imports) + a
 * sessionStorage seen-ring (realtime reconnect replays). Known accepted
 * gap, same as the hype ticker: benched (team-less) players get no event (the
 * trigger's team_id IS NOT NULL guard).
 *
 * Preview: `?lead_confirm_demo=1` / `?lead_sold_demo=1` fire the visuals
 * once, zero DB traffic (piggy_demo precedent).
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
      description: "The office locked it in — it counts. Next door.",
    });
    // Piggy's two-note ka-ching (best-effort; silent until audio unlocks).
    beepRef.current ??= makeBeeper();
    beepRef.current(1318, 70, 0, "sine");
    beepRef.current(1760, 260, 80, "sine");
  }, []);

  // SOLD — the gold K.O.: double burst, victory fanfare, money toast.
  const celebrateSold = useCallback((amount: number | null) => {
    const gold = ["#ffd700", "#ffb300", "#fff3b0", "#f59e0b"];
    confetti({
      particleCount: 220,
      spread: 90,
      startVelocity: 48,
      origin: { y: 0.6 },
      colors: gold,
      zIndex: 10500,
      disableForReducedMotion: true,
    });
    window.setTimeout(() => {
      confetti({
        particleCount: 120,
        spread: 120,
        startVelocity: 35,
        origin: { y: 0.4 },
        colors: gold,
        zIndex: 10500,
        disableForReducedMotion: true,
      });
    }, 350);
    const money =
      amount && amount > 0 ? `$${Math.round(amount).toLocaleString()} on the board — ` : "";
    rewardToast("💰 K.O.! YOUR LEAD SOLD", {
      description: `${money}commission is coming. FLAWLESS VICTORY.`,
      duration: 8000,
    });
    // Rising victory fanfare — bigger than the confirm ka-ching.
    beepRef.current ??= makeBeeper();
    beepRef.current(880, 90, 0, "square");
    beepRef.current(1174, 90, 100, "square");
    beepRef.current(1568, 120, 200, "square");
    beepRef.current(2093, 320, 330, "sine");
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
          const row = payload.new as {
            id: string;
            occurred_at: string;
            kind?: string | null;
            amount?: number | null;
          };
          if (!row?.id) return;
          if (Date.now() - Date.parse(row.occurred_at) > RECENT_MS) return;
          if (hasSeen(row.id)) return;
          markSeen(row.id);
          if (row.kind === "sold") celebrateSold(row.amount ?? null);
          else celebrate();
        },
      )
      .subscribe();
    return () => {
      void supabase.removeChannel(ch);
    };
  }, [userId, celebrate, celebrateSold]);

  // Demo levers — parsed post-mount (SSR hydration safety, piggy precedent).
  const demoFiredRef = useRef(false);
  useEffect(() => {
    if (demoFiredRef.current) return;
    const params = new URLSearchParams(window.location.search);
    const confirmDemo = params.get("lead_confirm_demo") === "1";
    const soldDemo = params.get("lead_sold_demo") === "1";
    if (!confirmDemo && !soldDemo) return;
    demoFiredRef.current = true;
    const id = window.setTimeout(
      () => (soldDemo ? celebrateSold(12500) : celebrate()),
      800,
    );
    return () => window.clearTimeout(id);
  }, [celebrate, celebrateSold]);

  return null;
}
