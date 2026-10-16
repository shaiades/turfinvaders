// The two Active Run money chips (Phase 4 §2–3):
//   NextDollarChip (top-right) — the ONE nearest real-money threshold with a
//     progress ring ("2 pts → $30/hr", "1 sit → +$50", "$8K → $1,500"),
//     gold + shake when one away. Pay-TRUE inputs: Mon–Sun daily_logs points
//     (the HUD's axis) + calc_monthly_paycheck volume — never ladder points.
//   RankChip (top-left) — "#4 TODAY ▲1", movement since the rep last looked,
//     one tap into the standings sheet. Rides useArcadeLadder("day")'s cache
//     (shared with the leaderboard — no extra polling channel).

import { useEffect, useMemo } from "react";
import { addDaysISO, laTodayISO, laWeekStartISO } from "@/lib/dates";
import { useSixtyDayLogs, sumLogCounters } from "@/hooks/useDailyLogs";
import { useCanvasserProfile } from "@/hooks/useCanvasserProfile";
import { useMyEarnings } from "@/hooks/useMyEarnings";
import { useArcadeLadder } from "@/hooks/useCanvasserArcade";
import { captureMorningRank } from "@/hooks/useWrapData";
import { nextMoneyTarget } from "@/lib/money-thresholds";
import { usePrefersReducedMotion } from "@/hooks/usePrefersReducedMotion";

function Ring({ progress, gold }: { progress: number; gold: boolean }) {
  const R = 9;
  const C = 2 * Math.PI * R;
  return (
    <svg width="24" height="24" viewBox="0 0 24 24" aria-hidden className="shrink-0 -rotate-90">
      <circle cx="12" cy="12" r={R} fill="none" stroke="var(--border)" strokeWidth="3" />
      <circle
        cx="12"
        cy="12"
        r={R}
        fill="none"
        stroke={gold ? "var(--kombat-gold)" : "var(--victory)"}
        strokeWidth="3"
        strokeLinecap="round"
        strokeDasharray={`${C * Math.max(0.02, Math.min(1, progress))} ${C}`}
      />
    </svg>
  );
}

/** Top-right: the nearest dollar on the table. */
export function NextDollarChip({ userId }: { userId: string | undefined }) {
  const reduced = usePrefersReducedMotion();
  const logs = useSixtyDayLogs(userId ?? "");
  const profile = useCanvasserProfile(userId);
  const earnings = useMyEarnings(userId ?? "");

  const target = useMemo(() => {
    if (!userId || !logs.data) return null;
    // Mon–SUN pay week, HUD parity (calc_weekly_paycheck v6+ pays Sundays).
    const wkStart = laWeekStartISO();
    const wkEnd = addDaysISO(wkStart, 6);
    const wk = sumLogCounters(
      (logs.data ?? []).filter((r) => r.log_date >= wkStart && r.log_date <= wkEnd),
    );
    // Reverted pay lock ⇒ the rank's rate lock is off (HUD precedent).
    const rank =
      profile.data?.pay_lock_status === "reverted" ? null : (profile.data?.current_rank ?? null);
    return nextMoneyTarget({
      weekPts: wk.demos_sits + wk.sales,
      weekSits: wk.demos_sits,
      monthVolume:
        earnings.monthPaycheck?.sale_price_total != null
          ? Number(earnings.monthPaycheck.sale_price_total)
          : null,
      rank,
    });
  }, [userId, logs.data, profile.data, earnings.monthPaycheck]);

  if (!target) return null;
  return (
    <div
      data-tour="field-next-dollar"
      aria-label={`Next money: ${target.needLabel} to ${target.prizeLabel}`}
      className={`absolute top-3 right-3 z-[1000] flex items-center gap-1.5 rounded-full border bg-surface/90 px-2.5 py-1.5 backdrop-blur ${
        target.oneAway
          ? `border-[var(--kombat-gold)] text-[var(--kombat-gold)] ${reduced ? "" : "money-shake"}`
          : "border-victory/50 text-victory"
      }`}
    >
      <Ring progress={target.progress} gold={target.oneAway} />
      <span className="whitespace-nowrap text-xs font-bold uppercase tabular-nums">
        {target.needLabel} → {target.prizeLabel}
      </span>
    </div>
  );
}

const seenRankKey = (uid: string) => `ti_seen_rank_v1:${uid}:${laTodayISO()}`;

/** Top-left: live Today rank + movement since the rep last looked. */
export function RankChip({ userId, onOpen }: { userId: string | undefined; onOpen: () => void }) {
  const { self } = useArcadeLadder("day");

  // Movement vs the LAST SEEN rank (per LA day) — and seed the Wrap's
  // morning-rank while we're at it, so the nightly climb story works even if
  // the rep never opens the leaderboard page.
  const delta = useMemo(() => {
    if (!userId || !self) return 0;
    try {
      const prev = Number(localStorage.getItem(seenRankKey(userId)) ?? "");
      return Number.isFinite(prev) && prev > 0 ? prev - self.rank : 0;
    } catch {
      return 0;
    }
  }, [userId, self]);
  useEffect(() => {
    if (!userId || !self) return;
    captureMorningRank(userId, self.rank);
    try {
      localStorage.setItem(seenRankKey(userId), String(self.rank));
    } catch {
      /* private mode */
    }
  }, [userId, self]);

  if (!self) return null;
  return (
    <button
      type="button"
      data-tour="field-rank"
      aria-label={`You're #${self.rank} on Today — open standings`}
      onClick={onOpen}
      className="absolute top-3 left-3 z-[1000] flex min-h-11 items-center gap-1.5 rounded-full border border-neon/60 bg-surface/90 px-3 backdrop-blur text-xs font-bold uppercase text-neon"
    >
      #{self.rank} today
      {delta !== 0 && (
        <span className={delta > 0 ? "text-victory" : "text-destructive"}>
          {delta > 0 ? `▲${delta}` : `▼${-delta}`}
        </span>
      )}
    </button>
  );
}
