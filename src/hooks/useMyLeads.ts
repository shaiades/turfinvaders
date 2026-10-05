import { useQuery } from "@tanstack/react-query";
import { supabase } from "@/integrations/supabase/client";

/**
 * Today's block leads for the rep "My Leads" screen. A SCOPED query with its
 * own key (never the shared ["block_cards", …] key — that one's select list is
 * byte-locked and omits address/phone). Reads the columns a rep needs to run
 * and report an appointment. 0 rows on any error (table/feature not ready).
 */
export type MyLeadCard = {
  monday_item_id: string;
  board_id: string;
  lead_name: string | null;
  address: string | null;
  phone: string | null;
  reps: string[];
  iss: string | null;
  office_location: string | null;
  card_date: string | null;
  products: string | null;
  sale: string | null;
  pm: string | null;
  rs: string | null;
  ol: string | null;
  bo: string | null;
  source: string | null;
};

const COLS =
  "monday_item_id, board_id, lead_name, address, phone, reps, iss, office_location, card_date, products, sale, pm, rs, ol, bo, source";

export function useMyLeads(dateISO: string, enabled = true) {
  return useQuery({
    queryKey: ["my_leads", dateISO],
    enabled: enabled && !!dateISO,
    refetchInterval: 60_000,
    queryFn: async () => {
      const { data, error } = await supabase
        .from("block_cards")
        .select(COLS)
        .eq("card_date", dateISO)
        .limit(500);
      if (error) return [] as MyLeadCard[];
      return (data ?? []) as MyLeadCard[];
    },
  });
}
