import { useEffect, useRef } from "react";
import { useQueryClient, type QueryKey } from "@tanstack/react-query";
import { supabase } from "@/integrations/supabase/client";

export type RealtimeEvent = "*" | "INSERT" | "UPDATE" | "DELETE";
export type RealtimeTable = string | { table: string; event?: RealtimeEvent };

/**
 * One supabase channel with a postgres_changes handler per table (schema
 * "public"); any delivered change invalidates every key in `invalidateKeys`.
 * Cleans up via removeChannel; no-ops while `enabled` is false. Keys are read
 * through a ref so changing them retargets the invalidation without tearing
 * down the socket. Keep channel names unique per mounted consumer — two
 * co-mounted subscribers to the same table must not share a name.
 *
 * Invalidations are TRAILING-DEBOUNCED (2026-09-02): a full-history sync
 * upserts ~1,400 block_cards rows, and invalidating per event made the open
 * Close Kombat page cancel-and-refire its 2-3-page fetch continuously for
 * minutes — the cancelled pages kept running (see the abortSignal note in
 * CloseKombat.tsx) and ~1,000 zombie requests briefly saturated prod REST.
 * One flush per quiet burst is enough: live edits land within a second, and
 * a long write storm resolves to a single refetch when it ends.
 */
const INVALIDATE_DEBOUNCE_MS = 1000;
export function useRealtimeInvalidate({
  channel,
  tables,
  invalidateKeys,
  enabled = true,
}: {
  channel: string;
  tables: readonly RealtimeTable[];
  invalidateKeys: readonly QueryKey[];
  enabled?: boolean;
}): void {
  const qc = useQueryClient();
  const keysRef = useRef(invalidateKeys);
  keysRef.current = invalidateKeys;

  const tablesKey = JSON.stringify(
    tables.map((t) =>
      typeof t === "string" ? { table: t, event: "*" } : { table: t.table, event: t.event ?? "*" },
    ),
  );

  useEffect(() => {
    if (!enabled) return;
    const specs = JSON.parse(tablesKey) as Array<{ table: string; event: RealtimeEvent }>;
    const ch = supabase.channel(channel);
    let timer: ReturnType<typeof setTimeout> | null = null;
    const flush = () => {
      timer = null;
      for (const key of keysRef.current) qc.invalidateQueries({ queryKey: key });
    };
    for (const spec of specs) {
      ch.on("postgres_changes", { event: spec.event, schema: "public", table: spec.table }, () => {
        if (timer !== null) clearTimeout(timer);
        timer = setTimeout(flush, INVALIDATE_DEBOUNCE_MS);
      });
    }
    ch.subscribe();
    return () => {
      if (timer !== null) clearTimeout(timer);
      supabase.removeChannel(ch);
    };
  }, [qc, channel, enabled, tablesKey]);
}
