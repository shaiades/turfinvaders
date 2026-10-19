import { useMemo, useRef } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { supabase } from "@/integrations/supabase/client";
import { laTodayISO } from "@/lib/dates";
import { dailyLogKeys, sumLogCounters, useTodayLogs } from "@/hooks/useDailyLogs";
import { CALL_TALK_TYPES, CALL_TOASTS, type CallDisposition } from "@/lib/dialer";
import { expectedValuePerDoor, resolveAvgCommission } from "@/lib/funnel";
import { DEFAULT_AVG_COMMISSION, DEFAULT_WEEKLY_GOAL } from "@/hooks/useCanvasserStats";
import { useCanvasserProfile } from "@/hooks/useCanvasserProfile";
import { useFunnelRates } from "@/hooks/useFunnelRates";
import { useMyEarnings } from "@/hooks/useMyEarnings";
import { toast } from "sonner";
import { rewardToast } from "@/lib/reward-toast";

/**
 * The phone-room call engine — useFieldPins' no-GPS twin for Dial Run. One
 * call_logs row per dial; the bump_daily_log_from_call trigger (migration
 * 20261101120000) owns all counter math, so nothing in this file decides
 * what counts. Three verbs:
 *  - logCall: insert a row (a bare 'knock' dial, or a complete one-tap
 *    outcome). Optimistic; haptic rides with the caller.
 *  - tagCall: same-day disposition correction on an existing row — the
 *    armed-result pattern: DIAL drops a bare dial, the outcome chip upgrades
 *    it in place (RLS fence 20261101120000 backs the same-day rule).
 *  - undoLast: delete the newest row; the trigger decrements.
 */

export type CallRow = {
  id: string;
  disposition: CallDisposition;
  created_at: string;
  pending?: boolean;
};

// One key per LA day, like myPinsTodayKey: after midnight a still-open tab
// rolls to a fresh list instead of editing yesterday's calls.
export const myCallsTodayKey = (userId: string | undefined, todayISO: string) =>
  ["call_logs", userId, todayISO] as const;

export function useMyCallsToday(userId: string | undefined) {
  const todayISO = laTodayISO();
  const callsKey = useMemo(() => myCallsTodayKey(userId, todayISO), [userId, todayISO]);
  const query = useQuery({
    enabled: !!userId,
    queryKey: callsKey,
    queryFn: async () => {
      const { data, error } = await supabase
        .from("call_logs")
        .select("id, disposition, created_at")
        .eq("canvasser_id", userId!)
        .eq("log_date", laTodayISO())
        .order("created_at", { ascending: true });
      if (error) throw error;
      return (data ?? []) as CallRow[];
    },
    // Own taps land optimistically in this exact cache entry; staleness only
    // matters for cross-device edits.
    staleTime: 60_000,
    gcTime: 30 * 60_000,
  });
  return { query, callsKey };
}

export function useCallLogs(userId: string | undefined) {
  const qc = useQueryClient();
  const { query: callsQuery, callsKey } = useMyCallsToday(userId);

  const counts = useMemo(() => {
    const byType: Partial<Record<CallDisposition, number>> = {};
    for (const c of callsQuery.data ?? []) byType[c.disposition] = (byType[c.disposition] ?? 0) + 1;
    return byType;
  }, [callsQuery.data]);

  /** Newest row of the session, optimistic rows included — the one an
   *  outcome chip upgrades. */
  const lastCall = useMemo(() => {
    const rows = callsQuery.data ?? [];
    return rows.length ? rows[rows.length - 1] : undefined;
  }, [callsQuery.data]);

  // Mystery drops (Phase 4 §4, phone edition): the SERVER rolled the dice in
  // the call trigger — after a conversation lands, peek for a fresh prize and
  // celebrate it once. Fail-soft; the call never waits.
  const celebratedDropsRef = useRef<Set<string>>(new Set());
  const checkMysteryDrop = async () => {
    if (!userId) return;
    try {
      const { data } = await supabase
        .from("arcade_drops")
        .select("id, points")
        .eq("canvasser_id", userId)
        .gte("created_at", new Date(Date.now() - 30_000).toISOString())
        .order("created_at", { ascending: false })
        .limit(1);
      const row = (data ?? [])[0] as { id: string; points: number } | undefined;
      if (!row || celebratedDropsRef.current.has(row.id)) return;
      celebratedDropsRef.current.add(row.id);
      rewardToast("🎁 MYSTERY DROP — +1 arcade point!");
    } catch {
      /* the prize layer must never break the call */
    }
  };

  // ONE scope for all three verbs: react-query serializes same-scope
  // mutations, so a DIAL's insert always commits before the chip's tag or an
  // undo's delete reaches the server — which is what lets the optimistic row
  // carry its REAL id (caller-generated, pin-queue precedent) and be targeted
  // while the insert is still in flight.
  const CALL_SCOPE = { id: "call-engine" } as const;

  const logCall = useMutation({
    mutationFn: async ({ id, disposition }: { id: string; disposition: CallDisposition }) => {
      const row = {
        id,
        canvasser_id: userId!,
        disposition,
        log_date: laTodayISO(),
      };
      const { error } = await supabase.from("call_logs").insert(row as never);
      if (error) throw error;
      return { disposition };
    },
    // Rapid taps queue in order instead of dropping (dropAtPoint precedent).
    scope: CALL_SCOPE,
    onMutate: async ({ id, disposition }) => {
      try {
        navigator.vibrate?.(15);
      } catch {
        /* ignore */
      }
      await qc.cancelQueries({ queryKey: callsKey });
      qc.setQueryData<CallRow[]>(callsKey, (prev) => [
        ...(prev ?? []),
        {
          id,
          disposition,
          created_at: new Date().toISOString(),
          pending: true,
        },
      ]);
    },
    onSuccess: ({ disposition }) => {
      const msg = CALL_TOASTS[disposition];
      if (msg) toast.success(msg);
      if (CALL_TALK_TYPES.has(disposition)) void checkMysteryDrop();
      // bump_daily_log_from_call has committed by now — refresh every
      // self-scoped daily_logs read (Stats, HUD, tallies, piggy).
      if (userId) qc.invalidateQueries({ queryKey: dailyLogKeys.all(userId) });
    },
    onError: (e: Error) => toast.error(e.message),
    onSettled: () => qc.invalidateQueries({ queryKey: callsKey }),
  });

  // Same-day correction: upgrade a bare dial to its outcome (or fix a
  // mis-tap). The trigger moves the daily_logs deltas.
  const tagCall = useMutation({
    mutationFn: async ({ id, disposition }: { id: string; disposition: CallDisposition }) => {
      const { error } = await supabase
        .from("call_logs")
        .update({ disposition })
        .eq("id", id)
        .eq("log_date", laTodayISO());
      if (error) throw error;
      return { disposition };
    },
    scope: CALL_SCOPE,
    onMutate: async ({ id, disposition }) => {
      try {
        navigator.vibrate?.(15);
      } catch {
        /* ignore */
      }
      await qc.cancelQueries({ queryKey: callsKey });
      qc.setQueryData<CallRow[]>(callsKey, (prev) =>
        (prev ?? []).map((c) => (c.id === id ? { ...c, disposition } : c)),
      );
    },
    onSuccess: ({ disposition }) => {
      const msg = CALL_TOASTS[disposition];
      if (msg) toast.success(msg);
      if (CALL_TALK_TYPES.has(disposition)) void checkMysteryDrop();
      if (userId) qc.invalidateQueries({ queryKey: dailyLogKeys.all(userId) });
    },
    onError: (e: Error) => toast.error(e.message),
    onSettled: () => qc.invalidateQueries({ queryKey: callsKey }),
  });

  const undoLast = useMutation({
    mutationFn: async (id: string) => {
      const { error } = await supabase
        .from("call_logs")
        .delete()
        .eq("id", id)
        .eq("log_date", laTodayISO());
      if (error) throw error;
    },
    scope: CALL_SCOPE,
    onMutate: async (id) => {
      await qc.cancelQueries({ queryKey: callsKey });
      qc.setQueryData<CallRow[]>(callsKey, (prev) => (prev ?? []).filter((c) => c.id !== id));
    },
    onSuccess: () => {
      toast.success("Last call undone — stats adjusted");
      if (userId) qc.invalidateQueries({ queryKey: dailyLogKeys.all(userId) });
    },
    onError: (e: Error) => toast.error(e.message),
    onSettled: () => qc.invalidateQueries({ queryKey: callsKey }),
  });

  return { callsKey, callsQuery, counts, lastCall, logCall, tagCall, undoLast };
}

/**
 * usePiggyBank's phone twin: PROJECTED dollars banked today — dials × the
 * expected commission value of one dial. Identical latch/pace semantics; the
 * only swap is the instant counter source (today's call rows instead of
 * pins). Projected only, never payroll.
 */
export type PhonePiggy = {
  /** max(server doors_knocked, today's call rows incl. optimistic). */
  dials: number;
  perDial: number | null;
  dollars: number | null;
  /** Dials still needed THIS WEEK to close the income-goal gap. */
  paceDials: number | null;
  source: "personal" | "company";
  weeklyGoal: number;
  weekEarned: number;
  isLoading: boolean;
};

export function usePhonePiggy(userId: string | undefined): PhonePiggy {
  const { query: callsQuery } = useMyCallsToday(userId);
  const todayLogs = useTodayLogs(userId);
  const profile = useCanvasserProfile(userId);
  const funnel = useFunnelRates(userId ?? "");

  const callRows = (callsQuery.data ?? []).length;
  const serverDoors = sumLogCounters(todayLogs.data).doors_knocked;
  const dials = Math.max(callRows, serverDoors);

  const perDial = expectedValuePerDoor(
    funnel.rates,
    resolveAvgCommission(
      profile.data?.avg_commission,
      funnel.companyAvgCommission,
      DEFAULT_AVG_COMMISSION,
    ),
  );

  // Latch between dials (usePiggyBank's rule): the bank total only moves when
  // the dial count moves, so rate churn never visibly shrinks the bank.
  const day = laTodayISO();
  const latch = useRef<{ day: string; dials: number; dollars: number | null }>({
    day: "",
    dials: -1,
    dollars: null,
  });
  if (
    latch.current.day !== day ||
    latch.current.dials !== dials ||
    (latch.current.dollars === null && perDial !== null)
  ) {
    latch.current = {
      day,
      dials,
      dollars: perDial === null ? null : dials * perDial,
    };
  }

  const earnings = useMyEarnings(userId ?? "");
  const weeklyGoal = Number(profile.data?.weekly_income_goal ?? 0) || DEFAULT_WEEKLY_GOAL;
  const weekEarned = earnings.weekEarned;
  const paceDials =
    perDial !== null && perDial > 0 && !earnings.isLoading
      ? Math.max(0, Math.ceil(Math.max(0, weeklyGoal - weekEarned) / perDial))
      : null;

  return {
    dials,
    perDial,
    dollars: latch.current.dollars,
    paceDials,
    source: funnel.source,
    weeklyGoal,
    weekEarned,
    isLoading: funnel.isLoading || (callsQuery.isLoading && todayLogs.isLoading),
  };
}
