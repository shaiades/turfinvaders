import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { supabase } from "@/integrations/supabase/client";

/**
 * A sales rep's own commission tracker (rep_commission_notes, 20260917150000)
 * — one row per (deal, rep). This is the rep's OWN estimate, never synced
 * from or validated against Monday.com's Builder Accounts board (rejected as
 * a source: no per-paycheck grouping, numbers shift constantly as bids and
 * finance fees land). RLS scopes every row to its own rep — this hook never
 * reads or writes anyone else's notes.
 */

export type RepCommissionNote = {
  id: string;
  monday_item_id: string;
  estimated_amount: number | null;
  actual_amount: number | null;
  next_payroll: boolean;
  paid_at: string | null;
};

export const repCommissionNotesKey = (repId: string) => ["rep_commission_notes", repId] as const;

export function useRepCommissionNotes(repId: string | undefined) {
  return useQuery({
    enabled: !!repId,
    queryKey: repCommissionNotesKey(repId ?? ""),
    staleTime: 15_000,
    queryFn: async () => {
      const { data, error } = await supabase
        .from("rep_commission_notes")
        .select("id, monday_item_id, estimated_amount, actual_amount, next_payroll, paid_at")
        .eq("rep_id", repId!);
      if (error) throw error;
      return (data ?? []) as RepCommissionNote[];
    },
  });
}

export type CommissionNotePatch = {
  monday_item_id: string;
  estimated_amount?: number | null;
  actual_amount?: number | null;
  next_payroll?: boolean;
  paid_at?: string | null;
};

/** One upsert covers every edit this tab makes: adding/changing an estimate,
 *  toggling "add to next payroll", or marking a deal paid with its exact
 *  payout. onConflict on the (monday_item_id, rep_id) pair the migration's
 *  UNIQUE constraint defines. */
export function useSaveCommissionNote(repId: string | undefined) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (patch: CommissionNotePatch) => {
      if (!repId) throw new Error("Not signed in");
      const { error } = await supabase
        .from("rep_commission_notes")
        .upsert({ ...patch, rep_id: repId }, { onConflict: "monday_item_id,rep_id" });
      if (error) throw error;
    },
    onSuccess: () => {
      if (repId) qc.invalidateQueries({ queryKey: repCommissionNotesKey(repId) });
    },
  });
}
