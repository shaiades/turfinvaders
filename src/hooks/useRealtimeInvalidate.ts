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
    let timer: ReturnType<typeof setTimeout> | null = null;
    const flush = () => {
      timer = null;
      for (const key of keysRef.current) qc.invalidateQueries({ queryKey: key });
    };
    // Live invalidation is a best-effort enhancement on top of the initial
    // fetch — never a load-bearing step. A realtime setup failure (e.g. a
    // duplicate channel name handing back an already-subscribed channel, whose
    // `.on("postgres_changes")` throws "cannot add ... after subscribe()")
    // must NOT escape this effect: an uncaught throw here propagates to the
    // nearest router error boundary and blanks the whole screen to "Connection
    // Lost" (the arcade incident, 2026-10-06). Degrade to no live updates — the
    // data is already on screen and react-query's focus refetch still refreshes
    // it — rather than taking the app down.
    let ch: ReturnType<typeof supabase.channel> | null = null;
    try {
      ch = supabase.channel(channel);
      for (const spec of specs) {
        ch.on(
          "postgres_changes",
          { event: spec.event, schema: "public", table: spec.table },
          () => {
            if (timer !== null) clearTimeout(timer);
            timer = setTimeout(flush, INVALIDATE_DEBOUNCE_MS);
          },
        );
      }
      ch.subscribe();
    } catch (err) {
      console.warn(`useRealtimeInvalidate: live updates disabled for "${channel}"`, err);
      if (ch) {
        try {
          supabase.removeChannel(ch);
        } catch {
          /* ignore */
        }
        ch = null;
      }
    }
    return () => {
      if (timer !== null) clearTimeout(timer);
      if (ch) supabase.removeChannel(ch);
    };
  }, [qc, channel, enabled, tablesKey]);
}
