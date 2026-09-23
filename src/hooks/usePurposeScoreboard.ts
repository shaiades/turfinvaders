// Purpose Home's "My Current Scoreboard" — the SAME numbers Close Kombat's
// Goals tab computes, lifted into a hook so the two surfaces can never
// disagree. Same query key + ±42d pad as the Goals tab, so when the rep has
// opened Close Kombat this session the block_cards fetch is served warm from
// the react-query cache. Real split volume only — no projections, no
// commission math, ever (owner rule; the spec repeats it).

import { useMemo } from "react";
import { useQuery } from "@tanstack/react-query";
import { supabase } from "@/integrations/supabase/client";
import {
  aggregateCloseKombat,
  countReps,
  volumeReps,
  type BlockCard,
  type RepStats,
} from "@/lib/close-kombat";
import { buildRepMatcher } from "@/lib/rep-identity";
import { addDaysISO } from "@/lib/dates";
import { useWeekSelector } from "@/hooks/useWeekSelector";

// Mirrors CloseKombat.tsx (goals fetch): pad for save-linking context.
const SAVE_LINK_PAD_DAYS = 42;
const CARD_COLUMNS =
  "monday_item_id, board_id, office_location, card_date, group_title, lead_name, reps, " +
  "iss, bo, ol, rs, pm, sale, sale_price, products, canvass_stats, wcc, comments, phone, " +
  "report_reps";

export type PurposeScoreboard = {
  loading: boolean;
  /** null = the matcher couldn't safely find this person on the boards →
   *  render the spec's "no CRM data" state, never zeros pretending. */
  week: RepStats | null;
  trailing: RepStats | null;
  matched: boolean;
  weekStartISO: string;
  weekEndISO: string;
};

export function usePurposeScoreboard(displayName: string | null, enabled: boolean): PurposeScoreboard {
  const week = useWeekSelector({ endOffsetDays: 6 });
  const fetchStart = addDaysISO(week.weekStartISO, -SAVE_LINK_PAD_DAYS);
  const fetchEnd = addDaysISO(week.weekEndISO, SAVE_LINK_PAD_DAYS);

  const cardsQuery = useQuery({
    // Deliberately identical key to Close Kombat's goals fetch — shared cache.
    queryKey: ["block_cards", fetchStart, fetchEnd],
    enabled: enabled && !!displayName,
    staleTime: 15_000,
    queryFn: async ({ signal }) => {
      const PAGE = 1000;
      const all: BlockCard[] = [];
      for (let from = 0; ; from += PAGE) {
        const { data, error } = await supabase
          .from("block_cards")
          .select(CARD_COLUMNS)
          .gte("card_date", fetchStart)
          .lte("card_date", fetchEnd)
          .order("monday_item_id")
          .range(from, from + PAGE - 1)
          .abortSignal(signal);
        if (error) throw error;
        all.push(...((data ?? []) as unknown as BlockCard[]));
        if (!data || data.length < PAGE) break;
      }
      return all;
    },
  });

  const cards = cardsQuery.data;

  // Own matcher over the full unfiltered fetch pool (never a page-level
  // matcher built from someone else's range — the 2026-09-22 review rule).
  const matcher = useMemo(() => {
    const names = new Set<string>();
    for (const c of cards ?? []) {
      for (const n of countReps(c)) names.add(n);
      for (const n of volumeReps(c)) names.add(n);
    }
    return buildRepMatcher(displayName ?? "", [...names]);
  }, [displayName, cards]);

  const weekRow = useMemo(() => {
    if (!matcher.matched) return null;
    const { reps } = aggregateCloseKombat(cards ?? [], {
      start: week.weekStartISO,
      end: week.weekEndISO,
    });
    return reps.find((r) => matcher.isMe(r.rep)) ?? null;
  }, [matcher, cards, week.weekStartISO, week.weekEndISO]);

  const trailingStart = addDaysISO(week.weekStartISO, -14);
  const trailingEnd = addDaysISO(week.weekStartISO, -1);
  const trailingRow = useMemo(() => {
    if (!matcher.matched) return null;
    const { reps } = aggregateCloseKombat(cards ?? [], { start: trailingStart, end: trailingEnd });
    return reps.find((r) => matcher.isMe(r.rep)) ?? null;
  }, [matcher, cards, trailingStart, trailingEnd]);

  return {
    loading: enabled && cardsQuery.isLoading,
    week: weekRow,
    trailing: trailingRow,
    matched: !!matcher.matched,
    weekStartISO: week.weekStartISO,
    weekEndISO: week.weekEndISO,
  };
}
