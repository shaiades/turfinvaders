// Everything the Daily Wrap cinematic (and the end-of-day moments inside it)
// needs for ONE canvasser, for Today / Week / Month — assembled from the same
// trusted sources as the rest of the arcade: useArcadeLadder (ranked totals +
// funnel sit rate), useBossMeter (monthly $100K truth), useWallet (real loot),
// and the canvasser's own logs/profile for the streak, Hat Trick and rank.
// Read-only; no writes. Figures that have no exact source (an isolated "today
// take-home") are clearly projections in the UI, never presented as paid.

import { useMemo } from "react";
import { useQuery } from "@tanstack/react-query";
import { getDispatchProduction } from "@/lib/dispatch.functions";
import { addDaysISO, laMidnightUtcISO, laTodayISO } from "@/lib/dates";
import { useAuth } from "@/hooks/useAuth";
import {
  useArcadeLadder,
  useBossMeter,
  useWallet,
  type RangeKey,
} from "@/hooks/useCanvasserArcade";
import { useSixtyDayLogs, useTodayLogs, sumLogCounters } from "@/hooks/useDailyLogs";
import { useCanvasserProfile } from "@/hooks/useCanvasserProfile";
import { useRepCartoons, cartoonFor, type RepCartoon } from "@/hooks/useRepCartoons";
import {
  evaluateBadges,
  levelForXp,
  xpFor,
  BADGES,
  type BadgeDef,
  type BadgeId,
  type BossState,
  type LevelState,
  type LootLine,
  type SitRate,
} from "@/lib/canvasserPay";

export type WrapScope = "day" | "week" | "month";

/** Longest run of recent days (Sundays bridged) with at least one sit. */
function sitStreak(rows: readonly { log_date: string; demos_sits?: number | null }[]): number {
  const sitDays = new Set(rows.filter((r) => (r.demos_sits ?? 0) > 0).map((r) => r.log_date));
  let streak = 0;
  let d = laTodayISO();
  // Allow today to not have a sit yet without breaking a prior streak.
  if (!sitDays.has(d)) d = addDaysISO(d, -1);
  for (let i = 0; i < 90; i++) {
    const isSunday = new Date(`${d}T00:00:00Z`).getUTCDay() === 0;
    if (isSunday) {
      d = addDaysISO(d, -1);
      continue;
    }
    if (sitDays.has(d)) {
      streak++;
      d = addDaysISO(d, -1);
    } else break;
  }
  return streak;
}

export type WrapData = {
  scope: WrapScope;
  name: string;
  cartoon: RepCartoon | undefined;
  rank: number | null;
  /** Rank the viewer first saw today (localStorage); null if never captured. */
  morningRank: number | null;
  boardSize: number;
  ahead: { name: string; gapVol: number; gapPts: number } | null;
  leads: number;
  sits: number;
  sitRate: SitRate;
  sales: number;
  vol: number;
  /** Today's credited volume — the hit the boss takes on the "damage" card. */
  todayVol: number;
  pts: number;
  boss: BossState;
  loot: LootLine[];
  earned: number;
  streak: number;
  level: LevelState;
  xpEarned: number;
  badges: { def: BadgeDef; unlocked: boolean }[];
  vanMvp: boolean;
  loading: boolean;
};

const MORNING_RANK_KEY = (uid: string) => `ti_morning_rank_v1:${uid}:${laTodayISO()}`;

export function useWrapData(scope: WrapScope): WrapData {
  const { user } = useAuth();
  const uid = user?.id ?? "";
  const range: RangeKey = scope;
  const ladder = useArcadeLadder(range);
  const week = useArcadeLadder("week"); // for weekSales + Van MVP (week-scoped badges)
  const boss = useBossMeter(uid);
  const wallet = useWallet(uid, scope === "month" ? "month" : "week");
  const sixtyQ = useSixtyDayLogs(uid);
  const todayQ = useTodayLogs(uid);
  const profile = useCanvasserProfile(uid);
  const cartoons = useRepCartoons().data;

  // Today's credited volume for the boss-damage card (its own light query so
  // we don't stack a second realtime channel on useArcadeLadder).
  const today = laTodayISO();
  const todayProdQ = useQuery({
    enabled: !!uid,
    queryKey: ["wrap_today_vol", uid, today],
    queryFn: async () =>
      getDispatchProduction({
        data: {
          log_start: today,
          log_end: today,
          vol_start: laMidnightUtcISO(today),
          vol_end: laMidnightUtcISO(addDaysISO(today, 1)),
        },
      }),
  });

  return useMemo<WrapData>(() => {
    const self = ladder.self;
    const row = self?.row;
    const todaySits = sumLogCounters(todayQ.data).demos_sits;
    const sits = row?.sit.sits ?? 0;
    const vol = row?.vol ?? 0;
    const sales = row?.sal ?? 0;
    const leads = row?.lds ?? 0;
    const pts = row?.pts ?? 0;
    const sitRate = row?.sit ?? { sits: 0, leads: 0, rate: null, grade: null };

    // Van MVP: top of their own van this week.
    const myTeam = week.self?.row.teamId ?? row?.teamId ?? null;
    const vanMvp =
      !!myTeam && week.rows.filter((r) => r.teamId === myTeam).findIndex((r) => r.id === uid) === 0;

    const weekSales = week.self?.row.sal ?? 0;
    const streak = sitStreak(sixtyQ.data ?? []);
    const badgeStats = {
      weekSales,
      bestDaySits: todaySits, // today's sits (Hat Trick fires same-day)
      sitRate: sitRate.rate ?? 0,
      sitRateLeads: sitRate.leads,
      bossesDefeated: boss.boss.bossesDefeated,
      sitStreakDays: streak,
      vanMvp,
    };
    const unlocked = evaluateBadges(badgeStats);

    // XP flavor for this scope (cosmetic; never pay). A $100K boss is huge.
    const xpEarned = xpFor({
      appts: leads,
      sits,
      solds: sales,
      bossesDefeated: scope === "month" ? boss.boss.bossesDefeated : 0,
    });

    let morningRank: number | null = null;
    try {
      const raw = localStorage.getItem(MORNING_RANK_KEY(uid));
      morningRank = raw != null ? Number(raw) : null;
    } catch {
      /* private mode */
    }

    return {
      scope,
      name: row?.name ?? profile.data?.display_name ?? "You",
      cartoon: cartoonFor(cartoons, row?.name ?? profile.data?.display_name ?? ""),
      rank: self?.rank ?? null,
      morningRank: Number.isFinite(morningRank) ? morningRank : null,
      boardSize: ladder.rows.length,
      ahead: self?.ahead
        ? { name: self.ahead.name, gapVol: self.gapVol, gapPts: self.gapPts }
        : null,
      leads,
      sits,
      sitRate,
      sales,
      vol,
      todayVol: todayProdQ.data?.volume?.[uid] ?? 0,
      pts,
      boss: boss.boss,
      loot: wallet.lines,
      earned: scope === "month" ? wallet.monthTotal : wallet.weekTotal,
      streak,
      level: levelForXp(xpEarned),
      xpEarned,
      badges: BADGES.map((def) => ({ def, unlocked: unlocked.has(def.id) })),
      vanMvp,
      loading:
        ladder.loading || boss.loading || wallet.loading || sixtyQ.isLoading || todayQ.isLoading,
    };
  }, [
    scope,
    uid,
    ladder.self,
    ladder.rows.length,
    ladder.loading,
    week.self,
    week.rows,
    boss.boss,
    boss.loading,
    wallet.lines,
    wallet.weekTotal,
    wallet.monthTotal,
    wallet.loading,
    sixtyQ.data,
    sixtyQ.isLoading,
    todayQ.data,
    todayQ.isLoading,
    todayProdQ.data,
    profile.data,
    cartoons,
  ]);
}

/** Record the viewer's current day rank as their "morning" rank, once per LA
 *  day — so the Wrap's rank-climb card can start from where they woke up.
 *  Call from a surface that loads the day ladder (e.g. the leaderboard). */
export function captureMorningRank(uid: string, rank: number) {
  if (!uid || !Number.isFinite(rank)) return;
  try {
    const key = MORNING_RANK_KEY(uid);
    if (localStorage.getItem(key) == null) localStorage.setItem(key, String(rank));
  } catch {
    /* private mode — skip */
  }
}

export type { BossState, LevelState, LootLine, SitRate, BadgeDef, BadgeId };
