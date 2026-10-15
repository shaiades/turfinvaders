// Coaching flag data (Phase 2 §4) — the last-14-day window of
// getDispatchProduction (aggregates only, readable by every authenticated
// user — the same contract the leaderboard rides), shaped through the pure
// math in src/lib/coaching.ts. Also the coaching-note log (RLS does the
// scoping: subject reads their own, captains their van, office everything).

import { useMemo } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import type { SupabaseClient } from "@supabase/supabase-js";
import { supabase } from "@/integrations/supabase/client";
import { getDispatchProduction } from "@/lib/dispatch.functions";
import { addDaysISO, laMidnightUtcISO, laTodayISO } from "@/lib/dates";
import { DOORS_TRACKED_SINCE } from "@/lib/funnel";
import { isLeadSourceName } from "@/lib/lead-sources";
import {
  computeCoachingFlag,
  computeTeamBaseline,
  doorsPerDay,
  talkLeadRate,
  topConverters,
  type CoachingFlag,
  type CoachingStats,
  type ConverterRow,
  type TeamBaseline,
} from "@/lib/coaching";

const rawTable = (name: string) => (supabase as unknown as SupabaseClient).from(name);

export type CoachingReport = {
  flag: CoachingFlag | null;
  stats: (CoachingStats & { talkLead: number; doorsPerDay: number }) | null;
  team: TeamBaseline | null;
  /** Ride-along partner candidates: the window's top 3 converters. */
  partners: ConverterRow[];
  loading: boolean;
};

export function useCoaching(canvasserId: string | undefined): CoachingReport {
  // 14 LA days ending today; doors are only trustworthy from
  // DOORS_TRACKED_SINCE, so the window floor-clamps to it.
  const today = laTodayISO();
  const start14 = addDaysISO(today, -13);
  const start = start14 < DOORS_TRACKED_SINCE ? DOORS_TRACKED_SINCE : start14;

  const prodQ = useQuery({
    enabled: !!canvasserId,
    queryKey: ["coaching", "prod", start, today],
    staleTime: 5 * 60_000,
    queryFn: async () =>
      getDispatchProduction({
        data: {
          log_start: start,
          log_end: today,
          vol_start: laMidnightUtcISO(start),
          vol_end: laMidnightUtcISO(addDaysISO(today, 1)),
        },
      }),
  });

  const namesQ = useQuery({
    enabled: !!canvasserId,
    queryKey: ["coaching", "names"],
    staleTime: 5 * 60_000,
    queryFn: async () => {
      const { data, error } = await supabase.from("profiles").select("id, display_name");
      if (error) throw error;
      return new Map((data ?? []).map((p) => [p.id, p.display_name ?? "Unknown"]));
    },
  });

  return useMemo(() => {
    const prod = prodQ.data;
    if (!canvasserId || !prod) {
      return { flag: null, stats: null, team: null, partners: [], loading: prodQ.isLoading };
    }
    const rows: ConverterRow[] = [];
    for (const [id, r] of Object.entries(prod.results ?? {})) {
      const name = namesQ.data?.get(id) ?? "Unknown";
      if (isLeadSourceName(name)) continue; // channels aren't coachable
      rows.push({
        id,
        name,
        drs: r.drs ?? 0,
        tlk: r.tlk ?? 0,
        ld: r.ld ?? 0,
        activeDays: prod.activeDays?.[id] ?? 0,
      });
    }
    const team = computeTeamBaseline(rows);
    const mine = rows.find((r) => r.id === canvasserId) ?? {
      id: canvasserId,
      name: "",
      drs: 0,
      tlk: 0,
      ld: 0,
      activeDays: 0,
    };
    return {
      flag: computeCoachingFlag(mine, team),
      stats: { ...mine, talkLead: talkLeadRate(mine), doorsPerDay: doorsPerDay(mine) },
      team,
      partners: topConverters(rows, canvasserId),
      loading: false,
    };
  }, [canvasserId, prodQ.data, prodQ.isLoading, namesQ.data]);
}

// ── Coaching notes ───────────────────────────────────────────────────────────

export type CoachingNote = {
  id: string;
  canvasser_id: string;
  author_user_id: string;
  note_text: string;
  created_at: string;
};

export function useCoachingNotes(canvasserId: string | undefined) {
  return useQuery({
    enabled: !!canvasserId,
    queryKey: ["coaching_notes", canvasserId],
    staleTime: 30_000,
    retry: false,
    queryFn: async () => {
      // Fail-open to empty until the migration lands (hand-applied SQL ships
      // after the app build — Dojo precedent).
      const { data, error } = await rawTable("coaching_notes")
        .select("*")
        .eq("canvasser_id", canvasserId!)
        .order("created_at", { ascending: false })
        .limit(50);
      if (error) return [] as CoachingNote[];
      return (data ?? []) as unknown as CoachingNote[];
    },
  });
}

export function useAddCoachingNote(canvasserId: string | undefined) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (vars: { authorId: string; text: string }) => {
      const { error } = await rawTable("coaching_notes").insert({
        canvasser_id: canvasserId,
        author_user_id: vars.authorId,
        note_text: vars.text.trim(),
      });
      if (error) throw error;
    },
    onSuccess: () => qc.invalidateQueries({ queryKey: ["coaching_notes", canvasserId] }),
  });
}
